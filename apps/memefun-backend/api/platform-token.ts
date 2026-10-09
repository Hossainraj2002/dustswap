import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Hex, getAddress } from "viem";
import { z } from "zod";
import type { PlatformTokenService } from "../lib/platform-token/service";
import { HttpError, clientIp, hashIp } from "./http";
import { type AuthVariables, requireAuth } from "./write/auth";
import type { Sessions } from "./write/session";

export interface PlatformTokenDeps { platformToken: PlatformTokenService; sessions: Sessions; ipSalt: string }
const prepareBody = z.object({ salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/), contractURI: z.string().min(1).max(200)
  .refine(value => /^(ipfs:\/\/|https:\/\/)/.test(value) && new TextEncoder().encode(value).length <= 200
    && [...value].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127)) }).strict();

export function platformTokenRoutes(deps?: PlatformTokenDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const required = () => {
    if (!deps || !deps.platformToken.configured()) throw new HttpError(503, "platform_token_unavailable", "Official token selection is not configured.");
    return deps;
  };
  const quota = async (key: string, limit: number, window: number) => {
    if (!await required().platformToken.quota(key, limit, window)) throw new HttpError(429, "platform_token_request_quota", "Too many official token requests. Try again later.");
  };
  app.get("/v1/platform-token", async c => {
    c.header("Cache-Control", "no-store");
    if (!deps || !deps.platformToken.configured()) return c.json({ enabled: false } as const);
    await quota(`read:${hashIp(clientIp(c), deps.ipSalt)}`, 120, 60);
    return c.json(await deps.platformToken.summary());
  });
  app.post("/v1/platform-token/prepare", bodyLimit({ maxSize: 2048, onError: () => { throw new HttpError(413, "body_too_large", "That request is too large."); } }),
    async (c, next) => requireAuth(required().sessions)(c, next), async c => {
      c.header("Cache-Control", "no-store");
      const d = required();
      const wallet = getAddress(c.get("wallet")!);
      await quota(`prepare:wallet:${wallet.toLowerCase()}`, 20, 3600);
      await quota(`prepare:ip:${hashIp(clientIp(c), d.ipSalt)}`, 60, 3600);
      const body = prepareBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) throw new HttpError(400, "invalid_request", "Send a bytes32 launch salt and the exact metadata URI.");
      const value = await d.platformToken.prepare(wallet, body.data.salt.toLowerCase() as Hex, body.data.contractURI);
      return c.json({ coin: value.coin, salt: value.salt, contractURI: value.contractURI, createdAt: value.createdAt }, value.created ? 201 : 200);
    });
  return app;
}
