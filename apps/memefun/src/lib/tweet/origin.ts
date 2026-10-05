/** Next may build request.url with its listen address behind a proxy. */
export function sameImportOrigin(request: Request, publicAppUrl?: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) return false;
  const requestUrl = new URL(request.url);
  if (origin === requestUrl.origin) return true;
  // Host belongs to this request; never accept a caller-supplied forwarded host.
  const host = request.headers.get("host");
  if (host && parsed.host === host && parsed.protocol === requestUrl.protocol) return true;
  try { return !!publicAppUrl && origin === new URL(publicAppUrl).origin; } catch { return false; }
}
