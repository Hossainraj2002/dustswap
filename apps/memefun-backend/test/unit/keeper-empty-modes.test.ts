import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KeeperContext } from "../../keeper/context";
import { runBuybacks, runFloors } from "../../keeper/jobs/modules";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../keeper/tx", () => ({ simulateAndSend: send }));

const COIN = "0x0000000000000000000000000000000000000001";
const QUOTE = "0x0000000000000000000000000000000000000002";
const FEE_VAULT = "0x0000000000000000000000000000000000000003";
const BURN_VAULT = "0x0000000000000000000000000000000000000004";
const FLOOR_VAULT = "0x0000000000000000000000000000000000000005";
const POOL = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;
const candidates = [{ address: COIN, quote: QUOTE, pool_id: POOL, decimals: 18, price_usd_e_8: "100000000" }];

function fixture(options: { empty?: boolean; now?: number; last?: bigint; pending?: bigint } = {}) {
  const order: string[] = [];
  const index = { query: vi.fn(async () => { order.push("discover"); return { rows: options.empty ? [] : candidates }; }) };
  const chainNow = vi.fn(async () => { order.push("chain time"); return options.now ?? 10_000; });
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName.startsWith("last")) return options.last ?? 0n;
    if (functionName === "destinationPendingFor") return options.pending ?? 10n ** 19n;
    return 0n;
  });
  const wallet = {};
  const logKeeperRun = vi.fn(async () => undefined);
  const ctx = { index, chainNow, client: { readContract }, wallets: { keeper: wallet },
    deployment: { feeVault: FEE_VAULT, buybackBurnVault: BURN_VAULT, floorVault: FLOOR_VAULT },
    thresholds: { buybackMinUsdE8: 500_000_000n, floorMinUsdE8: 500_000_000n },
    app: { logKeeperRun }, log: vi.fn() } as unknown as KeeperContext;
  return { ctx, index, chainNow, readContract, wallet, logKeeperRun, order };
}

const modes = [
  { name: "buyback", mode: 1, run: runBuybacks, cooldown: 600, lastFunction: "lastBuybackAtFor", vault: BURN_VAULT,
    functionName: "executeBuybackFor", result: [2n, 5n] },
  { name: "floor", mode: 3, run: runFloors, cooldown: 3_600, lastFunction: "lastAddAtFor", vault: FLOOR_VAULT,
    functionName: "addFloorFor", result: [-1_000, -500, 99n, 2n] },
] as const;

describe.each(modes)("$name quiet-mode RPC savings", (mode) => {
  beforeEach(() => send.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("returns an empty outcome without any RPC or transaction when no candidates exist", async () => {
    const f = fixture({ empty: true });
    await expect(mode.run(f.ctx)).resolves.toEqual({ executed: 0, skipped: 0 });
    expect(f.index.query).toHaveBeenCalledWith(expect.stringContaining("c.mode = $1"), [mode.mode]);
    expect(f.chainNow).not.toHaveBeenCalled();
    expect(f.readContract).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(f.logKeeperRun).not.toHaveBeenCalled();
  });

  it("awaits discovery before requesting chain time", async () => {
    const f = fixture();
    let release!: () => void;
    const discovered = new Promise<void>((resolve) => { release = resolve; });
    f.index.query.mockImplementation(async () => { await discovered; return { rows: [] }; });
    const task = mode.run(f.ctx);
    await Promise.resolve();
    expect(f.chainNow).not.toHaveBeenCalled();
    release();
    await task;
    expect(f.chainNow).not.toHaveBeenCalled();
  });

  it("uses the same chain-time cooldown boundary, vault and transaction arguments for eligible candidates", async () => {
    // A different wall clock must not affect cooldowns measured against the chain.
    vi.spyOn(Date, "now").mockReturnValue(1);
    const f = fixture({ now: 1_000 + mode.cooldown, last: 1_000n });
    send.mockResolvedValue({ kind: "sent", hash: TX, result: mode.result });
    await expect(mode.run(f.ctx)).resolves.toEqual({ executed: 1, skipped: 0 });
    expect(f.order).toEqual(["discover", "chain time"]);
    expect(f.chainNow).toHaveBeenCalledOnce();
    expect(f.readContract).toHaveBeenCalledTimes(3);
    expect(f.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: FEE_VAULT,
      functionName: "destinationPendingFor", args: [COIN, QUOTE] }));
    expect(f.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: mode.vault,
      functionName: mode.lastFunction, args: [COIN, QUOTE] }));
    expect(send).toHaveBeenCalledExactlyOnceWith(f.ctx, f.wallet, expect.objectContaining({
      address: mode.vault, functionName: mode.functionName, args: [COIN, QUOTE],
    }));
    expect(f.logKeeperRun).toHaveBeenCalledWith(expect.objectContaining({ job: mode.name, target: POOL, status: "ok", txHash: TX }));
  });

  it("still skips an otherwise funded candidate before its existing cooldown expires", async () => {
    const f = fixture({ now: 1_000 + mode.cooldown - 1, last: 1_000n });
    await expect(mode.run(f.ctx)).resolves.toEqual({ executed: 0, skipped: 0 });
    expect(f.chainNow).toHaveBeenCalledOnce();
    expect(f.readContract).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalled();
  });

  it("still skips a candidate whose funds are below the existing USD threshold", async () => {
    const f = fixture({ pending: 10n ** 18n });
    await expect(mode.run(f.ctx)).resolves.toEqual({ executed: 0, skipped: 0 });
    expect(f.chainNow).toHaveBeenCalledOnce();
    expect(f.readContract).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves dry-run outcome logging without claiming an on-chain transaction", async () => {
    const f = fixture();
    send.mockResolvedValue({ kind: "dry_run", result: mode.result });
    await expect(mode.run(f.ctx)).resolves.toEqual({ executed: 1, skipped: 0 });
    expect(f.logKeeperRun).toHaveBeenCalledWith(expect.objectContaining({ job: mode.name, target: POOL, status: "dry_run", txHash: null }));
  });
});
