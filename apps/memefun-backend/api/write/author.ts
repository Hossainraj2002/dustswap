import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type Address, type Hex, getAddress, zeroAddress } from "viem";
import type { Deployment } from "../../lib/deployment";
import type { TweetAttestor } from "../../lib/x/attestation";
import { type XOAuth, safeAuthorReturnTo } from "../../lib/x/oauth";
import type { TweetProvider } from "../../lib/x/provider";
import type { XStore } from "../../lib/x/store";
import { AUTHOR_RESERVE_DAYS, type AuthorVerification, type TweetLaunchAttestation, validateAuthorShareBps } from "../../shared/core/tweet";
import { HttpError, clientIp, hashIp, parseAddress } from "../http";
import type { MarketSnapshot } from "../read/snapshot";
import { type AuthVariables, optionalAuth, requireAuth } from "./auth";
import type { Sessions } from "./session";

export interface AuthorDeps {
  store: XStore;
  oauth: XOAuth;
  provider: TweetProvider;
  attestor: TweetAttestor;
  sessions: Sessions;
  snapshot: MarketSnapshot;
  origins: Set<string>;
  deployment: Deployment;
  ipSalt: string;
}
const urlBody = z.object({ url: z.string().min(1).max(2_048) });
const attestationBody = urlBody.extend({ authorShareBps: z.number().refine(validateAuthorShareBps), salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
const cap = bodyLimit({ maxSize: 8 * 1024, onError: () => { throw new HttpError(413, "body_too_large", "That request is too large."); } });

export function authorRoutes(deps: AuthorDeps) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const quota = async (key: string, limit: number, windowSec: number) => {
    if (!await deps.store.quota(key, limit, windowSec)) throw new HttpError(429, "x_request_quota", "Too many X requests. Try again later.");
  };
  app.post("/v1/tweets/import", cap, optionalAuth(deps.sessions), async (c) => {
    const owner = c.get("wallet")?.toLowerCase() ?? hashIp(clientIp(c), deps.ipSalt);
    await quota(`tweet:import:${owner}`, 20, 60);
    const body = urlBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "invalid_request", "Send a public X post URL.");
    c.header("Cache-Control", "no-store");
    return c.json(await deps.provider.import(body.data.url, deps.oauth.configured() && await deps.attestor.supported()));
  });

  app.post("/v1/tweets/attestation", cap, requireAuth(deps.sessions), async (c) => {
    const launcher = c.get("wallet")!;
    await quota(`tweet:attest:${launcher.toLowerCase()}`, 30, 3_600);
    const body = attestationBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "invalid_request", "Send a public post URL, a 20%–100% author share and a bytes32 launch salt.");
    if (!deps.oauth.configured()) throw new HttpError(503, "x_oauth_unavailable", "X author verification is not configured for this deployment yet.");
    if (!await deps.attestor.supported(true)) throw new HttpError(503, "tweet_attestor_unavailable", "Verified author fees are not configured for this deployment yet.");
    const source = await deps.provider.import(body.data.url, true);
    const tweet = { postId: source.postId, authorXUserId: source.author.id, authorShareBps: body.data.authorShareBps };
    const signed = await deps.attestor.launch({ launcher, salt: body.data.salt as Hex, ...tweet });
    await deps.store.saveSource(source);
    c.header("Cache-Control", "no-store");
    const dto: TweetLaunchAttestation = { source, launcher, salt: body.data.salt as Hex, tweet, ...signed, chainId: deps.deployment.chainId,
      factory: deps.deployment.factory, reserveDays: AUTHOR_RESERVE_DAYS };
    return c.json(dto);
  });

  app.post("/v1/author/connect", cap, requireAuth(deps.sessions), async (c) => {
    const wallet = c.get("wallet")!;
    await quota(`author:connect:${wallet.toLowerCase()}`, 10, 3_600);
    const body = z.object({ returnTo: z.string().max(2_048).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError(400, "invalid_request", "Send an optional return URL in this app.");
    c.header("Cache-Control", "no-store");
    return c.json({ authUrl: await deps.oauth.connect(wallet, safeAuthorReturnTo(body.data.returnTo, deps.origins)) });
  });
  app.get("/v1/author/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    try {
      const record = await deps.oauth.callback(code, state);
      const target = new URL(safeAuthorReturnTo(record.returnTo, deps.origins));
      target.searchParams.delete("authorLinked");
      target.hash = new URLSearchParams({ authorCompletion: record.completionToken }).toString();
      return c.redirect(target.toString(), 302);
    } catch (error) {
      if (error instanceof HttpError && error.code === "x_oauth_unavailable") throw error;
      const target = new URL(safeAuthorReturnTo(undefined, deps.origins));
      target.searchParams.set("authorLinked", "0");
      return c.redirect(target.toString(), 302);
    }
  });
  app.post("/v1/author/complete", cap, requireAuth(deps.sessions), async (c) => {
    const wallet = c.get("wallet")!;
    await quota(`author:complete:${wallet.toLowerCase()}`, 20, 3_600);
    const body = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "invalid_request", "Send the X verification completion token.");
    c.header("Cache-Control", "no-store");
    return c.json({ author: await deps.oauth.complete(body.data.token, wallet) });
  });
  app.get("/v1/author/me", requireAuth(deps.sessions), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ author: await deps.store.author(c.get("wallet")!) });
  });
  app.post("/v1/author/verification", cap, requireAuth(deps.sessions), async (c) => {
    const wallet = c.get("wallet")!;
    await quota(`author:verify:${wallet.toLowerCase()}`, 20, 3_600);
    const body = z.object({ coin: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "invalid_request", "Send the tweet coin's address.");
    const coin = getAddress(parseAddress(body.data.coin)) as Address;
    const author = await deps.store.author(wallet);
    if (!author) throw new HttpError(403, "x_author_not_verified", "Connect and verify your own X account first.");
    if (Date.now() - Date.parse(author.verifiedAt) > 15 * 60_000) throw new HttpError(403, "x_author_verification_stale", "Reconnect X to verify that you still control this author account.");
    const attribution = await deps.attestor.attribution(coin);
    if (author.id !== attribution.authorXUserId) throw new HttpError(403, "x_author_mismatch", "Your verified X account is not this post's author.");
    const signed = await deps.attestor.verification({ coin, wallet, ...attribution });
    c.header("Cache-Control", "no-store");
    const dto: AuthorVerification = { coin, authorXUserId: author.id, wallet, ...signed, chainId: deps.deployment.chainId, feeVault: deps.deployment.feeVault };
    return c.json(dto);
  });

  /** Monetary state comes from the contract; an index delay can never authorize a wallet. */
  app.get("/v1/coins/:address/author", async (c) => {
    await quota(`author:read:${hashIp(clientIp(c), deps.ipSalt)}`, 60, 60);
    const coin = getAddress(parseAddress(c.req.param("address"))) as Address;
    const attribution = await deps.attestor.attribution(coin);
    const now = await deps.attestor.now();
    const state = await deps.snapshot.ready();
    const indexed = state.byAddress.get(coin.toLowerCase());
    if (!indexed || indexed.hidden) throw new HttpError(404, "coin_not_found", "No coin with this address on memefun.");
    const markets = indexed.markets ?? [];
    const balances = await Promise.all(markets.map(async m => ({ poolId: m.poolId, currency: m.quote.address, symbol: m.quote.symbol,
      decimals: m.quote.decimals, pendingRaw: (await deps.attestor.pending(coin, m.quote.address)).toString() })));
    c.header("Cache-Control", "no-store");
    const verified = attribution.verifiedWallet !== zeroAddress;
    const source = await deps.store.source(attribution.postId);
    return c.json({ coin, source: source?.author.id === attribution.authorXUserId ? source : null, postId: attribution.postId, authorXUserId: attribution.authorXUserId, authorShareBps: attribution.authorShareBps,
      verifyBy: Number(attribution.verifyBy) * 1_000, verifiedWallet: verified ? attribution.verifiedWallet : null,
      treasuryUnlockAt: Number(attribution.verifyBy) * 1_000, treasuryUnlocked: now >= attribution.verifyBy,
      status: verified ? "verified" : "unverified", reserveDays: AUTHOR_RESERVE_DAYS, markets: balances });
  });
  return app;
}
