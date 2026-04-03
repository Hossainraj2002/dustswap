import { Hono } from "hono";
import { isAddress } from "viem";
import {
  getCurrentDayKey,
  getCurrentWeekKey,
  getSwapHistory,
  getUserAlltimeVolume,
  getUserDailyVolume,
  getUserIdForAddress,
  getUserWeeklyVolume,
  recordSwap,
  swapRecorderErrors,
} from "../services/swapRecorder";
import { pointsEngine } from "../services/pointsEngine";
import { questEngine } from "../services/questEngine";

const swapsRoutes = new Hono();

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function isTxHash(value: string) {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

swapsRoutes.post("/record", async (c) => {
  try {
    const body = await c.req.json<{
      address?: string;
      txHash?: string;
      chainId?: number;
    }>();

    if (!body.address || !isAddress(body.address)) {
      return c.json({ success: false, error: "A valid address is required" }, 400);
    }

    if (!body.txHash || !isTxHash(body.txHash)) {
      return c.json({ success: false, error: "A valid txHash is required" }, 400);
    }

    const result = await recordSwap({
      address: normalizeAddress(body.address),
      txHash: body.txHash.toLowerCase(),
      chainId: body.chainId,
    });

    const normalizedAddress = normalizeAddress(body.address);
    pointsEngine.invalidateUserReadCaches(normalizedAddress);
    questEngine.invalidateSwapSyncCache(normalizedAddress);

    let questSync: {
      success: boolean;
      completedQuests?: Array<{ questId: string; slug: string; awardedPoints: number }>;
      error?: string;
    } = {
      success: true,
      completedQuests: [],
    };

    try {
      questSync = await questEngine.syncRecordedSwapProgress(normalizedAddress);
    } catch (questSyncError) {
      questSync = {
        success: false,
        completedQuests: [],
        error:
          (questSyncError as Error).message ||
          "Swap was recorded but quest progress could not be refreshed immediately",
      };
    }

    return c.json({
      success: true,
      txHash: result.txHash,
      amountUsd: result.amountUsd,
      dayKey: result.dayKey,
      weekKey: result.weekKey,
      isNew: result.isNew,
      questSync,
    });
  } catch (error) {
    if (error instanceof swapRecorderErrors.ValidationError) {
      return c.json({ success: false, error: error.message }, 400);
    }

    if (error instanceof swapRecorderErrors.PendingTransactionError) {
      return c.json({ success: false, error: error.message, code: "receipt_pending" }, 500);
    }

    if (error instanceof swapRecorderErrors.UnprocessableSwapError) {
      return c.json({ success: false, error: error.message }, 422);
    }

    return c.json(
      { success: false, error: (error as Error).message || "Internal error while recording swap" },
      500
    );
  }
});

swapsRoutes.get("/volume", async (c) => {
  try {
    const address = c.req.query("address");
    const window = c.req.query("window") || "alltime";

    if (!address || !isAddress(address)) {
      return c.json({ success: false, error: "A valid address is required" }, 400);
    }

    if (!["daily", "weekly", "alltime"].includes(window)) {
      return c.json({ success: false, error: "window must be daily, weekly, or alltime" }, 400);
    }

    const normalizedAddress = normalizeAddress(address);
    const userId = await getUserIdForAddress(normalizedAddress);

    if (!userId) {
      return c.json({
        success: true,
        address: normalizedAddress,
        window,
        totalUsd: 0,
        swapCount: 0,
      });
    }

    const summary =
      window === "daily"
        ? await getUserDailyVolume(userId, getCurrentDayKey())
        : window === "weekly"
          ? await getUserWeeklyVolume(userId, getCurrentWeekKey())
          : await getUserAlltimeVolume(userId);

    return c.json({
      success: true,
      address: normalizedAddress,
      window,
      totalUsd: summary.totalUsd,
      swapCount: summary.swapCount,
    });
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

swapsRoutes.get("/history", async (c) => {
  try {
    const address = c.req.query("address");
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
    const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10));

    if (!address || !isAddress(address)) {
      return c.json({ success: false, error: "A valid address is required" }, 400);
    }

    const normalizedAddress = normalizeAddress(address);
    const history = await getSwapHistory(normalizedAddress, limit, offset);

    return c.json({
      success: true,
      address: normalizedAddress,
      limit,
      offset,
      total: history.total,
      rows: history.rows,
    });
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 500);
  }
});

export { swapsRoutes };
