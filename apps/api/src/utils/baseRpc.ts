const BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";
const DEFAULT_ROTATION_CALLS = 100;

let activeIndex = 0;
let activeCalls = 0;
let requestId = 1;

function splitEnv(value?: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function isHttpsUrl(value: string) {
  return value.startsWith("https://");
}

function getRotationCalls() {
  const parsed = Number(process.env.BASE_RPC_ROTATION_CALLS || DEFAULT_ROTATION_CALLS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_ROTATION_CALLS;
}

export function getBaseRpcUrls() {
  const explicitUrls = [
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_URLS),
    ...splitEnv(process.env.BASE_RPC_URLS),
    ...splitEnv(process.env.ALCHEMY_BASE_RPC),
    ...splitEnv(process.env.BASE_RPC_URL),
  ];
  const alchemyKeys = [
    ...splitEnv(process.env.ALCHEMY_BASE_RPC_KEYS),
    ...splitEnv(process.env.ALCHEMY_API_KEYS),
    ...splitEnv(process.env.ALCHEMY_API_KEY),
  ];
  const alchemyUrls = alchemyKeys.map(
    (key) => `https://base-mainnet.g.alchemy.com/v2/${key}`,
  );
  const urls = unique([...explicitUrls, ...alchemyUrls].filter(isHttpsUrl));

  return urls.length > 0 ? urls : [BASE_PUBLIC_RPC_URL];
}

export function getRotatingBaseRpcUrl() {
  const urls = getBaseRpcUrls();
  if (urls.length === 1) return urls[0];

  const url = urls[activeIndex % urls.length];
  activeCalls += 1;

  if (activeCalls >= getRotationCalls()) {
    activeCalls = 0;
    activeIndex = (activeIndex + 1) % urls.length;
  }

  return url;
}

function orderedRpcUrls() {
  const urls = getBaseRpcUrls();
  const first = getRotatingBaseRpcUrl();
  return [first, ...urls.filter((url) => url !== first)];
}

export async function baseRpcRequest<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;

  for (const url of orderedRpcUrls()) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId++,
          method,
          params,
        }),
      });

      if (!response.ok) {
        throw new Error(`Base RPC ${response.status}`);
      }

      const payload = (await response.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };

      if (payload.error) {
        const message = payload.error.message || "Base RPC error";
        if (message.toLowerCase().includes("rate") || payload.error.code === 429) {
          throw new Error(message);
        }
        throw new Error(message);
      }

      return payload.result as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError || new Error("Base RPC request failed");
}
