/**
 * Base App notifications client (Base Dashboard REST API).
 *
 * Docs: https://docs.base.org/apps/technical-guides/base-notifications
 *
 * The Base App stopped honouring the Farcaster mini-app notification spec on
 * 2026-04-09. Notification tokens, per-token callback URLs and Neynar webhooks
 * no longer reach Base App users. The only supported path is this REST API,
 * which is keyed on wallet addresses and authenticated with the Base Dashboard
 * project API key (a different credential from the CDP key).
 *
 * All three endpoints share a single 20 req/min per-IP budget, so every call in
 * this module goes through one process-wide limiter. This must run from the
 * Railway API service, which has a stable egress IP. Running it from the
 * Cloudflare-deployed web app would share a limiter with unrelated tenants.
 */

const API_BASE = "https://dashboard.base.org/api/v1/notifications";

/** Hard caps from the API reference. Exceeding any of these returns a 400. */
export const TITLE_MAX_LENGTH = 30;
export const MESSAGE_MAX_LENGTH = 200;
export const TARGET_PATH_MAX_LENGTH = 500;
export const MAX_ADDRESSES_PER_SEND = 1000;
const AUDIENCE_PAGE_SIZE = 500;

/**
 * Documented ceiling is 20 req/min per IP across all endpoints. We sit under it
 * so a manual admin call or a second worker cannot tip the process into 429s.
 */
const DEFAULT_RATE_LIMIT_PER_MIN = 15;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRY_ATTEMPTS = 3;

export type AudienceUser = {
  address: string;
  notificationsEnabled: boolean;
};

export type SendResult = {
  walletAddress: string;
  sent: boolean;
  failureReason?: string;
};

export type SendResponse = {
  success: boolean;
  results: SendResult[];
  sentCount: number;
  failedCount: number;
};

export type UserStatus = {
  appPinned: boolean;
  notificationsEnabled: boolean;
};

export type NotificationPayload = {
  walletAddresses: string[];
  title: string;
  message: string;
  targetPath?: string | null;
};

/** Thrown for responses that will never succeed on retry (400/401/403/404). */
export class BaseNotificationsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string
  ) {
    super(message);
    this.name = "BaseNotificationsError";
  }
}

function getApiKey() {
  return (process.env.BASE_NOTIFICATIONS_API_KEY || "").trim();
}

function getAppUrl() {
  const configured = (process.env.BASE_NOTIFICATIONS_APP_URL || "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return "https://app.dustswap.wtf";
}

export function isBaseNotificationsConfigured() {
  return Boolean(getApiKey());
}

function getRateLimitPerMinute() {
  const value = Number(
    process.env.BASE_NOTIFICATIONS_RATE_LIMIT_PER_MIN ?? DEFAULT_RATE_LIMIT_PER_MIN
  );

  if (!Number.isFinite(value) || value < 1 || value > 20) {
    return DEFAULT_RATE_LIMIT_PER_MIN;
  }

  return Math.floor(value);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sliding-window limiter over the shared per-IP budget. Serialised through a
 * promise chain so concurrent callers queue instead of racing the window.
 */
class RequestLimiter {
  private timestamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<void> {
    const next = this.tail.then(() => this.waitForSlot());
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async waitForSlot(): Promise<void> {
    const limit = getRateLimitPerMinute();

    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((ts) => now - ts < 60_000);

      if (this.timestamps.length < limit) {
        this.timestamps.push(now);
        return;
      }

      const oldest = this.timestamps[0];
      const waitMs = Math.max(50, 60_000 - (now - oldest));
      await sleep(waitMs);
    }
  }
}

const limiter = new RequestLimiter();

function isRetryableStatus(status: number) {
  // 429 is the shared rate limit, 503 is the documented transient failure on
  // the send endpoint. Everything else is a request we built wrong.
  return status === 429 || status === 503;
}

function describeStatus(status: number, body: string) {
  const detail = body ? ` ${body.slice(0, 300)}` : "";

  switch (status) {
    case 400:
      return `Base notifications rejected the request (400). Check title <= ${TITLE_MAX_LENGTH} chars, message <= ${MESSAGE_MAX_LENGTH} chars, and that target_path starts with a slash.${detail}`;
    case 401:
      return `Base notifications API key is missing or invalid (401).${detail}`;
    case 403:
      return `Base notifications refused this app_url (403). Either it does not belong to your project, or the project is not whitelisted for notifications.${detail}`;
    case 404:
      return `No Base Dashboard project found for this API key (404).${detail}`;
    case 429:
      return `Base notifications rate limit hit (429). Shared budget is 20 req/min per IP.${detail}`;
    case 503:
      return `Base notifications service temporarily unavailable (503).${detail}`;
    default:
      return `Base notifications request failed (${status}).${detail}`;
  }
}

async function request<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown }
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new BaseNotificationsError(
      "BASE_NOTIFICATIONS_API_KEY is not configured",
      0
    );
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    await limiter.acquire();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: init.method,
        headers: {
          "x-api-key": apiKey,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      const text = await response.text().catch(() => "");
      const error = new BaseNotificationsError(
        describeStatus(response.status, text),
        response.status,
        text
      );

      if (!isRetryableStatus(response.status) || attempt === MAX_RETRY_ATTEMPTS) {
        throw error;
      }

      lastError = error;
    } catch (error) {
      if (error instanceof BaseNotificationsError) {
        if (!isRetryableStatus(error.status) || attempt === MAX_RETRY_ATTEMPTS) {
          throw error;
        }
        lastError = error;
      } else {
        // Network error or timeout. Worth one more attempt.
        if (attempt === MAX_RETRY_ATTEMPTS) {
          throw error;
        }
        lastError = error as Error;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Backoff of 2s then 8s. A 429 means the window is already saturated, so
    // waiting on the limiter alone would not clear it.
    await sleep(2_000 * 4 ** (attempt - 1));
  }

  throw lastError ?? new Error("Base notifications request failed");
}

export function normalizeAddress(address: string) {
  return String(address || "").trim().toLowerCase();
}

/**
 * Walks GET /v1/notifications/app/users to completion.
 *
 * Addresses come back EIP-55 checksummed; they are lowercased here so callers
 * can join straight onto user_wallets.wallet_address without thinking about it.
 */
export async function fetchAudience(
  options: { notificationEnabledOnly?: boolean } = {}
): Promise<AudienceUser[]> {
  const { notificationEnabledOnly = true } = options;
  const collected: AudienceUser[] = [];
  const seen = new Set<string>();
  // A cursor that repeats, or a page count that runs away, would spin this loop
  // forever. It runs inside the scheduler's advisory lock and consumes the
  // shared rate limit, so an unbounded loop would wedge every campaign behind
  // it rather than just failing. Both guards below stop that.
  const seenCursors = new Set<string>();
  const MAX_PAGES = 4_000; // 2,000,000 wallets at 500 per page.
  let pages = 0;

  let cursor: string | undefined;

  for (;;) {
    const params = new URLSearchParams({
      app_url: getAppUrl(),
      limit: String(AUDIENCE_PAGE_SIZE),
    });

    if (notificationEnabledOnly) {
      params.set("notification_enabled", "true");
    }

    if (cursor) {
      params.set("cursor", cursor);
    }

    const page = await request<{
      success: boolean;
      users?: AudienceUser[];
      nextCursor?: string;
    }>(`/app/users?${params.toString()}`, { method: "GET" });

    for (const user of page.users ?? []) {
      const address = normalizeAddress(user.address);
      if (!address || seen.has(address)) {
        continue;
      }
      seen.add(address);
      collected.push({
        address,
        notificationsEnabled: Boolean(user.notificationsEnabled),
      });
    }

    pages += 1;

    if (!page.nextCursor) {
      return collected;
    }

    if (seenCursors.has(page.nextCursor)) {
      console.warn(
        `[Notifications] Audience pagination repeated cursor after ${pages} page(s). Stopping with ${collected.length} wallet(s).`
      );
      return collected;
    }

    if (pages >= MAX_PAGES) {
      console.warn(
        `[Notifications] Audience pagination hit the ${MAX_PAGES} page ceiling. Stopping with ${collected.length} wallet(s).`
      );
      return collected;
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/**
 * Single-wallet lookup. Cheap enough to call on connect to decide whether to
 * show a "pin DustSwap" prompt.
 */
export async function fetchUserStatus(walletAddress: string): Promise<UserStatus> {
  const response = await request<UserStatus>("/app/user/status", {
    method: "POST",
    body: {
      app_url: getAppUrl(),
      wallet_address: walletAddress,
    },
  });

  return {
    appPinned: Boolean(response.appPinned),
    notificationsEnabled: Boolean(response.notificationsEnabled),
  };
}

export function validatePayload(payload: NotificationPayload) {
  const title = payload.title.trim();
  const message = payload.message.trim();
  const targetPath = payload.targetPath?.trim() || null;

  if (!title) {
    throw new BaseNotificationsError("Notification title is required", 0);
  }

  if (title.length > TITLE_MAX_LENGTH) {
    throw new BaseNotificationsError(
      `Notification title is ${title.length} chars, max is ${TITLE_MAX_LENGTH}: ${title}`,
      0
    );
  }

  if (!message) {
    throw new BaseNotificationsError("Notification message is required", 0);
  }

  if (message.length > MESSAGE_MAX_LENGTH) {
    throw new BaseNotificationsError(
      `Notification message is ${message.length} chars, max is ${MESSAGE_MAX_LENGTH}`,
      0
    );
  }

  if (targetPath) {
    if (!targetPath.startsWith("/")) {
      throw new BaseNotificationsError(
        `Notification target path must start with a slash, got ${targetPath}`,
        0
      );
    }

    if (targetPath.length > TARGET_PATH_MAX_LENGTH) {
      throw new BaseNotificationsError(
        `Notification target path is ${targetPath.length} chars, max is ${TARGET_PATH_MAX_LENGTH}`,
        0
      );
    }
  }

  return { title, message, targetPath };
}

export function chunkAddresses(addresses: string[], size = MAX_ADDRESSES_PER_SEND) {
  const chunks: string[][] = [];

  for (let i = 0; i < addresses.length; i += size) {
    chunks.push(addresses.slice(i, i + size));
  }

  return chunks;
}

/**
 * POST /v1/notifications/send for one batch of up to 1,000 addresses.
 *
 * Note on deduplication: Base silently swallows an identical notification
 * (same app_url + wallet + title + message + target_path) inside a 24h window
 * and still returns success. Recurring campaigns must vary their copy or they
 * will report delivery while reaching nobody.
 */
export async function sendNotificationBatch(
  payload: NotificationPayload
): Promise<SendResponse> {
  const { title, message, targetPath } = validatePayload(payload);

  const addresses = Array.from(
    new Set(payload.walletAddresses.map((address) => address.trim()).filter(Boolean))
  );

  if (!addresses.length) {
    return { success: true, results: [], sentCount: 0, failedCount: 0 };
  }

  if (addresses.length > MAX_ADDRESSES_PER_SEND) {
    throw new BaseNotificationsError(
      `sendNotificationBatch received ${addresses.length} addresses, max is ${MAX_ADDRESSES_PER_SEND}. Use sendNotifications instead.`,
      0
    );
  }

  const response = await request<SendResponse>("/send", {
    method: "POST",
    body: {
      app_url: getAppUrl(),
      wallet_addresses: addresses,
      title,
      message,
      ...(targetPath ? { target_path: targetPath } : {}),
    },
  });

  return {
    success: Boolean(response.success),
    results: response.results ?? [],
    sentCount: Number(response.sentCount || 0),
    failedCount: Number(response.failedCount || 0),
  };
}

/** Chunks an arbitrarily large address list across as many sends as needed. */
export async function sendNotifications(
  payload: NotificationPayload
): Promise<SendResponse> {
  const chunks = chunkAddresses(payload.walletAddresses);
  const aggregate: SendResponse = {
    success: true,
    results: [],
    sentCount: 0,
    failedCount: 0,
  };

  for (const chunk of chunks) {
    const batch = await sendNotificationBatch({ ...payload, walletAddresses: chunk });
    aggregate.results.push(...batch.results);
    aggregate.sentCount += batch.sentCount;
    aggregate.failedCount += batch.failedCount;
    aggregate.success = aggregate.success && batch.success;
  }

  return aggregate;
}

export const baseNotificationsConfig = {
  getAppUrl,
  getRateLimitPerMinute,
};
