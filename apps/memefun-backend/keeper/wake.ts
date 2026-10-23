import { envInt, optionalEnv } from "../lib/env";
import type { KeeperContext } from "./context";

interface WakeOptions {
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function wakeUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("MEMEFUN_INDEXER_WAKE_URL must be a valid HTTP status URL."); }
  const privateHttp = url.protocol === "http:" && url.hostname.endsWith(".railway.internal");
  if ((url.protocol !== "https:" && !privateHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error("MEMEFUN_INDEXER_WAKE_URL requires HTTPS or private Railway HTTP, without credentials, query or fragment.");
  }
  return url.href;
}

function indexedHeight(value: unknown, chainId: number): bigint | null {
  if (!value || typeof value !== "object") return null;
  const chain = (value as Record<string, unknown>).memefun;
  if (!chain || typeof chain !== "object") return null;
  const record = chain as Record<string, unknown>;
  if (record.id !== chainId || !record.block || typeof record.block !== "object") return null;
  const number = (record.block as Record<string, unknown>).number;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? BigInt(number) : null;
}

/**
 * Economy cron passes wake the on-demand indexer and wait for a fixed chain head
 * before reading indexed balances or publishing rewards. An absent URL keeps
 * the existing always-on deployment behavior. Network errors never expose URLs.
 */
export async function waitForIndexer(
  ctx: Pick<KeeperContext, "chain" | "client" | "log">,
  options: WakeOptions = {},
): Promise<void> {
  const raw = options.url ?? optionalEnv("MEMEFUN_INDEXER_WAKE_URL");
  if (!raw) return;
  const url = wakeUrl(raw);
  const timeoutMs = options.timeoutMs ?? envInt("MEMEFUN_INDEXER_WAKE_TIMEOUT_MS", 600_000, { min: 1_000, max: 900_000 });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new Error("Indexer wake timeout must be between 1 and 900000 milliseconds.");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const request = options.fetch ?? fetch;
  const deadline = now() + timeoutMs;
  let target: bigint;
  let headTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    target = await Promise.race([
      ctx.client.getBlockNumber(),
      new Promise<never>((_, reject) => {
        headTimer = setTimeout(() => reject(new Error("Chain head read timed out.")), Math.min(20_000, timeoutMs));
      }),
    ]);
  }
  catch { throw new Error("Could not read the chain head; keeper pass skipped before indexer wake-up."); }
  finally { if (headTimer !== undefined) clearTimeout(headTimer); }
  ctx.log("keeper.indexer-wake", { chain: ctx.chain.id, targetBlock: target.toString(), timeoutMs });
  let attempts = 0;
  while (now() < deadline) {
    attempts += 1;
    try {
      const response = await request(url, {
        redirect: "error",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - now()))),
      });
      if (response.ok) {
        const height = indexedHeight(await response.json(), ctx.chain.id);
        if (height !== null && height >= target) {
          ctx.log("keeper.indexer-ready", { chain: ctx.chain.id, targetBlock: target.toString(), indexedBlock: height.toString(), attempts });
          return;
        }
      }
    } catch { /* Cold starts, failed reads and malformed responses retry within the same budget. */ }
    const left = deadline - now();
    if (left > 0) await sleep(Math.min(2_000, left));
  }
  ctx.log("keeper.indexer-timeout", { chain: ctx.chain.id, targetBlock: target.toString(), attempts });
  throw new Error("Indexer did not catch up before the wake timeout; keeper pass skipped.");
}
