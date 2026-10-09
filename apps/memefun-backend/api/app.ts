import { Hono } from "hono";

import type { Deployment } from "../lib/deployment";
import type { MediaStore } from "../lib/media/store";
import { HttpError, errorBody, originGuard } from "./http";
import { mountMedia } from "./media";
import { type CampaignDeps, launchCampaignRoutes } from "./launch-campaign";
import { type PlatformTokenDeps, platformTokenRoutes } from "./platform-token";
import { mountOg } from "./read/og";
import { type ReadDeps, readRoutes } from "./read/routes";
import { type LiveHub, mountStream } from "./read/stream";
import { type AdminDeps, adminRoutes } from "./write/admin";
import { type AuthDeps, authRoutes } from "./write/auth";
import { type AuthorDeps, authorRoutes } from "./write/author";
import { type WriteDeps, writeRoutes } from "./write/routes";

export interface AppDeps {
  read: ReadDeps;
  write: WriteDeps;
  auth: AuthDeps;
  admin: AdminDeps;
  hub: LiveHub;
  media: MediaStore;
  allowedOrigins: Set<string>;
  /** The contracts this API indexes. Public; the app cross-checks it against its own build. */
  deployment: Deployment;
  author?: AuthorDeps;
  campaign?: CampaignDeps;
  platformToken?: PlatformTokenDeps;
}

/** The memefun HTTP API: read endpoints typed as the app's own data, writes, admin, media, cards. */
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      if (error.status === 429) c.header("Retry-After", "30");
      return c.json(errorBody(error), error.status);
    }
    console.error("[memefun api]", error);
    return c.json({ error: { code: "internal", message: "Something went wrong on our side. Try again." } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404));

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  });
  app.use("*", originGuard(deps.allowedOrigins));

  app.get("/v1/health", (c) => {
    const state = deps.read.snapshot.current;
    const healthy = deps.read.snapshot.healthy;
    return c.json({ ok: healthy, snapshot: state.version, coins: state.coins.length, asOf: state.nowSec * 1000, streams: deps.hub.size }, healthy ? 200 : 503);
  });

  app.get("/v1/deployment", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ deployment: deps.deployment });
  });

  app.route("/", readRoutes(deps.read));
  mountStream(app, deps.hub);
  mountOg(app, { snapshot: deps.read.snapshot, media: deps.media });
  mountMedia(app, deps.media);
  app.route("/", authRoutes(deps.auth));
  if (deps.author) app.route("/", authorRoutes(deps.author));
  app.route("/", launchCampaignRoutes(deps.campaign));
  app.route("/", platformTokenRoutes(deps.platformToken));
  app.route("/", writeRoutes(deps.write));
  app.route("/", adminRoutes(deps.admin));
  // Ponder owns the server's own 404; anything under /v1 that matched nothing gets ours.
  app.all("/v1/*", () => {
    throw new HttpError(404, "not_found", "No such endpoint.");
  });
  return app;
}
