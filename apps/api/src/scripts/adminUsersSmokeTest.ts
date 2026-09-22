import "dotenv/config";
import { Hono } from "hono";
import { adminUsersRoutes } from "../routes/adminUsers";
import { closeDbPool } from "../lib/db";

// Exercises /api/admin/users end to end against the configured database.
// Read-only. Run with: npx ts-node src/scripts/adminUsersSmokeTest.ts

const app = new Hono();
app.route("/api/admin/users", adminUsersRoutes);

const TOKEN = process.env.QUEST_ADMIN_TOKEN || "";

async function call(path: string, body?: unknown, token = TOKEN) {
  const started = Date.now();
  const res = await app.request(`http://local${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-admin-token": token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, json, text, ms: Date.now() - started, res };
}

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  if (!TOKEN) {
    console.error("QUEST_ADMIN_TOKEN not set; cannot run");
    process.exit(1);
  }

  // 1. auth
  const noAuth = await call("/api/admin/users/search", { limit: 1 }, "");
  check("rejects a missing token", noAuth.status === 401, `status=${noAuth.status}`);
  const badAuth = await call("/api/admin/users/search", { limit: 1 }, "not-the-token");
  check("rejects a wrong token", badAuth.status === 401, `status=${badAuth.status}`);

  // 2. default listing, sorted by PP
  const top = await call("/api/admin/users/search", { limit: 5 });
  check("default search returns rows", top.status === 200 && top.json?.data?.rows?.length === 5,
    `status=${top.status} ${top.ms}ms`);
  const first = top.json?.data?.rows?.[0];
  if (first) console.log("   top row:", JSON.stringify({
    user_id: first.user_id, x: first.x_name, dc: first.discord_name,
    pp: first.pp_points, fees: first.total_fees_paid_usd,
  }));
  const ppDesc = (top.json?.data?.rows ?? []).every((r: any, i: number, a: any[]) =>
    i === 0 || Number(a[i - 1].pp_points) >= Number(r.pp_points));
  check("default sort is PP descending", ppDesc);

  // 3. identifier search: wallet + x handle + numeric id in one go
  const seed = top.json?.data?.rows?.[0];
  const mixed = [seed?.wallet, seed?.x_name, String(seed?.user_id)].filter(Boolean).join("\n");
  const byId = await call("/api/admin/users/search", { identifiers: mixed, limit: 20 });
  const ids = (byId.json?.data?.rows ?? []).map((r: any) => r.user_id);
  check("mixed wallet/x/id search resolves to the same account",
    byId.status === 200 && ids.length === 1 && ids[0] === seed?.user_id,
    `matched=${JSON.stringify(ids)} ${byId.ms}ms`);

  // 4. discord search
  const withDc = (top.json?.data?.rows ?? []).find((r: any) => r.discord_name);
  if (withDc) {
    const byDc = await call("/api/admin/users/search", { identifiers: withDc.discord_name, identifierMode: "discord", limit: 5 });
    const hit = (byDc.json?.data?.rows ?? []).some((r: any) => r.user_id === withDc.user_id);
    check("discord handle search finds the account", byDc.status === 200 && hit, `${byDc.ms}ms`);
  }

  // 4b. discord DISPLAY name containing spaces must survive identifier parsing
  const spaced = (top.json?.data?.rows ?? []).find(
    (r: any) => r.discord_display_name && /\s/.test(r.discord_display_name)
  );
  if (spaced) {
    const bySpaced = await call("/api/admin/users/search", {
      identifiers: spaced.discord_display_name,
      identifierMode: "discord",
      limit: 10,
    });
    const hit = (bySpaced.json?.data?.rows ?? []).some((r: any) => r.user_id === spaced.user_id);
    check(
      `discord display name with spaces ("${spaced.discord_display_name}") is findable`,
      bySpaced.status === 200 && hit,
      `${bySpaced.ms}ms`
    );
  } else {
    console.log("SKIP  no spaced discord display name in the first page");
  }

  // 5. fee filter + fee sort (the wide-scan path)
  const wide = await call("/api/admin/users/search", {
    minTotalFees: 1, sort: "total_fees_paid_usd", direction: "desc", limit: 5,
  });
  const wrows = wide.json?.data?.rows ?? [];
  check("fee filter + fee sort returns rows", wide.status === 200 && wrows.length > 0,
    `total=${wide.json?.data?.total} ${wide.ms}ms`);
  check("every row clears the fee threshold",
    wrows.every((r: any) => Number(r.total_fees_paid_usd) >= 1));
  const feeDesc = wrows.every((r: any, i: number, a: any[]) =>
    i === 0 || Number(a[i - 1].total_fees_paid_usd) >= Number(r.total_fees_paid_usd));
  check("fee sort is descending", feeDesc);
  if (wrows[0]) console.log("   top fee payer:", JSON.stringify({
    user_id: wrows[0].user_id, x: wrows[0].x_name,
    swap: wrows[0].swap_fees_paid_usd, sweep: wrows[0].sweep_fees_paid_usd,
    streak: wrows[0].streak_save_fees_paid_usd, total: wrows[0].total_fees_paid_usd,
  }));

  // 6. streak filter
  const streak = await call("/api/admin/users/search", { minStreakSaves: 1, sort: "streak_save_fees_paid_usd", limit: 5 });
  check("streak-save filter works",
    streak.status === 200 && (streak.json?.data?.rows ?? []).every((r: any) => Number(r.streak_save_count) >= 1),
    `total=${streak.json?.data?.total} ${streak.ms}ms`);

  // 7. asOf reproducibility: the pinned snapshot cutoff must reproduce known figures
  const pinned = await call("/api/admin/users/search", {
    identifiers: "176389", asOf: "2026-09-21T16:30:00.000Z", limit: 1,
  });
  const r = pinned.json?.data?.rows?.[0];
  const expected = {
    swap_count: 1262, swap_volume_usd: "115039.47", swap_fees_paid_usd: "249.9577",
    sweep_count: 95, sweep_fees_paid_usd: "338.0632", streak_save_fees_paid_usd: "8.00",
    checkin_count: 126, spin_count: 354,
  };
  const mismatches = Object.entries(expected).filter(([k, v]) => String((r ?? {})[k]) !== String(v));
  check("asOf cutoff reproduces the 2026-09-21 snapshot row for #176389",
    !!r && mismatches.length === 0,
    mismatches.length ? JSON.stringify(mismatches.map(([k, v]) => `${k}: got ${(r ?? {})[k]}, want ${v}`)) : `${pinned.ms}ms`);

  // 8. CSV export
  const csv = await call("/api/admin/users/export", { minStreakSaves: 1, limit: 25 });
  const lines = csv.text.split("\n");
  check("export returns CSV with a header and rows",
    csv.status === 200 && lines.length > 1 && lines[0].includes("total_fees_paid_usd"),
    `lines=${lines.length} ${csv.ms}ms`);
  check("export is CSV content-type",
    (csv.res.headers.get("content-type") || "").includes("text/csv"));

  // 8b. a realistic bulk export: every account that paid anything
  const bulk = await call("/api/admin/users/export", { minTotalFees: 0.01, limit: 100000 });
  const bulkLines = bulk.text.split("\n").filter(Boolean);
  check(
    "bulk export of all fee payers completes",
    bulk.status === 200 && bulkLines.length > 1000,
    `rows=${bulkLines.length - 1} ${(bulk.ms / 1000).toFixed(1)}s`
  );

  // 9. summary
  const sum = await call("/api/admin/users/summary");
  check("summary returns totals", sum.status === 200 && Number(sum.json?.data?.accounts) > 0,
    `${sum.ms}ms`);
  if (sum.json?.data) console.log("   summary:", JSON.stringify(sum.json.data));

  await closeDbPool();
})().catch(async (e) => {
  console.error("SMOKE TEST ERROR", e);
  process.exitCode = 1;
  await closeDbPool().catch(() => {});
});
