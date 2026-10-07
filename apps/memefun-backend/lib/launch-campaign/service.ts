import { type Address, type PublicClient, erc20Abi, getAddress, parseAbi, zeroAddress } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { HttpError } from "../../api/http";
import { LAUNCH_CAMPAIGN_DOMAIN_NAME, LAUNCH_CAMPAIGN_TYPES, type LaunchCampaignClaimTicket, type LaunchCampaignSummary, type LaunchCampaignWalletStatus } from "../../shared/core/campaign";
import type { Deployment } from "../deployment";
import { campaignLabel, type LaunchCampaignConfig } from "./config";
import type { CampaignLaunch, CampaignStore } from "./store";

export const launchRewardsReadAbi = parseAbi([
  "function rewardToken() view returns (address)", "function tokenDecimals() view returns (uint8)",
  "function rewardAmountRaw() view returns (uint256)", "function campaignSigner() view returns (address)",
  "function launchFactory() view returns (address)", "function activated() view returns (bool)",
  "function startBlock() view returns (uint256)", "function tradeRequiredFromBlock() view returns (uint256)",
  "function claimedCount() view returns (uint256)", "function claimed(address) view returns (bool)",
  "function slotClaimed(uint16) view returns (bool)", "function remainingReserve() view returns (uint256)",
  "function isEnabled() view returns (bool)", "function MAX_RECIPIENTS() view returns (uint256)",
]);

const unavailable = () => new HttpError(503, "campaign_unavailable", "The launch reward campaign is unavailable. Try again later.");
interface CampaignState {
  summary: Extract<LaunchCampaignSummary, { enabled: true }>;
  headBlock: bigint;
  now: bigint;
  finalizedBlock: bigint;
}

export function createLaunchCampaign(config: LaunchCampaignConfig | null, client: PublicClient, deployment: Deployment, store: CampaignStore) {
  let account: PrivateKeyAccount | null = null;
  if (config) { try { account = privateKeyToAccount(config.signerKey); } catch { /* Disabled, never another role's key. */ } }
  let cached: { until: number; state: CampaignState | null } | null = null;
  let pending: Promise<CampaignState | null> | null = null;
  let ranked: { key: string; launches: CampaignLaunch[] } | null = null;

  const readState = async (): Promise<CampaignState | null> => {
    if (!config || !account) return null;
    try {
      const [chainId, head, finalized] = await Promise.all([client.getChainId(), client.getBlock(), client.getBlock({ blockTag: "finalized" })]);
      if (chainId !== deployment.chainId || head.number === null || finalized.number === null || finalized.number > head.number) return null;
      const at = { address: config.contract, abi: launchRewardsReadAbi, blockNumber: head.number } as const;
      const [token, expectedDecimals, reward, signer, factory, activated, startBlock, tradeFrom, claimedCount, remaining, enabled, max] = await Promise.all([
        client.readContract({ ...at, functionName: "rewardToken" }), client.readContract({ ...at, functionName: "tokenDecimals" }),
        client.readContract({ ...at, functionName: "rewardAmountRaw" }), client.readContract({ ...at, functionName: "campaignSigner" }),
        client.readContract({ ...at, functionName: "launchFactory" }), client.readContract({ ...at, functionName: "activated" }),
        client.readContract({ ...at, functionName: "startBlock" }), client.readContract({ ...at, functionName: "tradeRequiredFromBlock" }),
        client.readContract({ ...at, functionName: "claimedCount" }), client.readContract({ ...at, functionName: "remainingReserve" }),
        client.readContract({ ...at, functionName: "isEnabled" }), client.readContract({ ...at, functionName: "MAX_RECIPIENTS" }),
      ]);
      if (!activated || (!enabled && claimedCount < 1000n) || startBlock === 0n || startBlock > head.number || max !== 1000n || reward <= 0n
        || claimedCount > 1000n || remaining !== (1000n - claimedCount) * reward || token === zeroAddress
        || signer.toLowerCase() !== account.address.toLowerCase() || factory.toLowerCase() !== deployment.factory.toLowerCase()
        || (config.expectedToken && token.toLowerCase() !== config.expectedToken.toLowerCase())
        || (config.requireTrade && tradeFrom === 0n) || (tradeFrom !== 0n && tradeFrom < startBlock)) return null;
      const tokenAt = { address: token, abi: erc20Abi, blockNumber: head.number } as const;
      const [decimals, balance, name, symbol] = await Promise.all([
        client.readContract({ ...tokenAt, functionName: "decimals" }),
        client.readContract({ ...tokenAt, functionName: "balanceOf", args: [config.contract] }),
        client.readContract({ ...tokenAt, functionName: "name" }), client.readContract({ ...tokenAt, functionName: "symbol" }),
      ]);
      if (decimals !== expectedDecimals || balance < remaining) return null;
      const tokenName = config.tokenName ?? campaignLabel(name, 80);
      const tokenSymbol = config.tokenSymbol ?? campaignLabel(symbol, 20);
      if (!tokenName || !tokenSymbol) return null;
      return { headBlock: head.number, now: head.timestamp, finalizedBlock: finalized.number, summary: {
        enabled: true, chainId: deployment.chainId, contract: config.contract,
        token: { address: getAddress(token), name: tokenName, symbol: tokenSymbol, decimals }, rewardAmountRaw: reward.toString(),
        maxRecipients: 1000, claimedCount: Number(claimedCount), qualifiedCount: 0, startBlock: startBlock.toString(), tradeRequiredFromBlock: tradeFrom.toString(),
      } };
    } catch { throw unavailable(); }
  };
  const state = async (fresh = false) => {
    if (fresh) return readState();
    if (cached && cached.until > Date.now()) return cached.state;
    if (!pending) pending = readState().then(value => { cached = { until: Date.now() + 10_000, state: value }; return value; }).finally(() => { pending = null; });
    return pending;
  };
  const launches = async (s: CampaignState) => {
    if (!await store.caughtUp(deployment.chainId, s.finalizedBlock)) throw new HttpError(409, "campaign_confirming", "Launch confirmations are still being indexed. Try again shortly.");
    const key = `${s.summary.startBlock}:${s.finalizedBlock}`;
    if (ranked?.key !== key) ranked = { key, launches: await store.launches(BigInt(s.summary.startBlock), s.finalizedBlock) };
    return ranked.launches;
  };
  const walletState = async (wallet: Address, s: CampaignState): Promise<LaunchCampaignWalletStatus> => {
    const claimed = await client.readContract({ address: config!.contract, abi: launchRewardsReadAbi, functionName: "claimed", args: [wallet], blockNumber: s.headBlock }).catch(() => { throw unavailable(); });
    if (claimed) return { wallet, state: "claimed", tradeRequired: false };
    let eligible: CampaignLaunch[];
    try { eligible = await launches(s); } catch (error) {
      if (error instanceof HttpError && error.code === "campaign_confirming") return { wallet, state: "confirming", tradeRequired: false };
      throw error;
    }
    const launch = eligible.find(l => l.wallet.toLowerCase() === wallet.toLowerCase());
    if (!launch) {
      if (eligible.length >= 1000) return { wallet, state: "full", tradeRequired: false };
      const confirming = await store.hasLaunch(wallet, BigInt(s.summary.startBlock), s.finalizedBlock);
      return { wallet, state: confirming ? "confirming" : "launch_required", tradeRequired: BigInt(s.summary.tradeRequiredFromBlock) !== 0n };
    }
    const tradeRequired = BigInt(s.summary.tradeRequiredFromBlock) !== 0n && launch.launchBlock >= BigInt(s.summary.tradeRequiredFromBlock);
    const tradeBlock = tradeRequired ? await store.tradeBlock(wallet, launch.launchBlock, s.finalizedBlock) : 0n;
    return { wallet, state: tradeBlock === null ? "trade_required" : "eligible", tradeRequired, slot: launch.slot, coin: launch.coin,
      launchBlock: launch.launchBlock.toString(), ...(tradeBlock !== null ? { tradeBlock: tradeBlock.toString() } : {}) };
  };
  return {
    configured: () => !!config && !!account,
    quota: store.quota,
    async summary(): Promise<LaunchCampaignSummary> {
      const s = await state();
      if (!s) return { enabled: false };
      return { ...s.summary, qualifiedCount: (await launches(s)).length };
    },
    async wallet(wallet: Address): Promise<LaunchCampaignWalletStatus> {
      const s = await state();
      if (!s) throw unavailable();
      return walletState(wallet, s);
    },
    async ticket(wallet: Address): Promise<LaunchCampaignClaimTicket> {
      const s = await state(true);
      if (!s || !account || !config) throw unavailable();
      const w = await walletState(wallet, s);
      if (w.state !== "eligible") {
        const code = w.state === "claimed" ? "campaign_already_claimed" : w.state === "full" ? "campaign_full" : w.state === "confirming" ? "campaign_confirming" : "campaign_not_eligible";
        throw new HttpError(409, code, w.state === "trade_required" ? "Complete a trade after your launch to claim this reward." : "This wallet cannot claim a launch reward yet.");
      }
      // A consumed slot must never be reissued, including after a signer/operator mistake.
      const used = await client.readContract({ address: config.contract, abi: launchRewardsReadAbi, functionName: "slotClaimed", args: [w.slot!], blockNumber: s.headBlock }).catch(() => { throw unavailable(); });
      if (used) throw new HttpError(409, "campaign_full", "This campaign slot has already been claimed.");
      const deadline = s.now + BigInt(config.ticketTtlSec);
      const signature = await account.signTypedData({ domain: { name: LAUNCH_CAMPAIGN_DOMAIN_NAME, version: "1", chainId: deployment.chainId, verifyingContract: config.contract },
        types: LAUNCH_CAMPAIGN_TYPES, primaryType: "Claim", message: { wallet, slot: w.slot!, coin: w.coin!, launchBlock: BigInt(w.launchBlock!), tradeBlock: BigInt(w.tradeBlock!), deadline } });
      return { wallet, slot: w.slot!, coin: w.coin!, launchBlock: w.launchBlock!, tradeBlock: w.tradeBlock!, deadline: Number(deadline), signature };
    },
  };
}
export type LaunchCampaign = ReturnType<typeof createLaunchCampaign>;
