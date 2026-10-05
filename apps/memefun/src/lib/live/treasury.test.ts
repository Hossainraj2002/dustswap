import { afterEach, describe, expect, it, vi } from "vitest";
import { type PublicClient, zeroAddress } from "viem";
import type { MemefunDeployment } from "@/lib/contracts/deployments";
import { createApi } from "./api";
import { LiveMarket } from "./LiveMarket";
import { sendTreasuryAuthorWithdrawal, type TxContext } from "./tx";

vi.mock("./config", async (actual) => ({ ...await actual<typeof import("./config")>(), resolveDeployment: (value: MemefunDeployment) => value }));
vi.mock("./tx", () => ({ sendTreasuryAuthorWithdrawal: vi.fn(async () => `0x${"11".repeat(32)}`) }));

const TREASURY = "0x00000000000000000000000000000000000000aa" as const;
const OTHER = "0x00000000000000000000000000000000000000bb" as const;
const COIN = "0xb200000000000000000000000000000000000001" as const;
const POOL = `0x${"22".repeat(32)}` as const;
const ERC20 = "0x00000000000000000000000000000000000000cc" as const;
const SECOND_POOL = `0x${"33".repeat(32)}` as const;
const deployment = { chainId: 31337, config: TREASURY, hook: TREASURY } as unknown as MemefunDeployment;

function fixture() {
  let treasury: string = TREASURY;
  let response = { coin: COIN as string, markets: [
    { poolId: POOL, currency: zeroAddress, symbol: "ETH", decimals: 18, pendingRaw: "123000000000000000" },
    { poolId: SECOND_POOL, currency: ERC20, symbol: "USDC", decimals: 6, pendingRaw: "7890123" },
  ] };
  const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    return Response.json(path === "/v1/deployment" ? { deployment } : response);
  });
  const ctx = { wallet: { account: { address: TREASURY } }, deployment } as unknown as TxContext;
  const txContext = vi.fn(async () => ctx);
  const readContract = vi.fn(async (call: { functionName: string; args?: string[] }) => call.functionName === "poolIdFor" ? (call.args?.[1]?.toLowerCase() === ERC20 ? SECOND_POOL : POOL) : treasury);
  const market = new LiveMarket({ api: createApi("https://api.test", fetcher), client: { readContract } as unknown as PublicClient, txContext });
  return { market, fetcher, readContract, txContext, ctx, changeTreasury: (value: string) => { treasury = value; },
    changeResponse: (value: typeof response) => { response = value; }, response };
}

afterEach(() => vi.clearAllMocks());

describe("treasury author balance adapter", () => {
  it("checks the treasury role without prompting for a wallet or X sign-in", async () => {
    const { market, txContext } = fixture();
    expect(market.isAuthorTreasury()).toBe(false);
    expect(market.isAuthorTreasury(TREASURY)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(market.isAuthorTreasury(TREASURY)).toBe(true);
    expect(market.isAuthorTreasury(OTHER)).toBe(false);
    expect(txContext).not.toHaveBeenCalled();
    market.stop();
  });
  it("fetches only the explicitly requested coin with exact per-currency amounts and no authentication", async () => {
    const { market, fetcher, txContext } = fixture();
    const rows = await market.getTreasuryAuthorRewards(TREASURY, COIN);
    expect(rows.map(row => [row.poolId, row.currency?.toLowerCase(), row.amountQuote, row.amountRaw])).toEqual([
      [POOL, zeroAddress, 0.123, "123000000000000000"], [SECOND_POOL, ERC20, 7.890123, "7890123"],
    ]);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/v1/deployment", `/v1/coins/${COIN}/author`]);
    expect(fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("authorization"))).toBe(true);
    expect(txContext).not.toHaveBeenCalled();
  });
  it("rechecks the current treasury before fetching any reserves", async () => {
    const { market, changeTreasury, fetcher } = fixture();
    await market.getTreasuryAuthorRewards(TREASURY, COIN);
    changeTreasury(OTHER);
    fetcher.mockClear();
    await expect(market.getTreasuryAuthorRewards(TREASURY, COIN)).rejects.toThrow("current DustSwap treasury");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses the server's canonical currency for the requested pool", async () => {
    const { market } = fixture();
    await market.claimTreasuryAuthorRewards(TREASURY, COIN, SECOND_POOL);
    expect(sendTreasuryAuthorWithdrawal).toHaveBeenCalledExactlyOnceWith(expect.anything(), COIN, expect.stringMatching(/^0x00000000000000000000000000000000000000[Cc]{2}$/));
  });
  it("rejects a foreign coin response or missing pool before opening the wallet", async () => {
    const f = fixture();
    f.changeResponse({ ...f.response, coin: OTHER });
    await expect(f.market.claimTreasuryAuthorRewards(TREASURY, COIN, POOL)).rejects.toThrow("different coin");
    f.changeResponse(f.response);
    await expect(f.market.claimTreasuryAuthorRewards(TREASURY, COIN, `0x${"44".repeat(32)}`)).rejects.toThrow("nothing left");
    expect(f.txContext).not.toHaveBeenCalled();
    expect(sendTreasuryAuthorWithdrawal).not.toHaveBeenCalled();
  });
  it("refreshes an emptied shared balance before opening the wallet", async () => {
    const f = fixture();
    await f.market.getTreasuryAuthorRewards(TREASURY, COIN);
    f.changeResponse({ ...f.response, markets: f.response.markets.map(row => ({ ...row, pendingRaw: "0" })) });
    await expect(f.market.claimTreasuryAuthorRewards(TREASURY, COIN, POOL)).rejects.toThrow("nothing left");
    expect(f.txContext).not.toHaveBeenCalled();
  });
  it("rejects a wallet changed while the balance loaded", async () => {
    const f = fixture();
    Object.assign(f.ctx.wallet, { account: { address: OTHER } });
    await expect(f.market.claimTreasuryAuthorRewards(TREASURY, COIN, POOL)).rejects.toThrow("wallet changed");
    expect(sendTreasuryAuthorWithdrawal).not.toHaveBeenCalled();
  });
  it("rejects a swapped pool currency using the hook's on-chain pool identity before opening the wallet", async () => {
    const f = fixture();
    f.changeResponse({ ...f.response, markets: [{ ...f.response.markets[0]!, currency: ERC20 }] });
    await expect(f.market.claimTreasuryAuthorRewards(TREASURY, COIN, POOL)).rejects.toThrow("could not be verified on chain");
    expect(f.txContext).not.toHaveBeenCalled();
    expect(sendTreasuryAuthorWithdrawal).not.toHaveBeenCalled();
  });
  it("rejects malformed raw balances instead of showing or withdrawing them", async () => {
    const f = fixture();
    f.changeResponse({ ...f.response, markets: [{ ...f.response.markets[0]!, pendingRaw: "-1" }] });
    await expect(f.market.claimTreasuryAuthorRewards(TREASURY, COIN, POOL)).rejects.toThrow("could not be verified");
    expect(f.txContext).not.toHaveBeenCalled();
  });
});
