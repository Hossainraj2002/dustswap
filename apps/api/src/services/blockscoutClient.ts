type BlockscoutCountersResponse = {
  transactions_count?: unknown;
  token_transfers_count?: unknown;
};

const DEFAULT_BLOCKSCOUT_BASE_URL = "https://api.blockscout.com/8453";
const DEFAULT_MAX_REQUESTS_PER_KEY = 100;
const BLOCKSCOUT_RETRY_STATUS_CODES = new Set([401, 402, 403, 429]);

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

export class BlockscoutClient {
  private readonly baseUrl = (
    process.env.BLOCKSCOUT_BASE_URL || DEFAULT_BLOCKSCOUT_BASE_URL
  ).replace(/\/+$/, "");
  private readonly apiKeys = parseBlockscoutApiKeys();
  private readonly maxRequestsPerKey = parseMaxRequestsPerKey();
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

  async getAddressCounters(address: string): Promise<BlockscoutCountersResponse> {
    if (this.apiKeys.length === 0) {
      throw new Error(
        "Blockscout fallback is not configured. Set BLOCKSCOUT_API_KEYS or BLOCKSCOUT_API_KEY."
      );
    }

    const failedStatuses: string[] = [];

    for (let attempts = 0; attempts < this.apiKeys.length; attempts += 1) {
      const { apiKey, keyIndex } = this.takeApiKey();
      let response: Response;

      try {
        response = await fetch(
          `${this.baseUrl}/api/v2/addresses/${address}/counters?apikey=${encodeURIComponent(
            apiKey
          )}`,
          {
            headers: {
              Accept: "application/json",
            },
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new Error(`Blockscout counters request failed: ${message}`);
      }

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
