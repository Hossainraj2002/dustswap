import { type Address, type Hex, type PublicClient, getAddress, parseEventLogs } from "viem";
import { HttpError } from "../../api/http";
import { memeFunFactoryAbi } from "../../shared/abis";
import type { Deployment } from "../deployment";
import type { PlatformTokenConfig } from "./config";
import type { PlatformLaunch, PlatformPin, PlatformTokenStore } from "./store";

export type PlatformTokenSummary = { enabled: false } | { enabled: true; launchAt: string; launcher: Address; tokenAddress: Address | null };
// Three Base confirmations give prompt identification. This is NOT the reward campaign's
// finalized eligibility gate. Every cached pin is rechecked against its canonical receipt.
export const PLATFORM_TOKEN_CONFIRMATIONS = 3n;
const unavailable = () => new HttpError(503, "platform_token_unavailable", "Official token information is unavailable. Try again later.");
const pinned = () => new HttpError(409, "platform_token_pinned", "The official platform token has already been selected.");

export function createPlatformToken(config: PlatformTokenConfig | null, client: PublicClient, deployment: Deployment, store: PlatformTokenStore) {
  const scope = { chainId: deployment.chainId, factory: deployment.factory };
  const configured = () => config !== null && deployment.chainId === 8453;
  let cache: { at: number; value: PlatformTokenSummary } | undefined;
  let refreshing: Promise<PlatformTokenSummary> | undefined;
  const checkChain = async () => { if (await client.getChainId() !== scope.chainId) throw unavailable(); };
  const canonical = async (value: PlatformLaunch, head: bigint, expectedBlockHash?: Hex): Promise<PlatformPin | null> => {
    if (!config || value.launcher.toLowerCase() !== config.launcher.toLowerCase() || head < value.launchBlock + PLATFORM_TOKEN_CONFIRMATIONS - 1n) return null;
    const receipt = await client.getTransactionReceipt({ hash: value.txHash });
    if (receipt.status !== "success" || receipt.blockNumber !== value.launchBlock) return null;
    const block = await client.getBlock({ blockNumber: value.launchBlock });
    if (receipt.blockHash !== block.hash || (expectedBlockHash && block.hash !== expectedBlockHash)) return null;
    const events = parseEventLogs({ abi: memeFunFactoryAbi, eventName: "Launched",
      logs: receipt.logs.filter(log => log.address.toLowerCase() === scope.factory.toLowerCase()) });
    const found = events.find(log => log.logIndex === value.logIndex && log.args.coin.toLowerCase() === value.coin.toLowerCase()
      && log.args.creator.toLowerCase() === config.launcher.toLowerCase() && log.args.contractURI === value.contractURI);
    return found && block.hash ? { ...value, blockHash: block.hash } : null;
  };
  const resolve = async (): Promise<PlatformTokenSummary> => {
    if (!configured() || !config) return { enabled: false };
    const result: PlatformTokenSummary = { enabled: true, ...config, tokenAddress: null };
    try {
      await checkChain();
      const head = await client.getBlock();
      const existing = await store.pin(scope);
      if (existing) {
        // A disappeared/replaced receipt never frees the immutable official slot.
        if (await canonical(existing, head.number, existing.blockHash)) result.tokenAddress = existing.coin;
        return result;
      }
      if (head.number < PLATFORM_TOKEN_CONFIRMATIONS - 1n) return result;
      const through = head.number - PLATFORM_TOKEN_CONFIRMATIONS + 1n;
      if (!await store.ready(scope.chainId, through)) return result;
      const candidate = await store.candidate(scope, through, config.launcher);
      if (!candidate) return result;
      const verified = await canonical(candidate, head.number);
      if (!verified) return result;
      const saved = await store.register(scope, verified);
        if ((saved.coin.toLowerCase() === verified.coin.toLowerCase() && saved.blockHash === verified.blockHash)
        || await canonical(saved, head.number, saved.blockHash)) result.tokenAddress = saved.coin;
      return result;
    } catch { throw unavailable(); }
  };
  return {
    configured,
    async summary(): Promise<PlatformTokenSummary> {
      if (cache && Date.now() - cache.at < 5_000) return cache.value;
      refreshing ??= resolve().then(value => { cache = { at: Date.now(), value }; return value; }).finally(() => { refreshing = undefined; });
      return refreshing;
    },
    async prepare(wallet: Address, salt: Hex, contractURI: string) {
      if (!configured() || !config) throw unavailable();
      if (wallet.toLowerCase() !== config.launcher.toLowerCase()) throw new HttpError(403, "platform_token_launcher", "Only the designated launcher can select the official token.");
      try {
        await checkChain();
        const existingPin = await store.pin(scope);
        const existing = await store.intent(scope, salt);
        if (existing && (existing.contractURI !== contractURI || existing.launcher.toLowerCase() !== config.launcher.toLowerCase())) throw new HttpError(409, "platform_token_intent_conflict", "This launch salt was prepared with different metadata.");
        if (existingPin) {
          if (existing && existing.coin.toLowerCase() === existingPin.coin.toLowerCase()) return { ...existing, created: false };
          throw pinned();
        }
        if (existing) return { ...existing, created: false };
        const head = await client.getBlock();
        const coin = getAddress(await client.readContract({ address: scope.factory, abi: memeFunFactoryAbi, functionName: "predictCoin", args: [config.launcher, salt], blockNumber: head.number }));
        const code = await client.getCode({ address: coin, blockTag: "latest" });
        if (code && code !== "0x") throw new HttpError(409, "platform_token_exists", "Select the official token before creating it.");
        const saved = await store.prepare(scope, { coin, launcher: config.launcher, salt, contractURI, afterBlock: head.number });
        if (saved.state === "pinned") throw pinned();
        if (saved.state === "conflict") throw new HttpError(409, "platform_token_intent_conflict", "This launch was prepared with different metadata.");
        cache = undefined;
        return { ...saved.intent, created: saved.state === "created" };
      } catch (error) { if (error instanceof HttpError) throw error; throw unavailable(); }
    },
    quota: store.quota,
  };
}
export type PlatformTokenService = ReturnType<typeof createPlatformToken>;
