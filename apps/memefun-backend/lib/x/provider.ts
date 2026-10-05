import { HttpError } from "../../api/http";
import { type TweetImport, normalizeTweetResponse, parseTweetUrl } from "../../shared/core/tweet";
import { readXJson } from "./http";
import type { XStore } from "./store";

export function createTweetProvider(config: { apiKey: string; maxCallsPerHour?: number; dailyLimit?: number } | null, store: XStore, fetchFn: typeof fetch = fetch) {
  const inflight = new Map<string, Promise<TweetImport>>();
  const dailyLimit = Number.isFinite(config?.dailyLimit) ? Math.max(0, Math.min(10_000, Math.floor(config!.dailyLimit!))) : 100;
  return {
    async import(url: string, authorFeesSupported = false): Promise<TweetImport> {
      let parsed: ReturnType<typeof parseTweetUrl>;
      try { parsed = parseTweetUrl(url); }
      catch (error) { throw new HttpError(422, "tweet_url_invalid", error instanceof Error ? error.message : "Use a public X post link."); }
      if (!config?.apiKey) throw new HttpError(503, "tweet_import_unavailable", "Public X post import is not configured yet.");
      const cached = await store.cachedPost<TweetImport>(parsed.postId);
      if (cached) return { ...cached, authorFeesSupported };
      let pending = inflight.get(parsed.postId);
      if (!pending) {
        pending = (async () => {
          // Reserve the shared budget before any provider call, including failed reads. Cached
          // responses cost no provider read. This counter survives restarts and spans replicas.
          if (!await store.quota("getx:provider:daily", dailyLimit, 86_400)) {
            throw new HttpError(429, "tweet_provider_daily_quota", "Today's X import budget is used up. Try tomorrow or create a coin manually.");
          }
          if (!await store.quota("getx:provider", config.maxCallsPerHour ?? 1_000, 3_600)) {
            throw new HttpError(429, "tweet_provider_quota", "X import has reached its hourly limit. Try again later.");
          }
          let response: Response;
          try {
            response = await fetchFn(`https://api.getxapi.com/twitter/tweet/detail?id=${parsed.postId}`, {
              headers: { Accept: "application/json", Authorization: `Bearer ${config.apiKey}` },
              redirect: "error", signal: AbortSignal.timeout(8_000),
            });
          } catch { throw new HttpError(503, "tweet_provider_unavailable", "The X post provider is unavailable. Try again shortly."); }
          if (!response.ok) {
            if (response.status === 404) throw new HttpError(404, "tweet_not_found", "That public X post could not be found.");
            throw new HttpError(503, "tweet_provider_unavailable", "The X post provider is unavailable. Try again shortly.");
          }
          const payload = await readXJson(response);
          let result: TweetImport;
          try { result = normalizeTweetResponse(payload, parsed.postId); }
          catch (error) { throw new HttpError(422, "tweet_unverified", error instanceof Error ? error.message : "That X post could not be verified."); }
          await store.cachePost(parsed.postId, result, 3_600);
          return result;
        })().finally(() => inflight.delete(parsed.postId));
        inflight.set(parsed.postId, pending);
      }
      return { ...await pending, authorFeesSupported };
    },
  };
}
export type TweetProvider = ReturnType<typeof createTweetProvider>;
