import { createHash } from "node:crypto";
import { TweetServiceError, tweetService } from "@/lib/tweet/server";
import { sameImportOrigin } from "@/lib/tweet/origin";

export const runtime = "nodejs";
const requests = new Map<string, { start: number; count: number }>();

export async function POST(request: Request) {
  try {
    if (!sameImportOrigin(request, process.env.NEXT_PUBLIC_APP_URL)) throw new TweetServiceError(403, "origin", "Open memefun to import an X post.");
    const ip = request.headers.get("x-railway-client-ip") || request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    const key = createHash("sha256").update(ip).digest("hex");
    const now = Date.now();
    const previous = requests.get(key);
    const entry = !previous || previous.start + 60_000 <= now ? { start: now, count: 0 } : previous;
    if (entry.count >= 5) throw new TweetServiceError(429, "import_rate_limit", "Too many imports. Wait a minute and try again.");
    if (requests.size >= 1_000) requests.delete(requests.keys().next().value!);
    entry.count += 1;
    requests.set(key, entry);
    // Read incrementally so chunked bodies cannot bypass the limit.
    const { boundedBytes } = await import("@/lib/tweet/server");
    const bytes = await boundedBytes(new Response(request.body), 4_096);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new TweetServiceError(400, "invalid_request", "Send a public X post link."); }
    const url = body && typeof body === "object" && "url" in body ? body.url : undefined;
    if (typeof url !== "string") throw new TweetServiceError(400, "invalid_request", "Send a public X post link.");
    const result = await tweetService.importTweet(url);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const safe = error instanceof TweetServiceError ? error : new TweetServiceError(500, "import_failed", "Could not import this post. Try again later.");
    return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status, headers: { "Cache-Control": "no-store", ...(safe.status === 429 ? { "Retry-After": "60" } : {}) } });
  }
}
