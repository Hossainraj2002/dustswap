import { TweetServiceError, tweetService } from "@/lib/tweet/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { bytes, type } = await tweetService.image(new URL(request.url).searchParams.get("url") ?? "");
    return new Response(bytes as BodyInit, { headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600", "Content-Security-Policy": "default-src 'none'" } });
  } catch (error) {
    const safe = error instanceof TweetServiceError ? error : new TweetServiceError(500, "image_failed", "Could not import this image.");
    return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status, headers: { "Cache-Control": "no-store" } });
  }
}
