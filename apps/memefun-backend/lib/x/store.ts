import { createHash } from "node:crypto";
import { type Queryable, rows } from "../db";
import type { TweetImport } from "../../shared/core/tweet";

export interface VerifiedAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  verifiedAt: string;
}
export interface OAuthState {
  wallet: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: string;
}
export interface OAuthCompletion {
  wallet: string;
  author: Omit<VerifiedAuthor, "verifiedAt">;
  expiresAt: string;
}

export const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");

export function createXStore(db: Queryable) {
  return {
    async putState(state: string, record: OAuthState) {
      await db.query(`INSERT INTO x_oauth_state (state_hash, wallet, code_verifier, return_to, expires_at)
        VALUES ($1, $2, $3, $4, $5)`, [stateHash(state), record.wallet.toLowerCase(), record.codeVerifier, record.returnTo, record.expiresAt]);
    },
    /** DELETE ... RETURNING is a single atomic consume, including when two replicas race. */
    async consumeState(state: string): Promise<OAuthState | null> {
      const [r] = await rows<{ wallet: string; code_verifier: string; return_to: string; expires_at: string }>(db,
        `DELETE FROM x_oauth_state WHERE state_hash = $1 AND expires_at > now()
         RETURNING wallet, code_verifier, return_to, expires_at`, [stateHash(state)]);
      return r ? { wallet: r.wallet, codeVerifier: r.code_verifier, returnTo: r.return_to, expiresAt: new Date(r.expires_at).toISOString() } : null;
    },
    async putCompletion(token: string, record: OAuthCompletion) {
      await db.query(`INSERT INTO x_oauth_completion (token_hash, wallet, author, expires_at)
        VALUES ($1, $2, $3::jsonb, $4)`, [stateHash(token), record.wallet.toLowerCase(), JSON.stringify(record.author), record.expiresAt]);
    },
    /** A wrong wallet cannot consume the token. Concurrent valid completions have one winner. */
    async consumeCompletion(token: string, wallet: string): Promise<OAuthCompletion | null> {
      const [r] = await rows<{ wallet: string; author: OAuthCompletion["author"]; expires_at: string }>(db,
        `DELETE FROM x_oauth_completion WHERE token_hash = $1 AND wallet = $2 AND expires_at > now()
         RETURNING wallet, author, expires_at`, [stateHash(token), wallet.toLowerCase()]);
      return r ? { wallet: r.wallet, author: r.author, expiresAt: new Date(r.expires_at).toISOString() } : null;
    },
    async completionWallet(token: string): Promise<string | null> {
      const [r] = await rows<{ wallet: string }>(db,
        `SELECT wallet FROM x_oauth_completion WHERE token_hash = $1 AND expires_at > now()`, [stateHash(token)]);
      return r?.wallet ?? null;
    },
    async author(wallet: string): Promise<VerifiedAuthor | null> {
      const [r] = await rows<{ x_user_id: string; handle: string; display_name: string; avatar_url: string | null; verified_at: string }>(db,
        `SELECT x_user_id, handle, display_name, avatar_url, verified_at FROM x_author_identity WHERE wallet = $1`, [wallet.toLowerCase()]);
      return r ? { id: r.x_user_id, handle: r.handle, name: r.display_name, ...(r.avatar_url ? { avatarUrl: r.avatar_url } : {}),
        verifiedAt: new Date(r.verified_at).toISOString() } : null;
    },
    async saveAuthor(wallet: string, author: Omit<VerifiedAuthor, "verifiedAt">) {
      await db.query(`INSERT INTO x_author_identity (wallet, x_user_id, handle, display_name, avatar_url)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (wallet) DO UPDATE SET
        x_user_id = EXCLUDED.x_user_id, handle = EXCLUDED.handle, display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url, verified_at = now()`,
        [wallet.toLowerCase(), author.id, author.handle, author.name, author.avatarUrl ?? null]);
    },
    async cachedPost<T>(postId: string): Promise<T | null> {
      const [r] = await rows<{ payload: T }>(db, `SELECT payload FROM x_post_cache WHERE post_id = $1 AND expires_at > now()`, [postId]);
      return r?.payload ?? null;
    },
    async cachePost(postId: string, payload: unknown, ttlSec: number) {
      await db.query(`INSERT INTO x_post_cache (post_id, payload, expires_at) VALUES ($1, $2::jsonb, now() + make_interval(secs => $3))
        ON CONFLICT (post_id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`, [postId, JSON.stringify(payload), ttlSec]);
    },
    async saveSource(source: TweetImport) {
      await db.query(`INSERT INTO x_tweet_source (post_id, author_x_user_id, payload) VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (post_id) DO NOTHING`, [source.postId, source.author.id, JSON.stringify(source)]);
    },
    async source(postId: string): Promise<TweetImport | null> {
      const [r] = await rows<{ payload: TweetImport }>(db, `SELECT payload FROM x_tweet_source WHERE post_id = $1`, [postId]);
      return r?.payload ?? null;
    },
    async quota(key: string, limit: number, windowSec: number, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
      const windowStart = Math.floor(nowSec / windowSec) * windowSec;
      const [r] = await rows<{ count: number }>(db, `INSERT INTO x_request_quota (key, window_start, count, expires_at)
        VALUES ($1, $2::bigint, 1, to_timestamp(($2::bigint + $3::bigint)::double precision)) ON CONFLICT (key, window_start) DO UPDATE
        SET count = CASE WHEN x_request_quota.count <= $4::integer THEN x_request_quota.count + 1
          ELSE x_request_quota.count END RETURNING count`, [key, windowStart, windowSec, limit]);
      return (r?.count ?? limit + 1) <= limit;
    },
    async prune() {
      await db.query(`DELETE FROM x_oauth_state WHERE expires_at <= now()`);
      await db.query(`DELETE FROM x_oauth_completion WHERE expires_at <= now()`);
      await db.query(`DELETE FROM x_request_quota WHERE expires_at <= now()`);
      await db.query(`DELETE FROM x_post_cache WHERE expires_at <= now()`);
    },
  };
}
export type XStore = ReturnType<typeof createXStore>;
