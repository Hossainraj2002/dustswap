import { getAddress, isAddress } from "viem";
import { dbQuery } from "../lib/db";
import { pointsEngine } from "./pointsEngine";
import { runtimeCache } from "../utils/runtimeCache";

export type AdminWalletReplacementLog = {
  level: "plus" | "minus" | "backup" | "warning" | "info";
  message: string;
  count?: number;
};

type WalletOwnerRow = {
  id: number;
  address: string;
  total_points: number;
  current_streak: number;
  longest_streak: number;
  merged_into: number | null;
  wallet_address: string | null;
  is_primary: boolean | null;
};

type WalletCountsRow = {
  user_wallets: number;
  wallet_spin_balances: number;
  point_events: number;
  check_ins: number;
  spin_history: number;
  sweeps: number;
  swap_transactions: number;
  quest_progress: number;
  quest_campaign_whitelist: number;
  footprint_social_verifications: number;
  user_onboarding_guides: number;
  social_accounts: number;
  user_profiles: number;
  partner_program_members: number;
  partner_fee_share_history: number;
  partner_reward_distributions: number;
  partner_content_submissions: number;
  wallet_token_balances: number;
  wallet_discovery_jobs: number;
};

type ReplacementRpcRow = {
  replacement_id: number;
  old_wallet: string;
  new_wallet: string;
  primary_user_id: number;
  displaced_user_id: number | null;
  logs: AdminWalletReplacementLog[];
  backup_saved: boolean;
};

export class AdminWalletReplacementError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

function normalizeAddress(address: string, label: string) {
  if (!address || !isAddress(address.trim())) {
    throw new AdminWalletReplacementError(`Enter a valid ${label} wallet address.`);
  }

  return getAddress(address.trim()).toLowerCase();
}

function toSafeLimit(limit: unknown) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) {
    return 20;
  }
  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

function normalizeLogs(value: unknown): AdminWalletReplacementLog[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const logs: AdminWalletReplacementLog[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const level = String(row.level || "info");
    const message = String(row.message || "");
    if (!message) {
      continue;
    }

    logs.push({
      level:
        level === "plus" ||
        level === "minus" ||
        level === "backup" ||
        level === "warning" ||
        level === "info"
          ? level
          : "info",
      message,
      count: typeof row.count === "number" ? row.count : Number(row.count || 0),
    });
  }

  return logs;
}

async function loadWalletOwner(wallet: string): Promise<WalletOwnerRow | null> {
  const walletResult = await dbQuery<WalletOwnerRow>(
    `
      SELECT
        u.id,
        u.address,
        u.total_points,
        u.current_streak,
        u.longest_streak,
        u.merged_into,
        w.wallet_address,
        w.is_primary
      FROM user_wallets w
      JOIN users u ON u.id = w.user_id
      WHERE w.wallet_address = $1
      LIMIT 1
    `,
    [wallet]
  );

  if (walletResult.rows[0]) {
    return walletResult.rows[0];
  }

  const userResult = await dbQuery<WalletOwnerRow>(
    `
      SELECT
        u.id,
        u.address,
        u.total_points,
        u.current_streak,
        u.longest_streak,
        u.merged_into,
        NULL::varchar AS wallet_address,
        (u.address = $1)::boolean AS is_primary
      FROM users u
      WHERE u.address = $1
        AND u.merged_into IS NULL
      LIMIT 1
    `,
    [wallet]
  );

  return userResult.rows[0] ?? null;
}

async function loadWalletCounts(wallet: string, userId?: number | null) {
  const result = await dbQuery<WalletCountsRow>(
    `
      SELECT
        (SELECT COUNT(*) FROM user_wallets WHERE wallet_address = $1 OR ($2::integer IS NOT NULL AND user_id = $2))::integer AS user_wallets,
        (SELECT COUNT(*) FROM wallet_spin_balances WHERE wallet_address = $1 OR ($2::integer IS NOT NULL AND user_id = $2))::integer AS wallet_spin_balances,
        (SELECT COUNT(*) FROM point_events WHERE $2::integer IS NOT NULL AND user_id = $2)::integer AS point_events,
        (SELECT COUNT(*) FROM check_ins WHERE $2::integer IS NOT NULL AND user_id = $2)::integer AS check_ins,
        (SELECT COUNT(*) FROM spin_history WHERE wallet_address = $1 OR ($2::integer IS NOT NULL AND user_id = $2))::integer AS spin_history,
        (SELECT COUNT(*) FROM sweeps WHERE LOWER(user_address) = $1)::integer AS sweeps,
        (SELECT COUNT(*) FROM swap_transactions WHERE address = $1 OR ($2::integer IS NOT NULL AND user_id = $2))::integer AS swap_transactions,
        (SELECT COUNT(*) FROM quest_progress WHERE wallet_address = $1 OR ($2::integer IS NOT NULL AND user_id = $2))::integer AS quest_progress,
        (SELECT COUNT(*) FROM quest_campaign_whitelist WHERE wallet_address = $1 OR ($2::integer IS NOT NULL AND user_id = $2))::integer AS quest_campaign_whitelist,
        (SELECT COUNT(*) FROM footprint_social_verifications WHERE wallet_address = $1 OR ($2::integer IS NOT NULL AND user_id = $2))::integer AS footprint_social_verifications,
        (SELECT COUNT(*) FROM user_onboarding_guides WHERE wallet_address = $1)::integer AS user_onboarding_guides,
        (SELECT COUNT(*) FROM social_accounts WHERE $2::integer IS NOT NULL AND user_id = $2)::integer AS social_accounts,
        (SELECT COUNT(*) FROM user_profiles WHERE $2::integer IS NOT NULL AND user_id = $2)::integer AS user_profiles,
        (SELECT COUNT(*) FROM partner_program_members WHERE wallet_address = $1 OR ($2::integer IS NOT NULL AND user_id = $2))::integer AS partner_program_members,
        (
          SELECT COUNT(*)
          FROM partner_fee_share_history h
          JOIN partner_program_members pm ON pm.id = h.partner_member_id
          WHERE pm.wallet_address = $1 OR ($2::integer IS NOT NULL AND pm.user_id = $2)
        )::integer AS partner_fee_share_history,
        (
          SELECT COUNT(*)
          FROM partner_reward_distributions d
          JOIN partner_program_members pm ON pm.id = d.partner_member_id
          WHERE pm.wallet_address = $1 OR ($2::integer IS NOT NULL AND pm.user_id = $2)
        )::integer AS partner_reward_distributions,
        (
          SELECT COUNT(*)
          FROM partner_content_submissions pcs
          LEFT JOIN partner_program_members pm ON pm.id = pcs.partner_member_id
          WHERE pm.wallet_address = $1 OR ($2::integer IS NOT NULL AND (pcs.partner_user_id = $2 OR pm.user_id = $2))
        )::integer AS partner_content_submissions,
        (SELECT COUNT(*) FROM wallet_token_balances WHERE wallet_address = $1)::integer AS wallet_token_balances,
        (SELECT COUNT(*) FROM wallet_discovery_jobs WHERE wallet_address = $1)::integer AS wallet_discovery_jobs
    `,
    [wallet, userId ?? null]
  );

  const row = result.rows[0];
  if (!row) {
    throw new AdminWalletReplacementError("Failed to load wallet row counts.", 500);
  }

  return row;
}

function sumCounts(counts: WalletCountsRow | undefined) {
  if (!counts) {
    return 0;
  }

  return Object.values(counts).reduce((total, value) => total + Number(value || 0), 0);
}

function mapReplacementRow(row: ReplacementRpcRow) {
  return {
    replacementId: Number(row.replacement_id),
    oldWallet: row.old_wallet,
    newWallet: row.new_wallet,
    primaryUserId: Number(row.primary_user_id),
    displacedUserId: row.displaced_user_id == null ? null : Number(row.displaced_user_id),
    logs: normalizeLogs(row.logs),
    backupSaved: Boolean(row.backup_saved),
  };
}

function invalidateReplacementCaches(oldWallet: string, newWallet: string) {
  pointsEngine.invalidateUserReadCaches(oldWallet);
  pointsEngine.invalidateUserReadCaches(newWallet);
  runtimeCache.invalidatePrefix("quest-board:");
  runtimeCache.invalidatePrefix("quest-swap-sync:");
}

export const adminWalletReplacementService = {
  async preview(input: { oldWallet?: string; newWallet?: string }) {
    const oldWallet = normalizeAddress(String(input.oldWallet || ""), "old");
    const newWallet = normalizeAddress(String(input.newWallet || ""), "new");

    if (oldWallet === newWallet) {
      throw new AdminWalletReplacementError("Old and new wallets must be different.");
    }

    const oldOwner = await loadWalletOwner(oldWallet);
    if (!oldOwner || oldOwner.is_primary !== true || oldOwner.address.toLowerCase() !== oldWallet) {
      throw new AdminWalletReplacementError("Old wallet must be an existing primary wallet.");
    }

    const newOwner = await loadWalletOwner(newWallet);
    const [oldCounts, newCounts] = await Promise.all([
      loadWalletCounts(oldWallet, oldOwner.id),
      loadWalletCounts(newWallet, newOwner?.id ?? null),
    ]);

    const newExistingRows = sumCounts(newCounts);
    const relation =
      !newOwner
        ? "unused"
        : newOwner.id === oldOwner.id
          ? "same_account"
          : "different_user";

    return {
      oldWallet,
      newWallet,
      canReplace: true,
      requiresConfirmation: newExistingRows > 0,
      relation,
      oldAccount: {
        userId: oldOwner.id,
        address: oldOwner.address,
        totalPoints: Number(oldOwner.total_points || 0),
        currentStreak: Number(oldOwner.current_streak || 0),
        longestStreak: Number(oldOwner.longest_streak || 0),
        counts: oldCounts,
        totalRows: sumCounts(oldCounts),
      },
      newWalletState: {
        ownerUserId: newOwner?.id ?? null,
        ownerAddress: newOwner?.address ?? null,
        isPrimary: newOwner?.is_primary ?? false,
        totalPoints: Number(newOwner?.total_points || 0),
        counts: newCounts,
        totalRows: newExistingRows,
      },
      warnings: [
        ...(relation === "different_user"
          ? ["The new wallet belongs to another user. Its live DustSwap data will be backed up and removed."]
          : []),
        ...(newExistingRows > 0
          ? ["Existing new-wallet rows will not be merged into the old account."]
          : []),
      ],
    };
  },

  async replace(input: { oldWallet?: string; newWallet?: string; note?: string }) {
    const oldWallet = normalizeAddress(String(input.oldWallet || ""), "old");
    const newWallet = normalizeAddress(String(input.newWallet || ""), "new");

    if (oldWallet === newWallet) {
      throw new AdminWalletReplacementError("Old and new wallets must be different.");
    }

    const result = await dbQuery<ReplacementRpcRow>(
      "SELECT * FROM admin_replace_primary_wallet($1::varchar, $2::varchar, $3::text)",
      [oldWallet, newWallet, input.note?.trim() || null]
    );

    const row = result.rows[0];
    if (!row) {
      throw new AdminWalletReplacementError("Wallet replacement did not return a result.", 500);
    }

    invalidateReplacementCaches(oldWallet, newWallet);
    return mapReplacementRow(row);
  },

  async listRecent(limitInput?: unknown) {
    const limit = toSafeLimit(limitInput);
    const result = await dbQuery<{
      id: number;
      old_wallet: string;
      new_wallet: string;
      primary_user_id: number;
      displaced_user_id: number | null;
      logs: AdminWalletReplacementLog[];
      note: string | null;
      created_at: string;
    }>(
      `
        SELECT
          id,
          old_wallet,
          new_wallet,
          primary_user_id,
          displaced_user_id,
          logs,
          note,
          created_at
        FROM admin_wallet_replacements
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      replacementId: Number(row.id),
      oldWallet: row.old_wallet,
      newWallet: row.new_wallet,
      primaryUserId: Number(row.primary_user_id),
      displacedUserId: row.displaced_user_id == null ? null : Number(row.displaced_user_id),
      logs: normalizeLogs(row.logs),
      note: row.note,
      createdAt: row.created_at,
    }));
  },
};
