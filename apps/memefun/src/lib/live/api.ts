/**
 * The memefun backend's HTTP API. Reads are plain GETs: the API sends short Cache-Control lifetimes
 * and ETags, so the browser's own cache answers repeats and revalidates for free (no custom
 * headers, so no CORS preflight). Writes carry a SIWE session token or the admin token.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  readonly baseUrl: string;
  get<T>(path: string, init?: { signal?: AbortSignal; adminToken?: string; token?: string }): Promise<T>;
  post<T>(path: string, body: unknown, auth?: { token?: string; adminToken?: string }): Promise<T>;
  upload<T>(path: string, file: Blob, filename: string, auth?: { token?: string }): Promise<T>;
}

const TIMEOUT_MS = 15_000;

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: Record<string, string> } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? (response.status >= 500 ? "The memefun server had a problem. Try again." : "The request did not go through."),
      error?.details,
    );
  }
  return body as T;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal && "any" in AbortSignal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createApi(baseUrl: string, fetchFn: typeof fetch = (...args) => fetch(...args)): ApiClient {
  const url = (path: string) => `${baseUrl}${path}`;
  const headers = (auth?: { token?: string; adminToken?: string }) => ({
    ...(auth?.token ? { authorization: `Bearer ${auth.token}` } : {}),
    ...(auth?.adminToken ? { "x-admin-token": auth.adminToken } : {}),
  });
  return {
    baseUrl,
    async get<T>(path: string, init: { signal?: AbortSignal; adminToken?: string; token?: string } = {}) {
      // Only admin reads carry a header (and so a CORS preflight); everything else stays simple.
      return parse<T>(
        await fetchFn(url(path), { signal: withTimeout(init.signal), ...(init.adminToken || init.token ? { headers: headers(init) } : {}) }),
      );
    },
    async post<T>(path: string, body: unknown, auth?: { token?: string; adminToken?: string }) {
      return parse<T>(
        await fetchFn(url(path), {
          method: "POST",
          headers: { "content-type": "application/json", ...headers(auth) },
          body: JSON.stringify(body),
          signal: withTimeout(),
        }),
      );
    },
    async upload<T>(path: string, file: Blob, filename: string, auth?: { token?: string }) {
      const form = new FormData();
      form.append("file", file, filename);
      return parse<T>(await fetchFn(url(path), { method: "POST", headers: headers(auth), body: form, signal: withTimeout() }));
    },
  };
}

/** A data URL (the prepared coin image) as a Blob for upload. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("The image could not be read. Add it again.");
  const [, type, base64, payload] = match;
  if (!base64) return new Blob([decodeURIComponent(payload ?? "")], { type });
  const binary = atob(payload ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}
