import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../../api/http";
import { validXId } from "../../shared/core/tweet";
import { readXJson } from "./http";
import type { OAuthState, VerifiedAuthor, XStore } from "./store";

export interface XOAuthConfig { clientId: string; clientSecret?: string; redirectUri: string; dailyLimit?: number }
const SCOPES = ["users.read", "tweet.read"];
const TIMEOUT_MS = 8_000;

export function safeAuthorReturnTo(raw: string | undefined, origins: Set<string>): string {
  const fallback = `${[...origins][0] ?? "http://localhost:3100"}/rewards/author`;
  if (!raw) return fallback;
  try {
    const url = new URL(raw, fallback);
    if (!origins.has(url.origin) || url.username || url.password) return fallback;
    return url.toString();
  } catch { return fallback; }
}

/** No user-supplied endpoint and no redirects: secrets go only to official X endpoints. */
export function createXOAuth(config: XOAuthConfig | null, store: XStore, fetchFn: typeof fetch = fetch) {
  const dailyLimit = Number.isFinite(config?.dailyLimit) ? Math.max(0, Math.min(10_000, Math.floor(config!.dailyLimit!))) : 10;
  const required = () => {
    if (!config) throw new HttpError(503, "x_oauth_unavailable", "X author verification is not configured yet.");
    if (dailyLimit === 0) throw new HttpError(503, "x_oauth_budget_disabled", "X author verification is disabled by the daily budget.");
    return config;
  };
  return {
    configured: () => Boolean(config?.clientId && config.redirectUri && dailyLimit > 0),
    async connect(wallet: string, returnTo: string): Promise<string> {
      const conf = required();
      const state = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      await store.putState(state, { wallet, codeVerifier, returnTo, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      const url = new URL("https://x.com/i/oauth2/authorize");
      for (const [key, value] of Object.entries({ response_type: "code", client_id: conf.clientId, redirect_uri: conf.redirectUri,
        scope: SCOPES.join(" "), state, code_challenge: codeChallenge, code_challenge_method: "S256" })) url.searchParams.set(key, value);
      return url.toString();
    },
    async callback(code: string, state: string): Promise<OAuthState & { completionToken: string }> {
      const conf = required();
      if (!state || state.length > 200 || !code || code.length > 2_000) throw new HttpError(400, "x_oauth_invalid", "That X verification request is invalid.");
      const record = await store.consumeState(state);
      if (!record) throw new HttpError(400, "x_oauth_expired", "This X verification request expired or was already used.");
      // A valid OAuth state can reserve one potential users/me read only. Failed flows count
      // conservatively; replayed/expired states cannot trigger another reservation or X call.
      if (!await store.quota("x:author:verify:daily", dailyLimit, 86_400)) {
        throw new HttpError(429, "x_oauth_daily_quota", "Today's X author verification budget is used up. Try again tomorrow.");
      }
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
      if (conf.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${conf.clientId}:${conf.clientSecret}`).toString("base64")}`;
      const tokenResponse = await fetchFn("https://api.x.com/2/oauth2/token", { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: conf.clientId, redirect_uri: conf.redirectUri, code_verifier: record.codeVerifier }).toString() });
      if (!tokenResponse.ok) throw new HttpError(503, "x_oauth_exchange", "X verification could not finish. Try connecting again.");
      const token = await readXJson(tokenResponse) as { access_token?: unknown };
      if (typeof token.access_token !== "string" || !token.access_token) throw new HttpError(503, "x_oauth_exchange", "X did not return an authorization token.");
      const meResponse = await fetchFn("https://api.x.com/2/users/me?user.fields=profile_image_url", {
        headers: { Authorization: `Bearer ${token.access_token}` }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!meResponse.ok) throw new HttpError(503, "x_oauth_identity", "X could not verify your account. Try connecting again.");
      const me = await readXJson(meResponse) as { data?: { id?: unknown; username?: unknown; name?: unknown; profile_image_url?: unknown } };
      if (!validXId(me.data?.id) || typeof me.data?.username !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(me.data.username)) {
        throw new HttpError(503, "x_oauth_identity", "X returned an incomplete account identity.");
      }
      const author: Omit<VerifiedAuthor, "verifiedAt"> = { id: me.data.id, handle: me.data.username,
        name: typeof me.data.name === "string" ? me.data.name.slice(0, 200) : me.data.username };
      if (typeof me.data.profile_image_url === "string") {
        try { const avatar = new URL(me.data.profile_image_url); if (avatar.protocol === "https:" && avatar.hostname === "pbs.twimg.com" && !avatar.username && !avatar.password) author.avatarUrl = avatar.toString(); } catch { /* no avatar */ }
      }
      const completionToken = randomBytes(32).toString("base64url");
      await store.putCompletion(completionToken, { wallet: record.wallet, author, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
      // Tokens are intentionally discarded; identity verification needs no ongoing X access.
      // The browser must prove its signed-in wallet after returning from X. Forwarding an
      // authorization URL cannot link the victim's X identity to the starter's wallet.
      return { ...record, completionToken };
    },
    async complete(token: string, wallet: string): Promise<VerifiedAuthor> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, "x_oauth_completion_invalid", "That X verification completion is invalid.");
      const pending = await store.consumeCompletion(token, wallet);
      if (!pending) {
        const expected = await store.completionWallet(token);
        if (expected && expected.toLowerCase() !== wallet.toLowerCase()) {
          throw new HttpError(403, "x_oauth_completion_wallet_mismatch", "Reconnect the wallet that started this X verification, then retry.");
        }
        throw new HttpError(410, "x_oauth_completion_expired", "This X verification completion expired or was already used. Connect X again.");
      }
      await store.saveAuthor(wallet, pending.author);
      const author = await store.author(wallet);
      if (!author) throw new HttpError(503, "x_oauth_identity", "X identity could not be saved. Try connecting again.");
      return author;
    },
  };
}
export type XOAuth = ReturnType<typeof createXOAuth>;
