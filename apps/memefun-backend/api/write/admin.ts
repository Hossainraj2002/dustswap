import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

import type { AppStore } from "../../lib/app-store";
import { type Queryable, rows } from "../../lib/db";
import { HttpError, parseAddress, parseLimit } from "../http";
import type { MarketSnapshot } from "../read/snapshot";

/**
 * The admin page's backend: moderation (hide, feature), the site banner, the report queue,
 * comment removal, and read-outs of keeper runs, reward epochs and the on-chain settings history.
 * Every route needs `x-admin-token`; without ADMIN_TOKEN configured the whole surface is off.
 */
export interface AdminDeps {
  token: string | undefined;
  app: AppStore;
  index: Queryable;
  snapshot: MarketSnapshot;
}

const MIN_TOKEN_LENGTH = 32;

export function adminGuard(token: string | undefined): MiddlewareHandler {
  const expected = token && token.length >= MIN_TOKEN_LENGTH ? createHash("sha256").update(token).digest() : null;
  return async (c, next) => {
    if (!expected) throw new HttpError(503, "admin_disabled", "Admin access is not configured on this server.");
    // Compare digests so the comparison is constant-time whatever the given token's length.
    const given = createHash("sha256").update(c.req.header("x-admin-token") ?? "").digest();
    if (!timingSafeEqual(given, expected)) throw new HttpError(401, "admin_token", "Admin token missing or wrong.");
    await next();
  };
}

const moderationBody = z.object({ hidden: z.boolean().optional(), featured: z.boolean().optional(), note: z.string().max(500).optional() });

export function adminRoutes(deps: AdminDeps) {
  const app = new Hono();
  app.use("/v1/admin/*", adminGuard(deps.token));

  app.get("/v1/admin/overview", async (c) => {
    const [openReports, runs, lastEpoch] = await Promise.all([deps.app.reports("open", 200), deps.app.keeperRuns(20), deps.app.lastRewardEpoch()]);
    const state = deps.snapshot.current;
    return c.json({
      coins: state.coins.length,
      hiddenCoins: state.coins.filter((coin) => coin.hidden).map((coin) => coin.address),
      featuredCoins: state.coins.filter((coin) => coin.featured).map((coin) => coin.address),
      banner: state.banner,
      openReports: openReports.length,
      lastEpoch: lastEpoch ? { ...lastEpoch, epoch: lastEpoch.epoch.toString() } : null,
      keeperRuns: runs,
    });
  });

  app.post("/v1/admin/coins/:address/moderation", async (c) => {
    const coin = parseAddress(c.req.param("address"));
    const parsed = moderationBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || Object.keys(parsed.data).length === 0) throw new HttpError(400, "invalid_request", "Send hidden, featured or note.");
    await deps.app.setModeration(coin, parsed.data);
    await deps.snapshot.refresh();
    return c.json({ coin, ...parsed.data });
  });

  app.post("/v1/admin/banner", async (c) => {
    const parsed = z.object({ text: z.string().max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Send the banner as `text`, up to 200 characters.");
    const text = parsed.data.text.replace(/\s+/g, " ").trim();
    await deps.app.setSetting("banner", { text });
    await deps.snapshot.refresh();
    return c.json({ banner: text });
  });

  app.get("/v1/admin/reports", async (c) => {
    const status = c.req.query("status") ?? "open";
    if (status !== "open" && status !== "dismissed" && status !== "actioned") throw new HttpError(400, "invalid_status", "status must be open, dismissed or actioned.");
    return c.json({ reports: await deps.app.reports(status, parseLimit(c.req.query("limit"), 100, 500)) });
  });

  app.post("/v1/admin/reports/:id", async (c) => {
    const parsed = z.object({ status: z.enum(["dismissed", "actioned"]) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "status must be dismissed or actioned.");
    const id = c.req.param("id");
    if (!/^\d{1,18}$/.test(id) || !(await deps.app.resolveReport(id, parsed.data.status))) throw new HttpError(404, "report_not_found", "No open report with that id.");
    return c.json({ id, status: parsed.data.status });
  });

  app.post("/v1/admin/comments/:id/hide", async (c) => {
    const parsed = z.object({ hidden: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Send hidden: true or false.");
    const id = c.req.param("id");
    if (!/^\d{1,18}$/.test(id) || !(await deps.app.hideComment(id, parsed.data.hidden))) throw new HttpError(404, "comment_not_found", "No comment with that id.");
    return c.json({ id, hidden: parsed.data.hidden });
  });

  app.get("/v1/admin/keeper-runs", async (c) => c.json({ runs: await deps.app.keeperRuns(parseLimit(c.req.query("limit"), 50, 500)) }));

  app.get("/v1/admin/settings-history", async (c) => {
    const limit = parseLimit(c.req.query("limit"), 100, 500);
    const changes = await rows(
      deps.index,
      `SELECT id, kind, key, old_value, new_value, detail, block_number, timestamp, tx_hash FROM setting_change ORDER BY block_number DESC, id DESC LIMIT $1`,
      [limit],
    );
    return c.json({ changes });
  });

  return app;
}
