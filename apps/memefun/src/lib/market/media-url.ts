import { API_URL } from "@/lib/live/config";

const LEGACY_MEDIA_ORIGIN = "https://memefun-api-production.up.railway.app";
const CONTENT_PATH = /^\/media\/(?:b[a-z2-7]{20,100}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

/** Render old immutable uploads through the current API/CDN without changing their metadata. */
export function mediaImageUrl(value?: string, apiUrl = API_URL): string | undefined {
  if (!value || !apiUrl) return value;
  try {
    const image = new URL(value);
    if (image.origin !== LEGACY_MEDIA_ORIGIN || image.username || image.password || !CONTENT_PATH.test(image.pathname)) return value;
    const target = new URL(apiUrl);
    if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password || target.search || target.hash) return value;
    return `${apiUrl.replace(/\/+$/, "")}${image.pathname}${image.search}${image.hash}`;
  } catch {
    return value;
  }
}
