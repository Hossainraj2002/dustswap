import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAddress } from "viem";
import type { LaunchCampaign } from "../lib/launch-campaign/service";
import { HttpError, clientIp, hashIp, parseAddress } from "./http";
import { type AuthVariables, requireAuth } from "./write/auth";
import type { Sessions } from "./write/session";

export interface CampaignDeps { campaign: LaunchCampaign; sessions: Sessions; ipSalt: string }
export function launchCampaignRoutes(deps?: CampaignDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const required = () => {
    if (!deps || !deps.campaign.configured()) throw new HttpError(503, "campaign_unavailable", "The launch reward campaign is not active.");
    return deps;
  };
  const quota = async (key: string, limit: number, window: number) => {
    if (!await required().campaign.quota(key, limit, window)) throw new HttpError(429, "campaign_request_quota", "Too many campaign requests. Try again later.");
  };
  app.get("/v1/launch-campaign", async c => {
    c.header("Cache-Control", "no-store");
    if (!deps || !deps.campaign.configured()) return c.json({ enabled: false } as const);
    await quota(`summary:${hashIp(clientIp(c), deps.ipSalt)}`, 120, 60);
    return c.json(await deps.campaign.summary());
  });
  app.get("/v1/launch-campaign/wallets/:address", async c => {
    c.header("Cache-Control", "no-store");
    const d = required();
    await quota(`wallet-read:${hashIp(clientIp(c), d.ipSalt)}`, 60, 60);
    return c.json(await d.campaign.wallet(getAddress(parseAddress(c.req.param("address")))));
  });
  app.post("/v1/launch-campaign/claim-ticket", bodyLimit({ maxSize: 1024, onError: () => { throw new HttpError(413, "body_too_large", "That request is too large."); } }),
    async (c, next) => requireAuth(required().sessions)(c, next), async c => {
      c.header("Cache-Control", "no-store");
      const d = required();
      const wallet = getAddress(c.get("wallet")!);
      await quota(`ticket:wallet:${wallet.toLowerCase()}`, 20, 3600);
      await quota(`ticket:ip:${hashIp(clientIp(c), d.ipSalt)}`, 60, 3600);
      // No recipient field is accepted: only the authenticated wallet can receive its voucher.
      return c.json(await d.campaign.ticket(wallet));
    });
  return app;
}
