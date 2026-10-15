import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../api/http";
import { adminRoutes, type AdminDeps } from "../../api/write/admin";

const TOKEN = "unit-test-admin-token-that-is-long-enough";

function fixture() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = vi.fn(async () => {
    await gate;
    return { coins: [{ address: "fresh-coin", hidden: true, featured: false }], banner: "Fresh banner" };
  });
  const reports = vi.fn(async () => []);
  const routes = adminRoutes({ token: TOKEN, snapshot: { current: { coins: [], banner: "Old banner" }, ready },
    app: { reports, keeperRuns: async () => [], lastRewardEpoch: async () => null }, index: {} } as unknown as AdminDeps);
  const app = new Hono();
  app.onError((error, c) => c.json({ error: "rejected" }, error instanceof HttpError ? error.status : 500));
  app.route("/", routes);
  return { app, ready, reports, release };
}

describe("admin overview freshness after idle", () => {
  it("waits for a fresh view instead of showing the old idle snapshot", async () => {
    const f = fixture();
    let settled = false;
    const pending = Promise.resolve(f.app.request("/v1/admin/overview", { headers: { "x-admin-token": TOKEN } })).then((response) => { settled = true; return response; });
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    f.release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ coins: 1, hiddenCoins: ["fresh-coin"], banner: "Fresh banner" });
  });

  it("does not wake the market or query reports for an unauthenticated request", async () => {
    const f = fixture();
    const response = await f.app.request("/v1/admin/overview");
    expect(response.status).toBe(401);
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.reports).not.toHaveBeenCalled();
  });
});
