import { Hono } from "hono";
import { type Address, type Hex, type PublicClient, getAddress, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchCampaignRoutes } from "../../api/launch-campaign";
import { HttpError, errorBody } from "../../api/http";
import { createSessions } from "../../api/write/session";
import deploymentRecord from "../../deployments/8453.json";
import { parseDeployment } from "../../lib/deployment";
import type { Queryable } from "../../lib/db";
import { campaignLabel, launchCampaignConfig, type LaunchCampaignConfig } from "../../lib/launch-campaign/config";
import { createLaunchCampaign, type LaunchCampaign } from "../../lib/launch-campaign/service";
import { checkpointCovers, createCampaignStore, type CampaignLaunch } from "../../lib/launch-campaign/store";
import { LAUNCH_CAMPAIGN_DOMAIN_NAME, LAUNCH_CAMPAIGN_TYPES } from "../../shared/core/campaign";

// Public, deterministic unit-test signing key. Never loaded from operator environment files.
const KEY = `0x${"11".repeat(32)}` as Hex;
const SIGNER = privateKeyToAccount(KEY);
const WALLET = "0x00000000000000000000000000000000000000AA" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;
const COIN = "0x00000000000000000000000000000000000000cc" as Address;
const CONTRACT = "0x00000000000000000000000000000000000000dd" as Address;
const TOKEN = "0x00000000000000000000000000000000000000ee" as Address;
const deployment = parseDeployment(deploymentRecord, 8453);
const config: LaunchCampaignConfig = { contract: CONTRACT, expectedToken: TOKEN, signerKey: KEY, requireTrade: false, ticketTtlSec: 300 };
const checkpoint = (chain: number, block: bigint, tail = "9".repeat(33)) => `1780000000${String(chain).padStart(16, "0")}${block.toString().padStart(16, "0")}${tail}`;

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function fixture(launches: CampaignLaunch[] = [{ wallet: WALLET, coin: COIN, slot: 0, launchBlock: 150n }], options: Partial<LaunchCampaignConfig> = {}) {
  const values: Record<string, unknown> = { rewardToken: TOKEN, tokenDecimals: 18, decimals: 18, rewardAmountRaw: 100n,
    campaignSigner: SIGNER.address, launchFactory: deployment.factory, activated: true, startBlock: 100n,
    tradeRequiredFromBlock: 0n, claimedCount: 0n, remainingReserve: 100000n, isEnabled: true, MAX_RECIPIENTS: 1000n,
    balanceOf: 100000n, name: "Reward Token", symbol: "REWARD", claimed: false, slotClaimed: false };
  const readContract = vi.fn(async ({ functionName }: { functionName: string; blockNumber?: bigint }) => values[functionName]);
  const getChainId = vi.fn(async () => 8453);
  const getBlock = vi.fn(async (args?: { blockTag?: string }) => ({ number: args?.blockTag === "finalized" ? 300n : 400n, timestamp: 1780000000n }));
  const client = { getChainId, getBlock, readContract } as unknown as PublicClient;
  const store = { caughtUp: vi.fn(async () => true), launches: vi.fn(async () => launches), hasLaunch: vi.fn(async () => false),
    tradeBlock: vi.fn(async (): Promise<bigint | null> => null), quota: vi.fn(async (_key: string, _limit: number, _window: number) => true), prune: vi.fn(async () => undefined) };
  return { values, client, store, readContract, getChainId, getBlock, campaign: createLaunchCampaign({ ...config, ...options }, client, deployment, store) };
}

describe("campaign configuration and complete finalized checkpoints", () => {
  it("defaults off even when unrelated role keys exist", () => {
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_ENABLED", "false");
    vi.stubEnv("KEEPER_PRIVATE_KEY", KEY);
    expect(launchCampaignConfig()).toBeNull();
  });
  it("requires a separate valid campaign key and validates optional token assertions", () => {
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_ENABLED", "true");
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_CONTRACT", CONTRACT);
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_SIGNER_PRIVATE_KEY", "");
    expect(launchCampaignConfig()).toBeNull();
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_SIGNER_PRIVATE_KEY", "not-a-key");
    expect(launchCampaignConfig()).toBeNull();
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_SIGNER_PRIVATE_KEY", KEY);
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_TOKEN", "invalid-token");
    expect(launchCampaignConfig()).toBeNull();
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_TOKEN", TOKEN);
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_REQUIRE_TRADE", "false");
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_TICKET_TTL_SEC", "300");
    expect(launchCampaignConfig()).toMatchObject({ contract: CONTRACT, expectedToken: getAddress(TOKEN), signerKey: KEY, requireTrade: false });
  });
  it("removes control characters and caps public labels", () => {
    expect(campaignLabel(" \u0000Rew\nards\u007f ", 80)).toBe("Rewards");
    expect(campaignLabel("x".repeat(100), 20)).toHaveLength(20);
    expect(campaignLabel("\u0000 \n", 80)).toBeUndefined();
  });
  it.each([
    ["MEMEFUN_LAUNCH_REWARD_ENABLED", "typo"],
    ["MEMEFUN_LAUNCH_REWARD_REQUIRE_TRADE", "typo"],
    ["MEMEFUN_LAUNCH_REWARD_TICKET_TTL_SEC", "NaN"],
    ["MEMEFUN_LAUNCH_REWARD_TICKET_TTL_SEC", "0"],
    ["MEMEFUN_LAUNCH_REWARD_TICKET_TTL_SEC", "901"],
  ])("keeps optional campaign configuration disabled after a %s typo", (name, value) => {
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_ENABLED", "true");
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_CONTRACT", CONTRACT);
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_TOKEN", TOKEN);
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_SIGNER_PRIVATE_KEY", KEY);
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_REQUIRE_TRADE", "false");
    vi.stubEnv("MEMEFUN_LAUNCH_REWARD_TICKET_TTL_SEC", "300");
    vi.stubEnv(name, value);
    expect(launchCampaignConfig()).toBeNull();
  });
  it("rejects missing, malformed, wrong-chain and preceding checkpoints", () => {
    for (const value of [undefined, "", "9".repeat(74), "x".repeat(75), checkpoint(84532, 301n), checkpoint(8453, 299n)])
      expect(checkpointCovers(value, 8453, 300n)).toBe(false);
  });
  it("does not confuse one event in a boundary block with the completed block", () => {
    expect(checkpointCovers(checkpoint(8453, 300n, "0".repeat(33)), 8453, 300n)).toBe(false);
    expect(checkpointCovers(checkpoint(8453, 300n), 8453, 300n)).toBe(true);
    expect(checkpointCovers(checkpoint(8453, 301n, "0".repeat(33)), 8453, 300n)).toBe(true);
  });
  it("accepts a fully finalized quiet interval even when Ponder's last pruned event is older", async () => {
    // Installed Ponder multichain finalize advances finalized_checkpoint at every finalized
    // boundary; safe_checkpoint is only MAX(checkpoint) from deleted undo rows and may stay old.
    const index = { query: vi.fn(async () => ({ rows: [{ chain_id: 8453, latest_checkpoint: checkpoint(8453, 400n),
      finalized_checkpoint: checkpoint(8453, 370n), safe_checkpoint: checkpoint(8453, 150n, "0".repeat(33)) }] })) } as unknown as Queryable;
    expect(await createCampaignStore(index, index, []).caughtUp(8453, 300n)).toBe(true);
  });
  it.each([
    [checkpoint(8453, 290n), checkpoint(8453, 400n)],
    [checkpoint(8453, 400n), checkpoint(8453, 290n)],
    [checkpoint(8453, 400n), checkpoint(8453, 300n, "0".repeat(33))],
  ])("fails closed while either processed or durable finalized history is behind", async (latest, finalized) => {
    const index = { query: vi.fn(async () => ({ rows: [{ chain_id: 8453, latest_checkpoint: latest,
      finalized_checkpoint: finalized, safe_checkpoint: checkpoint(8453, 200n) }] })) } as unknown as Queryable;
    expect(await createCampaignStore(index, index, []).caughtUp(8453, 300n)).toBe(false);
  });
  it("refuses a multichain checkpoint table rather than assuming one chain's undo-prefix durability", async () => {
    const index = { query: vi.fn(async () => ({ rows: [8453, 84532].map(chain_id => ({ chain_id,
      latest_checkpoint: checkpoint(chain_id, 400n), finalized_checkpoint: checkpoint(chain_id, 370n), safe_checkpoint: checkpoint(chain_id, 350n) })) })) } as unknown as Queryable;
    expect(await createCampaignStore(index, index, []).caughtUp(8453, 300n)).toBe(false);
  });
});

describe("finalized launch campaign service", () => {
  it("keeps absent or invalid signing configuration disabled without RPC access", async () => {
    const f = fixture();
    expect(await createLaunchCampaign(null, f.client, deployment, f.store).summary()).toEqual({ enabled: false });
    const invalid = createLaunchCampaign({ ...config, signerKey: `0x${"00".repeat(32)}` }, f.client, deployment, f.store);
    expect(invalid.configured()).toBe(false);
    expect(await invalid.summary()).toEqual({ enabled: false });
    expect(f.getBlock).not.toHaveBeenCalled();
  });
  it.each([
    ["activated", false], ["isEnabled", false], ["balanceOf", 99999n], ["remainingReserve", 99999n],
    ["MAX_RECIPIENTS", 999n], ["rewardAmountRaw", 0n], ["campaignSigner", OTHER], ["launchFactory", OTHER],
    ["rewardToken", OTHER], ["decimals", 6], ["startBlock", 0n],
  ])("does not advertise a mismatched or unfunded campaign (%s)", async (name, value) => {
    const f = fixture(); f.values[name as string] = value;
    expect(await f.campaign.summary()).toEqual({ enabled: false });
    await expect(f.campaign.ticket(WALLET)).rejects.toMatchObject({ code: "campaign_unavailable" });
  });
  it("uses onchain metadata, amount and cutoff, pinning all contract reads to one head", async () => {
    const f = fixture();
    f.values.tradeRequiredFromBlock = 200n;
    expect(await f.campaign.summary()).toMatchObject({ enabled: true, rewardAmountRaw: "100", startBlock: "100", tradeRequiredFromBlock: "200",
      token: { address: getAddress(TOKEN), symbol: "REWARD", decimals: 18 }, qualifiedCount: 1 });
    expect(f.getBlock).toHaveBeenCalledWith({ blockTag: "finalized" });
    expect(f.readContract.mock.calls.every(([args]) => (args as { blockNumber?: bigint }).blockNumber === 400n)).toBe(true);
    expect(f.store.caughtUp).toHaveBeenCalledWith(8453, 300n);
    expect(f.store.launches).toHaveBeenCalledWith(100n, 300n);
  });
  it("refuses a mismatched chain and fails closed on RPC failures", async () => {
    const wrong = fixture(); wrong.getChainId.mockResolvedValue(84532);
    expect(await wrong.campaign.summary()).toEqual({ enabled: false });
    const failed = fixture(); failed.getBlock.mockRejectedValue(new Error("private RPC URL must never be echoed"));
    await expect(failed.campaign.ticket(WALLET)).rejects.toMatchObject({ code: "campaign_unavailable", message: "The launch reward campaign is unavailable. Try again later." });
  });
  it("never uses an environment trade assertion to activate a rule", async () => {
    const f = fixture(undefined, { requireTrade: true });
    expect(await f.campaign.summary()).toEqual({ enabled: false });
  });
  it("waits for complete index coverage and performs no ranking or signing while behind", async () => {
    const f = fixture(); f.store.caughtUp.mockResolvedValue(false);
    expect(await f.campaign.wallet(WALLET)).toMatchObject({ state: "confirming" });
    await expect(f.campaign.ticket(WALLET)).rejects.toMatchObject({ code: "campaign_confirming" });
    expect(f.store.launches).not.toHaveBeenCalled();
    expect(f.store.tradeBlock).not.toHaveBeenCalled();
  });
  it("reports an observed unfinalized launch as confirming without assigning a slot", async () => {
    const f = fixture([]); f.store.hasLaunch.mockResolvedValue(true);
    expect(await f.campaign.wallet(WALLET)).toEqual({ wallet: WALLET, state: "confirming", tradeRequired: false });
    await expect(f.campaign.ticket(WALLET)).rejects.toMatchObject({ code: "campaign_confirming" });
  });
  it("grandfathers earlier launches when the future trade rule is enabled", async () => {
    const f = fixture(); f.values.tradeRequiredFromBlock = 151n;
    expect(await f.campaign.wallet(WALLET)).toMatchObject({ state: "eligible", slot: 0, tradeRequired: false, tradeBlock: "0" });
    expect(f.store.tradeBlock).not.toHaveBeenCalled();
  });
  it("requires a finalized later-block trade from a new participant", async () => {
    const f = fixture(); f.values.tradeRequiredFromBlock = 150n;
    expect(await f.campaign.wallet(WALLET)).toMatchObject({ state: "trade_required", tradeRequired: true });
    await expect(f.campaign.ticket(WALLET)).rejects.toMatchObject({ code: "campaign_not_eligible" });
    expect(f.store.tradeBlock).toHaveBeenCalledWith(WALLET, 150n, 300n);
    f.store.tradeBlock.mockResolvedValue(151n);
    expect(await f.campaign.ticket(WALLET)).toMatchObject({ tradeBlock: "151", slot: 0 });
  });
  it("binds a recoverable ticket to chain, distributor, wallet, zero-based slot and exact evidence", async () => {
    const f = fixture(); const ticket = await f.campaign.ticket(WALLET);
    expect(ticket).toMatchObject({ wallet: WALLET, slot: 0, coin: COIN, launchBlock: "150", tradeBlock: "0", deadline: 1780000300 });
    const signed = { domain: { name: LAUNCH_CAMPAIGN_DOMAIN_NAME, version: "1", chainId: 8453, verifyingContract: CONTRACT },
      types: LAUNCH_CAMPAIGN_TYPES, primaryType: "Claim" as const,
      message: { wallet: ticket.wallet, slot: ticket.slot, coin: ticket.coin, launchBlock: BigInt(ticket.launchBlock), tradeBlock: BigInt(ticket.tradeBlock), deadline: BigInt(ticket.deadline) }, signature: ticket.signature };
    expect(await recoverTypedDataAddress(signed)).toBe(SIGNER.address);
    expect(await recoverTypedDataAddress({ ...signed, message: { ...signed.message, wallet: OTHER } })).not.toBe(SIGNER.address);
    expect(await recoverTypedDataAddress({ ...signed, domain: { ...signed.domain, chainId: 84532 } })).not.toBe(SIGNER.address);
  });
  it("rechecks funding fresh before signing despite a cached enabled summary", async () => {
    const f = fixture(); expect(await f.campaign.summary()).toMatchObject({ enabled: true });
    f.values.balanceOf = 0n;
    await expect(f.campaign.ticket(WALLET)).rejects.toMatchObject({ code: "campaign_unavailable" });
  });
  it.each([["claimed", "campaign_already_claimed"], ["slotClaimed", "campaign_full"]])("rejects already consumed %s", async (name, code) => {
    const f = fixture(); f.values[name] = true;
    await expect(f.campaign.ticket(WALLET)).rejects.toMatchObject({ code });
  });
  it("returns full for an out-of-rank wallet regardless of claim request order", async () => {
    const f = fixture(Array.from({ length: 1000 }, (_, slot) => ({ wallet: OTHER, coin: COIN, slot, launchBlock: 150n })));
    await expect(f.campaign.ticket(WALLET)).rejects.toMatchObject({ code: "campaign_full" });
  });
  it("still reports claimed status after the completed campaign's isEnabled getter becomes false", async () => {
    const f = fixture(); Object.assign(f.values, { claimedCount: 1000n, remainingReserve: 0n, balanceOf: 0n, isEnabled: false, claimed: true });
    expect(await f.campaign.summary()).toMatchObject({ enabled: true, claimedCount: 1000 });
    expect(await f.campaign.wallet(WALLET)).toMatchObject({ state: "claimed" });
  });
});

function httpFixture(campaign: LaunchCampaign = fixture().campaign) {
  const sessions = createSessions("campaign-test-session-secret".repeat(2));
  const app = new Hono();
  app.onError((error, c) => error instanceof HttpError ? c.json(errorBody(error), error.status) : c.json({ error: { code: "internal" } }, 500));
  app.route("/", launchCampaignRoutes({ campaign, sessions, ipSalt: "campaign-test-ip-salt" }));
  const request = (wallet?: Address, body = "{}") => app.request("/v1/launch-campaign/claim-ticket", { method: "POST", body,
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.2", ...(wallet ? { authorization: `Bearer ${sessions.issue(wallet).token}` } : {}) } });
  return { app, request };
}

describe("campaign HTTP authorization and shared quotas", () => {
  it("serves a disabled direct summary with no optional dependency", async () => {
    const app = new Hono().route("/", launchCampaignRoutes());
    const result = await app.request("/v1/launch-campaign");
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ enabled: false });
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  it("requires a wallet session before consuming a ticket budget or signing", async () => {
    const f = fixture(), h = httpFixture(f.campaign);
    expect((await h.request()).status).toBe(401);
    expect(f.store.quota).not.toHaveBeenCalled();
    expect(f.readContract).not.toHaveBeenCalled();
  });
  it("ignores a forged body recipient and signs only the session wallet", async () => {
    const f = fixture(), h = httpFixture(f.campaign);
    const result = await h.request(WALLET, JSON.stringify({ wallet: OTHER, slot: 999, coin: OTHER }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ wallet: WALLET, slot: 0, coin: COIN });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(f.store.quota.mock.calls.map(([key]) => key)).toEqual([`ticket:wallet:${WALLET.toLowerCase()}`, expect.stringMatching(/^ticket:ip:[0-9a-f]{32}$/)]);
  });
  it("rejects an exhausted shared budget before any chain read or ticket signing", async () => {
    const f = fixture(), h = httpFixture(f.campaign); f.store.quota.mockResolvedValue(false);
    const response = await h.request(WALLET);
    expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ error: { code: "campaign_request_quota" } });
    expect(f.readContract).not.toHaveBeenCalled();
  });
  it("charges failed eligibility attempts against both wallet and network budgets", async () => {
    const f = fixture([]), h = httpFixture(f.campaign);
    expect((await h.request(WALLET)).status).toBe(409);
    expect(f.store.quota).toHaveBeenCalledTimes(2);
  });
  it("fails closed if shared budget storage fails", async () => {
    const f = fixture(), h = httpFixture(f.campaign); f.store.quota.mockRejectedValue(new Error("database unavailable"));
    expect((await h.request(WALLET)).status).toBe(500);
    expect(f.readContract).not.toHaveBeenCalled();
  });
  it("validates public wallet addresses and caps request bodies", async () => {
    const f = fixture(), h = httpFixture(f.campaign);
    expect((await h.app.request("/v1/launch-campaign/wallets/no-address")).status).toBe(400);
    expect((await h.request(WALLET, "x".repeat(1025))).status).toBe(413);
  });
});
