/**
 * KEEP IN SYNC: apps/api/src/utils/maintenanceBypassToken.ts
 * Signed maintenance bypass token (Edge-safe via crypto.subtle).
 */

export const MAINTENANCE_BYPASS_COOKIE_NAME = "ds_maint_bypass";
export const MAINTENANCE_BYPASS_HEADER = "X-Dustswap-Maintenance-Bypass";
/** Client storage key for cross-origin API calls */
export const MAINTENANCE_BYPASS_SESSION_KEY = "ds_maint_api_token";

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

function base64urlEncode(bytes: ArrayBuffer | ArrayBufferView): string {
  const u8 = toUint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeToBytes(s: string): Uint8Array | null {
  try {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const bin = atob(b64);
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
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as { exp?: number };
  } catch {
    return { ok: false };
  }
  if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return { ok: false };
  return { ok: true, exp: parsed.exp };
}

export async function timingSafeEqualPassword(
  a: string | undefined,
  b: string | undefined
): Promise<boolean> {
  const enc = new TextEncoder();
  const left = enc.encode(a ?? "");
  const right = enc.encode(b ?? "");
  if (left.length !== right.length) {
    await crypto.subtle.digest("SHA-256", enc.encode("x"));
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
