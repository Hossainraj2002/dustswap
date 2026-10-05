import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { type PublicClient, recoverTypedDataAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type AuthorDeps, authorRoutes } from "../../api/write/author";
import { createSessions } from "../../api/write/session";
import { HttpError } from "../../api/http";
import type { Deployment } from "../../lib/deployment";
import { tweetCreatorSplit } from "../../lib/indexer/tweet-fees";
import { authorVerificationTypes, createTweetAttestor, tweetLaunchTypes } from "../../lib/x/attestation";
import { createXOAuth, safeAuthorReturnTo } from "../../lib/x/oauth";
import { createTweetProvider } from "../../lib/x/provider";
import { type OAuthCompletion, type OAuthState, type VerifiedAuthor, type XStore } from "../../lib/x/store";

const wallet = "0x0000000000000000000000000000000000000001" as const;
const coin = "0x0000000000000000000000000000000000000002" as const;
const postId = "2019264360682778716";
const authorId = "44196397";
const source = { status: "success", data: { id: postId, text: "$FROG is awake", author: { id: authorId, userName: "frog", name: "Frog" }, media: [] } };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function store() {
  const states = new Map<string, OAuthState>();
  const completions = new Map<string, OAuthCompletion>();
  let identity: VerifiedAuthor | null = null;
  const cached = new Map<string, unknown>();
  const api: XStore = {
    async putState(key, value) { states.set(key, value); },
    async consumeState(key) { const value = states.get(key) ?? null; if (!value || Date.parse(value.expiresAt) <= Date.now()) return null; states.delete(key); return value; },
    async putCompletion(key, value) { completions.set(key, value); },
    async consumeCompletion(key, wallet) {
      const value = completions.get(key);
      if (!value || value.wallet.toLowerCase() !== wallet.toLowerCase() || Date.parse(value.expiresAt) <= Date.now()) return null;
      completions.delete(key);
      return value;
    },
    async completionWallet(key) { const value = completions.get(key); return value && Date.parse(value.expiresAt) > Date.now() ? value.wallet : null; },
    async author() { return identity; },
    async saveAuthor(_wallet, value) { identity = { ...value, verifiedAt: new Date().toISOString() }; },
    async cachedPost<T>(id: string) { return (cached.get(id) as T | undefined) ?? null; },
    async cachePost(id, value) { cached.set(id, value); },
    async saveSource() {}, async source() { return null; }, async quota() { return true; }, async prune() {},
  };
  return { api, states, completions };
}

describe("X provider boundary", () => {
  it("uses a fixed server endpoint, validates returned IDs and deduplicates concurrent imports", async () => {
    const db = store().api;
    const fetchFn = vi.fn<typeof fetch>(async () => response(source));
    const provider = createTweetProvider({ apiKey: "test-only-provider-key" }, db, fetchFn);
    const [a, b] = await Promise.all([provider.import(`https://x.com/oldhandle/status/${postId}`), provider.import(`https://twitter.com/frog/status/${postId}?s=20`)]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe(`https://api.getxapi.com/twitter/tweet/detail?id=${postId}`);
    expect(fetchFn.mock.calls[0]![1]?.redirect).toBe("error");
    expect(a.author.id).toBe(authorId);
    expect(a).toEqual(b);
    expect(await provider.import(a.url, true)).toMatchObject({ authorFeesSupported: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const wrong = createTweetProvider({ apiKey: "test" }, store().api, async () => response({ ...source, data: { ...source.data, id: "1" } }));
    await expect(wrong.import(a.url)).rejects.toMatchObject({ code: "tweet_unverified" });
  });
  it("refuses absent configuration, spoofed hosts, provider redirects and malformed numeric authors", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => { throw new Error("redirect"); });
    const missing = createTweetProvider(null, store().api, fetchFn);
    await expect(missing.import(`https://x.com/frog/status/${postId}`)).rejects.toMatchObject({ status: 503 });
    await expect(missing.import(`https://x.com.evil.test/frog/status/${postId}`)).rejects.toMatchObject({ code: "tweet_url_invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(createTweetProvider({ apiKey: "test" }, store().api, fetchFn).import(`https://x.com/frog/status/${postId}`)).rejects.toMatchObject({ code: "tweet_provider_unavailable" });
    const badAuthor = { ...source, data: { ...source.data, author: { ...source.data.author, id: Number(authorId) } } };
    await expect(createTweetProvider({ apiKey: "test" }, store().api, async () => response(badAuthor)).import(`https://x.com/frog/status/${postId}`)).rejects.toMatchObject({ code: "tweet_unverified" });
  });
  it("limits provider spend before fetching on a cache miss", async () => {
    const db = store().api;
    db.quota = async () => false;
    const fetchFn = vi.fn<typeof fetch>();
    await expect(createTweetProvider({ apiKey: "test" }, db, fetchFn).import(`https://x.com/frog/status/${postId}`)).rejects.toMatchObject({ status: 429 });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("shares one daily budget across provider instances while cache hits consume no reads", async () => {
    const db = store().api;
    const counts = new Map<string, number>();
    db.quota = async (key, limit) => { const count = (counts.get(key) ?? 0) + 1; counts.set(key, count); return count <= limit; };
    const fetchFn = vi.fn<typeof fetch>(async (url) => response({ ...source, data: { ...source.data, id: new URL(String(url)).searchParams.get("id") } }));
    const a = createTweetProvider({ apiKey: "test", dailyLimit: 2 }, db, fetchFn);
    const b = createTweetProvider({ apiKey: "test", dailyLimit: 2 }, db, fetchFn);
    const link = (id: string) => `https://x.com/frog/status/${id}`;
    await a.import(link(postId));
    await b.import(link(postId)); // A shared cache hit, even from a different replica.
    expect(counts.get("getx:provider:daily")).toBe(1);
    await b.import(link("2019264360682778717"));
    await expect(a.import(link("2019264360682778718"))).rejects.toMatchObject({ code: "tweet_provider_daily_quota" });
    await expect(b.import(link("2019264360682778719"))).rejects.toMatchObject({ code: "tweet_provider_daily_quota" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("defaults to 100 daily reads, bounds overrides, and charges failed provider calls", async () => {
    const link = `https://x.com/frog/status/${postId}`;
    for (const [override, expected] of [[undefined, 100], [Number.NaN, 100], [-5, 0], [20_000, 10_000]] as const) {
      const db = store().api;
      const quota = vi.fn(async () => false);
      db.quota = quota;
      await expect(createTweetProvider({ apiKey: "test", dailyLimit: override }, db).import(link)).rejects.toMatchObject({ code: "tweet_provider_daily_quota" });
      expect(quota).toHaveBeenCalledWith("getx:provider:daily", expected, 86_400);
    }
    const db = store().api;
    let reads = 0;
    db.quota = async (key, limit) => key.endsWith(":daily") ? ++reads <= limit : true;
    const fetchFn = vi.fn<typeof fetch>(async () => { throw new Error("provider down"); });
    const provider = createTweetProvider({ apiKey: "test", dailyLimit: 1 }, db, fetchFn);
    await expect(provider.import(link)).rejects.toMatchObject({ code: "tweet_provider_unavailable" });
    await expect(provider.import(link)).rejects.toMatchObject({ code: "tweet_provider_daily_quota" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("X author OAuth", () => {
  it("shares the official X daily budget across instances and never charges state replay twice", async () => {
    const db = store();
    let reserved = 0;
    db.api.quota = async (key, limit, seconds) => { expect(key).toBe("x:author:verify:daily"); expect(seconds).toBe(86_400); return ++reserved <= limit; };
    const fetchFn = vi.fn<typeof fetch>(async (url) => String(url).includes("oauth2/token") ? response({ access_token: "test" }) : response({ data: { id: authorId, username: "frog" } }));
    const config = { clientId: "test", redirectUri: "https://api.example.test/callback", dailyLimit: 2 };
    const a = createXOAuth(config, db.api, fetchFn);
    const b = createXOAuth(config, db.api, fetchFn);
    const start = async (oauth: typeof a) => new URL(await oauth.connect(wallet, "https://memefun.example.test/rewards/author")).searchParams.get("state")!;
    const first = await start(a);
    await b.callback("code", first);
    await expect(a.callback("code", first)).rejects.toMatchObject({ code: "x_oauth_expired" });
    expect(reserved).toBe(1);
    await a.callback("code", await start(b));
    await expect(b.callback("code", await start(a))).rejects.toMatchObject({ code: "x_oauth_daily_quota" });
    expect(fetchFn).toHaveBeenCalledTimes(4); // Two exchanges and two users/me reads.
  });
  it("does no paid call for expired state and counts failed valid flows conservatively", async () => {
    const db = store();
    const quota = vi.fn(async () => true);
    db.api.quota = quota;
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("", { status: 401 }));
    const oauth = createXOAuth({ clientId: "test", redirectUri: "https://api.example.test/callback" }, db.api, fetchFn);
    const start = async () => new URL(await oauth.connect(wallet, "https://memefun.example.test/rewards/author")).searchParams.get("state")!;
    const expired = await start();
    db.states.get(expired)!.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await expect(oauth.callback("code", expired)).rejects.toMatchObject({ code: "x_oauth_expired" });
    expect(quota).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    const failed = await start();
    await expect(oauth.callback("code", failed)).rejects.toMatchObject({ code: "x_oauth_exchange" });
    await expect(oauth.callback("code", failed)).rejects.toMatchObject({ code: "x_oauth_expired" });
    expect(quota).toHaveBeenCalledTimes(1);
    expect(quota).toHaveBeenCalledWith("x:author:verify:daily", 10, 86_400);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("bounds official X budget overrides and makes a zero budget unavailable before authorization", async () => {
    const db = store();
    const quota = vi.fn(async () => false);
    db.api.quota = quota;
    const fetchFn = vi.fn<typeof fetch>();
    const disabled = createXOAuth({ clientId: "test", redirectUri: "https://api.example.test/callback", dailyLimit: 0 }, db.api, fetchFn);
    expect(disabled.configured()).toBe(false);
    await expect(disabled.connect(wallet, "https://memefun.example.test/rewards/author")).rejects.toMatchObject({ code: "x_oauth_budget_disabled", status: 503 });
    expect(db.states.size).toBe(0);
    for (const [override, expected] of [[Number.NaN, 10], [20_000, 10_000]] as const) {
      const oauth = createXOAuth({ clientId: "test", redirectUri: "https://api.example.test/callback", dailyLimit: override }, db.api, fetchFn);
      const state = new URL(await oauth.connect(wallet, "https://memefun.example.test/rewards/author")).searchParams.get("state")!;
      await expect(oauth.callback("code", state)).rejects.toMatchObject({ code: "x_oauth_daily_quota" });
      expect(quota).toHaveBeenLastCalledWith("x:author:verify:daily", expected, 86_400);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("binds PKCE state to the signed wallet and links only after that wallet consumes a fresh completion", async () => {
    const db = store();
    const fetchFn = vi.fn<typeof fetch>(async (url) => String(url).includes("oauth2/token")
      ? response({ access_token: "test-only-access-token", refresh_token: "discarded" })
      : response({ data: { id: authorId, username: "frog", name: "Frog" } }));
    const oauth = createXOAuth({ clientId: "test-client", redirectUri: "https://api.example.test/v1/author/callback" }, db.api, fetchFn);
    const url = new URL(await oauth.connect(wallet, "https://memefun.example.test/portfolio"));
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(["users.read", "tweet.read"]);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    expect(db.states.get(state)?.wallet).toBe(wallet);
    const callback = await oauth.callback("test-code", state);
    expect(await db.api.author(wallet)).toBeNull();
    expect(callback.completionToken).not.toBe(state);
    await expect(oauth.complete(callback.completionToken, coin)).rejects.toMatchObject({ code: "x_oauth_completion_wallet_mismatch" });
    expect(db.completions.has(callback.completionToken)).toBe(true);
    await oauth.complete(callback.completionToken, wallet);
    expect(await db.api.author(wallet)).toMatchObject({ id: authorId, handle: "frog" });
    expect(await db.api.author(wallet)).not.toHaveProperty("access_token");
    await expect(oauth.complete(callback.completionToken, wallet)).rejects.toMatchObject({ code: "x_oauth_completion_expired" });
    await expect(oauth.callback("same-code", state)).rejects.toMatchObject({ code: "x_oauth_expired" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });
  it("refuses forged or expired completion tokens and lets only one concurrent request consume a token", async () => {
    const db = store();
    const oauth = createXOAuth(null, db.api);
    const token = "a".repeat(43);
    await expect(oauth.complete("forged", wallet)).rejects.toMatchObject({ code: "x_oauth_completion_invalid" });
    await db.api.putCompletion(token, { wallet, author: { id: authorId, handle: "frog", name: "Frog" }, expiresAt: new Date(Date.now() - 1).toISOString() });
    await expect(oauth.complete(token, wallet)).rejects.toMatchObject({ code: "x_oauth_completion_expired" });
    expect(await db.api.author(wallet)).toBeNull();
    await db.api.putCompletion(token, { wallet, author: { id: authorId, handle: "frog", name: "Frog" }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const results = await Promise.allSettled([oauth.complete(token, wallet), oauth.complete(token, wallet)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("does not promote a numeric JavaScript ID or failed provider lookup to verified identity", async () => {
    const db = store();
    const oauth = createXOAuth({ clientId: "test", redirectUri: "https://api.example.test/callback" }, db.api,
      async (url) => String(url).includes("oauth2/token") ? response({ access_token: "test" }) : response({ data: { id: Number(authorId), username: "frog" } }));
    const state = new URL(await oauth.connect(wallet, "https://memefun.example.test/portfolio")).searchParams.get("state")!;
    await expect(oauth.callback("code", state)).rejects.toMatchObject({ code: "x_oauth_identity" });
    expect(await db.api.author(wallet)).toBeNull();
    expect(safeAuthorReturnTo("https://memefun.example.test.evil.test", new Set(["https://memefun.example.test"]))).toBe("https://memefun.example.test/rewards/author");
    await expect(createXOAuth(null, db.api).connect(wallet, "https://memefun.example.test")).rejects.toMatchObject({ status: 503 });
  });
});

describe("tweet signatures", () => {
  const key = `0x${"11".repeat(32)}` as const;
  const signer = privateKeyToAccount(key);
  const deployment: Deployment = { chainId: 84532, deployedAtBlock: 0, factory: coin, feeVault: wallet, config: coin,
    poolManager: coin, router: coin, hook: coin, buybackBurnVault: coin, floorVault: coin, holderRewardDistributor: coin,
    ethUsdFeed: coin, usdc: coin, owner: wallet, treasury: wallet, priceKeeper: wallet, rewardsPublisher: wallet };
  const client = { readContract: async () => signer.address, getBlock: async () => ({ timestamp: 1_000n }) } as unknown as PublicClient;
  it("binds launch signatures to launcher, salt, author/share, chain and factory", async () => {
    const salt = `0x${"22".repeat(32)}` as const;
    const signed = await createTweetAttestor(key, client, deployment).launch({ launcher: wallet, salt, postId, authorXUserId: authorId, authorShareBps: 5_000 });
    const domain = { name: "MemeFunFactory", version: "1", chainId: 84532, verifyingContract: coin };
    const message = { launcher: wallet, salt, postId: BigInt(postId), authorXUserId: BigInt(authorId), authorShareBps: 5_000, deadline: BigInt(signed.deadline) };
    const recovered = await recoverTypedDataAddress({ domain, types: tweetLaunchTypes, primaryType: "TweetLaunch", message, signature: signed.signature });
    expect(recovered).toBe(signer.address);
    expect(await recoverTypedDataAddress({ domain: { ...domain, chainId: 8453 }, types: tweetLaunchTypes, primaryType: "TweetLaunch", message, signature: signed.signature })).not.toBe(signer.address);
    expect(await recoverTypedDataAddress({ domain, types: tweetLaunchTypes, primaryType: "TweetLaunch", message: { ...message, authorShareBps: 6_000 }, signature: signed.signature })).not.toBe(signer.address);
  });
  it("permits late author verification with a short proof deadline and fails closed for unauthorized signing", async () => {
    const attestor = createTweetAttestor(key, client, deployment);
    const signed = await attestor.verification({ coin, wallet, authorXUserId: authorId, verifyBy: 1_050n, verifiedWallet: zeroAddress });
    expect(signed.deadline).toBe("1300");
    const recovered = await recoverTypedDataAddress({ domain: { name: "MemeFunFeeVault", version: "1", chainId: 84532, verifyingContract: wallet },
      types: authorVerificationTypes, primaryType: "AuthorVerification", message: { coin, wallet, authorXUserId: BigInt(authorId), deadline: 1_300n }, signature: signed.signature });
    expect(recovered).toBe(signer.address);
    expect(await attestor.verification({ coin, wallet, authorXUserId: authorId, verifyBy: 1n, verifiedWallet: zeroAddress })).toMatchObject({ deadline: "1300" });
    await expect(attestor.verification({ coin, wallet, authorXUserId: authorId, verifyBy: 1n, verifiedWallet: wallet })).rejects.toMatchObject({ code: "author_already_verified" });
    await expect(createTweetAttestor(undefined, client, deployment).launch({ launcher: wallet, salt: `0x${"22".repeat(32)}`, postId, authorXUserId: authorId, authorShareBps: 5_000 })).rejects.toMatchObject({ status: 503 });
  });
});

describe("tweet author API authorization", () => {
  it("requires SIWE before starting OAuth or issuing signatures and never trusts a submitted wallet", async () => {
    const sessions = createSessions("test-session-secret".repeat(3));
    const deps = { sessions, oauth: { connect: vi.fn() }, attestor: { supported: vi.fn() }, store: store().api } as unknown as AuthorDeps;
    const app = new Hono().route("/", authorRoutes(deps));
    app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    expect((await app.request("/v1/author/connect", { method: "POST", body: JSON.stringify({ wallet }) })).status).toBe(401);
    expect((await app.request("/v1/tweets/attestation", { method: "POST", body: JSON.stringify({ wallet }) })).status).toBe(401);
    expect((await app.request("/v1/author/verification", { method: "POST", body: JSON.stringify({ wallet, coin }) })).status).toBe(401);
    expect((await app.request("/v1/author/complete", { method: "POST", body: JSON.stringify({ token: "a".repeat(43) }) })).status).toBe(401);
    expect(deps.oauth.connect).not.toHaveBeenCalled();
    expect(deps.attestor.supported).not.toHaveBeenCalled();
  });
  it("delivers completion only in an app fragment and requires the original signed-in wallet to link", async () => {
    const sessions = createSessions("test-session-secret".repeat(3));
    const db = store();
    const oauth = createXOAuth({ clientId: "test", redirectUri: "https://api.example.test/v1/author/callback" }, db.api,
      async (url) => String(url).includes("oauth2/token") ? response({ access_token: "test" }) : response({ data: { id: authorId, username: "frog", name: "Frog" } }));
    const state = new URL(await oauth.connect(wallet, "https://memefun.example.test/portfolio?authorLinked=1")).searchParams.get("state")!;
    const deps = { sessions, store: db.api, oauth, origins: new Set(["https://memefun.example.test"]) } as unknown as AuthorDeps;
    const app = new Hono().route("/", authorRoutes(deps));
    app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    const callback = await app.request(`/v1/author/callback?code=test&state=${state}`);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location")!);
    expect(location.origin).toBe("https://memefun.example.test");
    expect(location.searchParams.has("authorCompletion")).toBe(false);
    expect(location.searchParams.has("authorLinked")).toBe(false);
    const completion = new URLSearchParams(location.hash.slice(1)).get("authorCompletion")!;
    expect(completion).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await db.api.author(wallet)).toBeNull();
    const complete = (owner: typeof wallet | typeof coin) => app.request("/v1/author/complete", { method: "POST", headers: { authorization: `Bearer ${sessions.issue(owner).token}`, "content-type": "application/json" }, body: JSON.stringify({ token: completion, wallet: coin }) });
    const wrongWallet = await complete(coin);
    expect(wrongWallet.status).toBe(403);
    expect(await wrongWallet.json()).toMatchObject({ error: "x_oauth_completion_wallet_mismatch" });
    expect(await db.api.author(wallet)).toBeNull();
    expect((await complete(wallet)).status).toBe(200);
    expect(await db.api.author(wallet)).toMatchObject({ id: authorId });
    const replay = await complete(wallet);
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ error: "x_oauth_completion_expired" });
  });
  it("signs only for the session wallet and rejects another X account or a stale identity", async () => {
    const sessions = createSessions("test-session-secret".repeat(3));
    const token = sessions.issue(wallet).token;
    const db = store().api;
    await db.saveAuthor(wallet, { id: authorId, handle: "frog", name: "Frog" });
    const launch = vi.fn(async () => ({ deadline: "1300", signature: "0x1234" }));
    const verification = vi.fn(async () => ({ deadline: "1300", signature: "0x1234" }));
    const deps = { sessions, store: db, deployment: { chainId: 84532, factory: coin, feeVault: coin },
      oauth: { configured: () => true },
      provider: { import: async () => ({ postId, author: { id: authorId, handle: "frog", name: "Frog" }, url: `https://x.com/frog/status/${postId}`, text: "Frog" }) },
      attestor: { supported: async () => true, launch, verification, attribution: async () => ({ postId, authorXUserId: "different-author", verifyBy: 2000n, verifiedWallet: zeroAddress }) } } as unknown as AuthorDeps;
    const app = new Hono().route("/", authorRoutes(deps));
    app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    const salt = `0x${"22".repeat(32)}`;
    const req = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const attestation = await req("/v1/tweets/attestation", { url: `https://x.com/frog/status/${postId}`, authorShareBps: 5000, salt, launcher: coin, authorXUserId: "fake" });
    expect(attestation.status).toBe(200);
    expect(launch).toHaveBeenCalledWith({ launcher: wallet, salt, postId, authorXUserId: authorId, authorShareBps: 5000 });
    const mismatch = await req("/v1/author/verification", { coin, wallet: coin, authorXUserId: "fake" });
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({ error: "x_author_mismatch" });
    expect(verification).not.toHaveBeenCalled();
    db.author = async () => ({ id: authorId, handle: "frog", name: "Frog", verifiedAt: new Date(Date.now() - 16 * 60_000).toISOString() });
    const stale = await req("/v1/author/verification", { coin });
    expect(await stale.json()).toMatchObject({ error: "x_author_verification_stale" });
    expect(verification).not.toHaveBeenCalled();
  });
  it("keeps live tweet launch disabled until authors have a configured X verification path", async () => {
    const sessions = createSessions("test-session-secret".repeat(3));
    const provider = { import: vi.fn(async (_url: string, supported: boolean) => ({ postId, authorFeesSupported: supported })) };
    const attestor = { supported: vi.fn(async () => true), launch: vi.fn() };
    const deps = { sessions, store: store().api, provider, attestor, ipSalt: "test-only", oauth: { configured: () => false } } as unknown as AuthorDeps;
    const app = new Hono().route("/", authorRoutes(deps));
    app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    const body = { url: `https://x.com/frog/status/${postId}`, authorShareBps: 5000, salt: `0x${"22".repeat(32)}` };
    const imported = await app.request("/v1/tweets/import", { method: "POST", body: JSON.stringify(body) });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ authorFeesSupported: false });
    const signed = await app.request("/v1/tweets/attestation", { method: "POST", headers: { authorization: `Bearer ${sessions.issue(wallet).token}` }, body: JSON.stringify(body) });
    expect(signed.status).toBe(503);
    expect(await signed.json()).toMatchObject({ error: "x_oauth_unavailable" });
    expect(provider.import).toHaveBeenCalledTimes(1);
    expect(attestor.supported).not.toHaveBeenCalled();
    expect(attestor.launch).not.toHaveBeenCalled();
  });
});

describe("tweet creator share accounting", () => {
  it("conserves odd fees at 20%, 50%, and 100% without mixing quote currencies", () => {
    for (const authorShareBps of [2_000, 5_000, 10_000]) {
      const split = tweetCreatorSplit(100_003n, { authorShareBps });
      expect(split.launcher + split.author).toBe(100_003n);
      expect(split.author).toBe(100_003n * BigInt(authorShareBps) / 10_000n);
    }
  });
  it("can allocate every creator fee to the author without changing untweeted coins", () => {
    expect(tweetCreatorSplit(100n, { authorShareBps: 10_000 })).toEqual({ launcher: 0n, author: 100n });
    expect(tweetCreatorSplit(100n, null)).toEqual({ launcher: 100n, author: 0n });
    expect(() => tweetCreatorSplit(100n, { authorShareBps: 1_999 })).toThrow("Invalid indexed author fee share");
  });
});
