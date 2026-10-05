import { HttpError } from "../../api/http";

/** Bound provider responses independently of Content-Length and never echo provider bodies. */
export async function readXJson(response: Response, limit = 256 * 1024): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) throw new HttpError(503, "x_response_invalid", "X returned an oversized response.");
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(503, "x_response_invalid", "X returned no data.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(503, "x_response_invalid", "X returned an oversized response."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(503, "x_response_invalid", "X returned unreadable data."); }
}
