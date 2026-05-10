/**
 * KEEP IN SYNC: apps/web/src/lib/maintenanceBypassToken.ts
 * Signed maintenance bypass token (crypto.subtle for parity with Edge).
 */

import { timingSafeEqual } from "crypto";

export const MAINTENANCE_BYPASS_HEADER = "X-Dustswap-Maintenance-Bypass";

const DEFAULT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function toUint8Array(bytes: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

/** Match Edge implementation (btoa + RFC4648 URL-safe, no padding). */
function base64urlEncode(bytes: ArrayBuffer | ArrayBufferView): string {
  const u8 = toUint8Array(bytes);
  const b64 = Buffer.from(u8).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeToBytes(s: string): Uint8Array | null {
  try {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const bin = Buffer.from(b64, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function maintenanceBypassConfigured(secret: string | undefined): boolean {
  return Boolean(secret?.trim());
}

export async function createMaintenanceBypassToken(
  secret: string,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS
): Promise<string> {
  const exp = Date.now() + ttlMs;
  const payloadSegment = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ exp }))
  );
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payloadSegment));
  const sigSegment = base64urlEncode(sigBuf);
  return `${payloadSegment}.${sigSegment}`;
}

export type MaintenanceBypassVerifyResult =
  | { ok: true; exp: number }
  | { ok: false };

export async function verifyMaintenanceBypassToken(
  token: string | undefined | null,
  secret: string | undefined
): Promise<MaintenanceBypassVerifyResult> {
  if (!token?.trim() || !secret?.trim()) return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false };
  const [payloadSegment, sigSegment] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sigBytes = base64urlDecodeToBytes(sigSegment);
  if (!sigBytes) return { ok: false };
  const okSig = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(sigBytes),
    enc.encode(payloadSegment)
  );
  if (!okSig) return { ok: false };
  const payloadBytes = base64urlDecodeToBytes(payloadSegment);
  if (!payloadBytes) return { ok: false };
  let parsed: { exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(payloadBytes).toString("utf8")) as { exp?: number };
  } catch {
    return { ok: false };
  }
  if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return { ok: false };
  return { ok: true, exp: parsed.exp };
}

/** Constant-time string compare for passwords */
export function timingSafeEqualPassword(a: string | undefined, b: string | undefined): boolean {
  const left = Buffer.from(a ?? "", "utf8");
  const right = Buffer.from(b ?? "", "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
