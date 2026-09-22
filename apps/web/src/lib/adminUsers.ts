import { buildPublicApiUrl, publicApiFetch } from "@/lib/apiBase";

export type AdminUserRow = {
  user_id: number;
  wallet: string;
  x_name: string | null;
  discord_name: string | null;
  discord_display_name: string | null;
  pp_points: string;
  current_streak: number;
  last_check_in: string | null;
  swap_count: string;
  swap_volume_usd: string;
  swap_fees_paid_usd: string;
  sweep_count: string;
  sweep_gross_usd: string;
  sweep_fees_paid_usd: string;
  sweep_rewards_received_usd: string;
  sweep_rewards_pending_usd: string;
  sweep_fees_net_of_rewards_usd: string;
  streak_save_count: string;
  streak_save_fees_paid_usd: string;
  checkin_count: string;
  checkin_fees_paid_usd: string;
  spin_count: string;
  spin_points_won: string;
  partner_rewards_received_usd: string;
  total_fees_paid_usd: string;
  total_rewards_received_usd: string;
  net_after_all_rewards_usd: string;
  last_activity: string | null;
};

export type AdminUserQuery = {
  identifiers?: string;
  identifierMode?: "auto" | "wallet" | "x" | "discord" | "user_id";
  ppMin?: number | null;
  ppMax?: number | null;
  hasX?: boolean | null;
  hasDiscord?: boolean | null;
  minTotalFees?: number | null;
  minSwapFees?: number | null;
  minSweepFees?: number | null;
  minStreakSaves?: number | null;
  minSwapCount?: number | null;
  minSweepCount?: number | null;
  activeSince?: string | null;
  activeBefore?: string | null;
  asOf?: string | null;
  sort?: string;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type AdminUserSearchResult = {
  rows: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
  asOf: string;
  tookMs: number;
  identifiersParsed: number;
};

export type AdminUserSummary = {
  accounts: string;
  merged_accounts: string;
  x_linked: string;
  discord_linked: string;
  swaps: string;
  sweeps: string;
  streak_saves: string;
  swap_fees_usd: string;
  sweep_fees_usd: string;
  streak_fees_usd: string;
  checkin_fees_usd: string;
  footprint_fees_usd: string;
};

function url(path: string) {
  return buildPublicApiUrl(`/api/admin/users${path}`);
}

/** Strips empty values so the API sees only the filters the admin actually set. */
function cleanBody(query: AdminUserQuery) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

export async function searchAdminUsers(
  adminToken: string,
  query: AdminUserQuery
): Promise<{ success: boolean; data?: AdminUserSearchResult; error?: string }> {
  const response = await publicApiFetch(url("/search"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify(cleanBody(query)),
  });
  const text = await response.text();
  if (!text) return { success: false, error: `Empty response (${response.status})` };
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: `Unexpected response (${response.status})` };
  }
}

export async function fetchAdminUserSummary(
  adminToken: string
): Promise<{ success: boolean; data?: AdminUserSummary; error?: string }> {
  const response = await publicApiFetch(url("/summary"), {
    headers: { "x-admin-token": adminToken },
  });
  const text = await response.text();
  if (!text) return { success: false, error: `Empty response (${response.status})` };
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: `Unexpected response (${response.status})` };
  }
}

/** Downloads the current filter as CSV. Returns an error string, or null on success. */
export async function downloadAdminUserCsv(
  adminToken: string,
  query: AdminUserQuery,
  maxRows = 100_000
): Promise<string | null> {
  const response = await publicApiFetch(url("/export"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify({ ...cleanBody(query), limit: maxRows, offset: 0 }),
  });

  if (!response.ok) {
    const text = await response.text();
    try {
      return JSON.parse(text)?.error || `Export failed (${response.status})`;
    } catch {
      return `Export failed (${response.status})`;
    }
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const link = document.createElement("a");
  link.href = href;
  link.download = `dustswap-users-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return null;
}
