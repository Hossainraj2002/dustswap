import { Hono } from "hono";
import { createHash } from "crypto";
import { getAddress } from "viem";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { isAllowedAppDomain } from "../config/appOrigins";
import { runtimeCache } from "../utils/runtimeCache";
import { createBaseVerificationClient } from "../utils/baseRpc";
import { issueSessionToken } from "../utils/sessionToken";

const authRoutes = new Hono();

const SIWE_NONCE_TTL_MS = 5 * 60 * 1000;
const SIWE_NONCE_RECENT_TTL_MS = 2_000;
const SIWE_VERIFY_RECENT_TTL_MS = 15_000;
const AUTH_BURST_WINDOW_MS = 10_000;
const AUTH_NONCE_BURST_LIMIT = 6;
const AUTH_VERIFY_BURST_LIMIT = 10;
const pendingNonces = new Map<string, number>();

type NonceResponse = {
  success: true;
  nonce: string;
  expiresAt: string;
};

type VerifyResponse = {
  success: true;
  address: `0x${string}`;
  token: string;
  expiresAt: string;
};

const publicClient = createBaseVerificationClient();

function clearExpiredNonces() {
  const now = Date.now();

  for (const [nonce, expiresAt] of pendingNonces.entries()) {
    if (expiresAt <= now) {
      pendingNonces.delete(nonce);
    }
  }
}

function getRequestIp(c: any) {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const firstForwarded = forwarded.split(",")[0]?.trim();
    if (firstForwarded) {
      return firstForwarded;
    }
  }

  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function getRequestFingerprint(c: any) {
  return createHash("sha256")
    .update(`${getRequestIp(c)}|${c.req.header("user-agent") || "unknown"}`)
    .digest("hex");
}

function buildVerifyRequestKey(input: {
  address: string;
  message: string;
  signature: string;
}) {
  return createHash("sha256")
    .update(
      `${input.address.toLowerCase()}|${input.message}|${input.signature.toLowerCase()}`
    )
    .digest("hex");
}

authRoutes.post("/siwe/nonce", async (c) => {
  clearExpiredNonces();

  const fingerprint = getRequestFingerprint(c);
  const recentCacheKey = `auth:siwe:nonce:recent:${fingerprint}`;
  const rateLimit = runtimeCache.consumeRateLimit(
    `auth:siwe:nonce:rate:${fingerprint}`,
    AUTH_NONCE_BURST_LIMIT,
    AUTH_BURST_WINDOW_MS
  );

  if (!rateLimit.allowed) {
    return c.json(
      {
        success: false,
        error: "Please wait a moment before requesting another sign-in nonce.",
      },
      429
    );
  }

  const recent = runtimeCache.get<NonceResponse>(recentCacheKey);
  if (recent) {
    return c.json(recent);
  }

  const payload = await runtimeCache.singleFlight(
    `auth:siwe:nonce:inflight:${fingerprint}`,
    async () => {
      const nonce = generateSiweNonce();
      const expiresAt = Date.now() + SIWE_NONCE_TTL_MS;
      const result = {
        success: true,
        nonce,
        expiresAt: new Date(expiresAt).toISOString(),
      } satisfies NonceResponse;

      pendingNonces.set(nonce, expiresAt);
      runtimeCache.set(recentCacheKey, result, SIWE_NONCE_RECENT_TTL_MS);
      return result;
    }
  );

  return c.json(payload);
});

authRoutes.post("/siwe/verify", async (c) => {
  clearExpiredNonces();

  const body = await c.req.json<{
    address?: string;
    message?: string;
    signature?: `0x${string}`;
  }>();

  if (!body.address || !body.message || !body.signature) {
    return c.json(
      { success: false, error: "address, message, and signature are required" },
      400
    );
  }

  const fingerprint = getRequestFingerprint(c);
  const rateLimit = runtimeCache.consumeRateLimit(
    `auth:siwe:verify:rate:${fingerprint}`,
    AUTH_VERIFY_BURST_LIMIT,
    AUTH_BURST_WINDOW_MS
  );

  if (!rateLimit.allowed) {
    return c.json(
      {
        success: false,
        error: "Please wait a moment before trying to verify sign-in again.",
      },
      429
    );
  }

  const verifyRequestKey = buildVerifyRequestKey({
    address: body.address,
    message: body.message,
    signature: body.signature,
  });
  const recentSuccessCacheKey = `auth:siwe:verify:recent:${verifyRequestKey}`;
  const recentSuccess = runtimeCache.get<VerifyResponse>(recentSuccessCacheKey);

  if (recentSuccess) {
    return c.json(recentSuccess);
  }

  try {
    const payload = await runtimeCache.singleFlight(
      `auth:siwe:verify:inflight:${verifyRequestKey}`,
      async () => {
        const parsed = parseSiweMessage(body.message!);
        const normalizedAddress = getAddress(body.address!);
        const parsedAddress = parsed.address ? getAddress(parsed.address) : null;
        const nonce = parsed.nonce;
        const domain = parsed.domain;

        if (!parsedAddress || parsedAddress !== normalizedAddress) {
          throw new Error("SIWE address mismatch");
        }

        if (!nonce) {
          throw new Error("Missing SIWE nonce");
        }

        const nonceExpiresAt = pendingNonces.get(nonce);
        if (!nonceExpiresAt) {
          throw new Error("Invalid or expired SIWE nonce");
        }

        if (nonceExpiresAt <= Date.now()) {
          pendingNonces.delete(nonce);
          throw new Error("Expired SIWE nonce");
        }

        if (!domain || !isAllowedAppDomain(domain)) {
          throw new Error("Unexpected SIWE domain");
        }

        const valid = await publicClient.verifySiweMessage({
          address: normalizedAddress,
          domain,
          message: body.message!,
          nonce,
          signature: body.signature!,
        });

        if (!valid) {
          throw new Error("Invalid SIWE signature");
        }

        pendingNonces.delete(nonce);
        runtimeCache.invalidate(`auth:siwe:nonce:recent:${fingerprint}`);

        const { token, expiresAt } = issueSessionToken(normalizedAddress);
        const result = {
          success: true,
          address: normalizedAddress,
          token,
          expiresAt: new Date(expiresAt).toISOString(),
        } satisfies VerifyResponse;

        runtimeCache.set(
          recentSuccessCacheKey,
          result,
          SIWE_VERIFY_RECENT_TTL_MS
        );

        return result;
      }
    );

    return c.json(payload);
  } catch (error) {
    const message = (error as Error).message || "Failed to verify SIWE message";
    const status =
      message === "SIWE address mismatch" ||
      message === "Missing SIWE nonce" ||
      message === "Invalid or expired SIWE nonce" ||
      message === "Expired SIWE nonce" ||
      message === "Unexpected SIWE domain" ||
      message === "Invalid SIWE signature"
        ? 401
        : 400;

    return c.json(
      {
        success: false,
        error: message,
      },
      status
    );
  }
});

export { authRoutes };
