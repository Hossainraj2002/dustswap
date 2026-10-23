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
const READ_TIMEOUT_MS = 45_000;
const READ_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 5_000;
const WAKING_MESSAGE = "MemeFun is waking up. Please try again in a moment.";
const WAKING_CODES = new Set(["api_warming", "api_busy", "api_unavailable", "api_stopping"]);

const gatewayStatus = (status: number) => status === 502 || status === 503 || status === 504;

async function readResponse(response: Response, waking = false): Promise<{ body: unknown; error?: ApiError; retryable: boolean }> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: Record<string, string> } } | null)?.error;
    const unstructuredGateway = waking && gatewayStatus(response.status) && !error?.code && !error?.message;
    return { body, retryable: waking && gatewayStatus(response.status) && (unstructuredGateway || WAKING_CODES.has(error?.code ?? "")), error: new ApiError(
      response.status,
      error?.code ?? (unstructuredGateway ? "server_warming" : `http_${response.status}`),
      error?.message ?? (unstructuredGateway ? WAKING_MESSAGE : response.status >= 500 ? "The memefun server had a problem. Try again." : "The request did not go through."),
      error?.details,
    ) };
  }
  return { body, retryable: false };
}

async function parse<T>(response: Response): Promise<T> {
  const result = await readResponse(response);
  if (result.error) throw result.error;
  return result.body as T;
}

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("The request was aborted.", "AbortError");
}

/** Explicit disposal also removes the caller's listener after a successful request. */
function deadline(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal ? abortReason(signal) : undefined);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = controller.signal.aborted ? undefined : setTimeout(() => {
    controller.abort(new DOMException("The request timed out.", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

function retryDelay(response: Response, retry: number) {
  const backoff = (retry + 1) * 1_000;
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return backoff;
  const requested = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1_000 : Date.parse(raw) - Date.now();
  return Number.isFinite(requested) && requested > 0
    ? Math.max(backoff, Math.min(requested, MAX_RETRY_DELAY_MS)) : backoff;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortReason(signal)); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
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
      // Only explicit authenticated reads add headers; anonymous reads keep simple CORS.
      // Retry gateway responses while a sleeping origin wakes, never writes or network failures.
      const total = deadline(READ_TIMEOUT_MS, init.signal);
      try {
        for (let retry = 0; ; retry++) {
          const attempt = deadline(TIMEOUT_MS, total.signal);
          let delay = 0;
          try {
            if (attempt.signal.aborted) throw abortReason(attempt.signal);
            const response = await fetchFn(url(path), { signal: attempt.signal, ...(init.adminToken || init.token ? { headers: headers(init) } : {}) });
            if (attempt.signal.aborted) throw abortReason(attempt.signal);
            const result = await readResponse(response, true);
            if (attempt.signal.aborted) throw abortReason(attempt.signal);
            if (!result.error) return result.body as T;
            // Business errors remain immediate and fail closed; only infrastructure wake/busy
            // codes or unstructured gateway responses can trigger another read.
            if (!result.retryable || retry >= READ_RETRIES) throw result.error;
            delay = retryDelay(response, retry);
          } finally { attempt.dispose(); }
          await pause(delay, total.signal);
        }
      } finally { total.dispose(); }
    },
    async post<T>(path: string, body: unknown, auth?: { token?: string; adminToken?: string }) {
      const request = deadline(TIMEOUT_MS);
      try {
        return await parse<T>(await fetchFn(url(path), {
          method: "POST",
          headers: { "content-type": "application/json", ...headers(auth) },
          body: JSON.stringify(body),
          signal: request.signal,
        }));
      } finally { request.dispose(); }
    },
    async upload<T>(path: string, file: Blob, filename: string, auth?: { token?: string }) {
      const form = new FormData();
      form.append("file", file, filename);
      const request = deadline(TIMEOUT_MS);
      try {
        return await parse<T>(await fetchFn(url(path), { method: "POST", headers: headers(auth), body: form, signal: request.signal }));
      } finally { request.dispose(); }
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
