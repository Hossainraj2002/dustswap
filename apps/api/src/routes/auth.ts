import { Hono } from "hono";
import {
  createPublicClient,
  getAddress,
  http,
} from "viem";
import { base } from "viem/chains";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";

const authRoutes = new Hono();

const SIWE_NONCE_TTL_MS = 5 * 60 * 1000;
const pendingNonces = new Map<string, number>();

function getHostFromUrl(value?: string | null) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

const allowedDomains = Array.from(
  new Set(
    [
      "localhost:3000",
      "dustswap.xyz",
      "www.dustswap.xyz",
      "dustswap.vercel.app",
      "dustswap-web.vercel.app",
      "app.dustswap.wtf",
      getHostFromUrl(process.env.NEXT_PUBLIC_APP_URL),
    ].filter((value): value is string => Boolean(value))
  )
);

const publicClient = createPublicClient({
  chain: base,
  transport: http(
    process.env.BASE_RPC_URL ||
      process.env.NEXT_PUBLIC_BASE_RPC_URL ||
      "https://mainnet.base.org"
  ),
});

function clearExpiredNonces() {
  const now = Date.now();

  for (const [nonce, expiresAt] of pendingNonces.entries()) {
    if (expiresAt <= now) {
      pendingNonces.delete(nonce);
    }
  }
}

authRoutes.post("/siwe/nonce", async (c) => {
  clearExpiredNonces();

  const nonce = generateSiweNonce();
  const expiresAt = Date.now() + SIWE_NONCE_TTL_MS;

  pendingNonces.set(nonce, expiresAt);

  return c.json({
    success: true,
    nonce,
    expiresAt: new Date(expiresAt).toISOString(),
  });
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

  try {
    const parsed = parseSiweMessage(body.message);
    const normalizedAddress = getAddress(body.address);
    const parsedAddress = parsed.address ? getAddress(parsed.address) : null;
    const nonce = parsed.nonce;
    const domain = parsed.domain;

    if (!parsedAddress || parsedAddress !== normalizedAddress) {
      return c.json({ success: false, error: "SIWE address mismatch" }, 401);
    }

    if (!nonce) {
      return c.json({ success: false, error: "Missing SIWE nonce" }, 401);
    }

    const nonceExpiresAt = pendingNonces.get(nonce);
    if (!nonceExpiresAt) {
      return c.json({ success: false, error: "Invalid or expired SIWE nonce" }, 401);
    }

    if (nonceExpiresAt <= Date.now()) {
      pendingNonces.delete(nonce);
      return c.json({ success: false, error: "Expired SIWE nonce" }, 401);
    }

    if (!domain || !allowedDomains.includes(domain)) {
      return c.json({ success: false, error: "Unexpected SIWE domain" }, 401);
    }

    const valid = await publicClient.verifySiweMessage({
      address: normalizedAddress,
      domain,
      message: body.message,
      nonce,
      signature: body.signature,
    });

    if (!valid) {
      return c.json({ success: false, error: "Invalid SIWE signature" }, 401);
    }

    pendingNonces.delete(nonce);

    return c.json({
      success: true,
      address: normalizedAddress,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: (error as Error).message || "Failed to verify SIWE message",
      },
      401
    );
  }
});

export { authRoutes };
