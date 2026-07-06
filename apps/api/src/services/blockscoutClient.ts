type BlockscoutCountersResponse = {
  transactions_count?: unknown;
  token_transfers_count?: unknown;
};

const DEFAULT_BLOCKSCOUT_BASE_URL = "https://api.blockscout.com/8453";
const DEFAULT_MAX_REQUESTS_PER_KEY = 100;
const DEFAULT_MAX_RPS_PER_KEY = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const BLOCKSCOUT_RETRY_STATUS_CODES = new Set([401, 402, 403, 429]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBlockscoutApiKeys() {
  const multiKeyValue = process.env.BLOCKSCOUT_API_KEYS || "";
  const multiKeys = multiKeyValue
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  if (multiKeys.length > 0) {
    return [...new Set(multiKeys)];
  }

  const singleKey = (process.env.BLOCKSCOUT_API_KEY || "").trim();
  return singleKey ? [singleKey] : [];
}

function parseMaxRequestsPerKey() {
  const parsed = Number.parseInt(
    process.env.BLOCKSCOUT_MAX_REQUESTS_PER_KEY || "",
    10
  );

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REQUESTS_PER_KEY;
}

function parseMaxRequestsPerSecondPerKey() {
  const parsed = Number.parseInt(process.env.BLOCKSCOUT_MAX_RPS_PER_KEY || "", 10);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_RPS_PER_KEY;
}

function parseRequestTimeoutMs() {
  const parsed = Number.parseInt(process.env.BLOCKSCOUT_REQUEST_TIMEOUT_MS || "", 10);

  return Number.isFinite(parsed) && parsed >= 1_000
    ? parsed
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export class BlockscoutClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (
      baseUrl ||
      process.env.BLOCKSCOUT_BASE_URL ||
      DEFAULT_BLOCKSCOUT_BASE_URL
    ).replace(/\/+$/, "");
  }
  private readonly apiKeys = parseBlockscoutApiKeys();
  private readonly maxRequestsPerKey = parseMaxRequestsPerKey();
  private readonly maxRequestsPerSecondPerKey = parseMaxRequestsPerSecondPerKey();
  private readonly minRequestIntervalMs = Math.max(
    1,
    Math.ceil(1000 / this.maxRequestsPerSecondPerKey)
  );
  private readonly requestTimeoutMs = parseRequestTimeoutMs();
  private readonly keyQueueTails = new Map<number, Promise<void>>();
  private readonly keyNextReadyAt = new Map<number, number>();
  private currentKeyIndex = 0;
  private currentKeyRequestCount = 0;

  private takeApiKey() {
    if (this.apiKeys.length === 0) {
      throw new Error(
        "Blockscout fallback is not configured. Set BLOCKSCOUT_API_KEYS or BLOCKSCOUT_API_KEY."
      );
    }

    if (this.currentKeyRequestCount >= this.maxRequestsPerKey) {
      this.rotateToNextKey();
    }

    const keyIndex = this.currentKeyIndex;
    const apiKey = this.apiKeys[keyIndex];
    this.currentKeyRequestCount += 1;

    return { apiKey, keyIndex };
  }

  private rotateToNextKey() {
    if (this.apiKeys.length === 0) {
      this.currentKeyIndex = 0;
      this.currentKeyRequestCount = 0;
      return;
    }

    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    this.currentKeyRequestCount = 0;
  }

  private rotatePastKey(keyIndex: number) {
    if (this.apiKeys.length === 0) {
      this.currentKeyIndex = 0;
      this.currentKeyRequestCount = 0;
      return;
    }

    this.currentKeyIndex = (keyIndex + 1) % this.apiKeys.length;
    this.currentKeyRequestCount = 0;
  }

  private async waitForKeySlot(keyIndex: number) {
    const previous = this.keyQueueTails.get(keyIndex) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.keyQueueTails.set(keyIndex, tail);

    await previous.catch(() => undefined);

    try {
      const now = Date.now();
      const nextReadyAt = this.keyNextReadyAt.get(keyIndex) ?? now;
      const waitMs = Math.max(0, nextReadyAt - now);

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      this.keyNextReadyAt.set(keyIndex, Date.now() + this.minRequestIntervalMs);
    } finally {
      releaseCurrent();
    }
  }

  async getAddressCounters(address: string): Promise<BlockscoutCountersResponse> {
    if (this.apiKeys.length === 0) {
      throw new Error(
        "Blockscout fallback is not configured. Set BLOCKSCOUT_API_KEYS or BLOCKSCOUT_API_KEY."
      );
    }

    const failedStatuses: string[] = [];

    for (let attempts = 0; attempts < this.apiKeys.length; attempts += 1) {
      const { apiKey, keyIndex } = this.takeApiKey();
      await this.waitForKeySlot(keyIndex);
      let response: Response;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        response = await fetch(
          `${this.baseUrl}/api/v2/addresses/${address}/counters?apikey=${encodeURIComponent(
            apiKey
          )}`,
          {
            headers: {
              Accept: "application/json",
            },
            signal: controller.signal,
          }
        );
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(
            `Blockscout counters request timed out after ${this.requestTimeoutMs}ms`
          );
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new Error(`Blockscout counters request failed: ${message}`);
      }

      clearTimeout(timeoutId);

      if (response.ok) {
        return (await response.json()) as BlockscoutCountersResponse;
      }

      if (!BLOCKSCOUT_RETRY_STATUS_CODES.has(response.status)) {
        throw new Error(`Blockscout counters request failed with ${response.status}`);
      }

      failedStatuses.push(`key #${keyIndex + 1}: ${response.status}`);
      this.rotatePastKey(keyIndex);
    }

    throw new Error(
      `All configured Blockscout API keys failed for the counters endpoint (${failedStatuses.join(
        ", "
      )})`
    );
  }
}

export const blockscoutClient = new BlockscoutClient();

// Per-chain instances. chainId 8453 returns the existing default instance (env override
// BLOCKSCOUT_BASE_URL still applies to it); other chains use BLOCKSCOUT_BASE_URL_<chainId>
// or the canonical https://api.blockscout.com/<chainId> host. Keys are shared across chains.
const chainClients = new Map<number, BlockscoutClient>();

export function getBlockscoutClient(chainId: number): BlockscoutClient {
  if (chainId === 8453) return blockscoutClient;
  let client = chainClients.get(chainId);
  if (!client) {
    client = new BlockscoutClient(
      process.env[`BLOCKSCOUT_BASE_URL_${chainId}`] || `https://api.blockscout.com/${chainId}`,
    );
    chainClients.set(chainId, client);
  }
  return client;
}
