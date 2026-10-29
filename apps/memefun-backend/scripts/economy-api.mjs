/* global process, setTimeout, clearTimeout, URL, AbortController, console */
/**
 * A small streaming gateway keeps the public port available while the expensive Ponder
 * process is idle. Each wake uses the SAME physical schema, so Ponder recovers its
 * persisted checkpoint instead of starting a fresh index. An explicit schema can resume
 * the same indexing build across deployments; Ponder still owns its exclusive writer lock.
 *
 * The keeper must wake this gateway and wait for /ready before using an idle index.
 * This file deliberately imports neither application dependencies nor signing keys.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setMaxListeners } from "node:events";
import { publicDeliveryConfig, publicDeliveryRedirectFor } from "../lib/public-delivery-policy.mjs";

const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const GATEWAY_HEADERS = { "access-control-allow-origin": "*", "access-control-expose-headers": "Retry-After",
  "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const PREFLIGHT_HEADERS = new Set(["authorization", "x-admin-token", "content-type", "if-none-match", "if-modified-since", "range"]);

/** Preserve origin, cookies, authorization, host, compression and trusted ingress IP headers. */
export function proxyHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(headers.connection ?? "").split(",")) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

function integer(value, fallback, min, max, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}.`);
  return parsed;
}

export function economyConfig(env = process.env) {
  const port = integer(env.PORT, 42069, 1, 65534, "PORT");
  const upstreamPort = integer(env.MEMEFUN_API_UPSTREAM_PORT, port + 1, 1, 65535, "MEMEFUN_API_UPSTREAM_PORT");
  if (port === upstreamPort) throw new Error("Public and private API ports must differ.");
  const schema = env.MEMEFUN_INDEX_SCHEMA?.trim() || env.RAILWAY_DEPLOYMENT_ID;
  const viewsSchema = env.DATABASE_VIEWS_SCHEMA || "memefun_mainnet";
  if (!schema || !/^[a-zA-Z0-9_-]{1,45}$/.test(schema) || schema === viewsSchema) {
    throw new Error("A distinct RAILWAY_DEPLOYMENT_ID or MEMEFUN_INDEX_SCHEMA is required.");
  }
  return {
    env, port, upstreamPort, schema, viewsSchema,
    idleMs: integer(env.MEMEFUN_API_IDLE_MS, 60_000, 10_000, 86_400_000, "MEMEFUN_API_IDLE_MS"),
    // First historical indexing can outlast a normal cold wake. Requests keep their short
    // independent wait below; /ready remains 503 until Ponder has actually caught up.
    warmupMs: integer(env.MEMEFUN_API_WARMUP_MS, 3_600_000, 1_000, 86_400_000, "MEMEFUN_API_WARMUP_MS"),
    // Return an explicit retryable 503 before the browser's 15 s / keeper's 20 s attempt ends.
    requestWaitMs: integer(env.MEMEFUN_API_WAIT_MS, 10_000, 100, 600_000, "MEMEFUN_API_WAIT_MS"),
    maxQueue: 100,
  };
}

function delay(ms) {
  let timer;
  const promise = new Promise(resolveDelay => { timer = setTimeout(resolveDelay, ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function until(promise, ms) {
  const timeout = delay(ms);
  try { return await Promise.race([promise.then(() => true), timeout.promise.then(() => false)]); }
  finally { timeout.cancel(); }
}

function unavailable(res, code = "api_warming", status = 503) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { ...GATEWAY_HEADERS, "content-type": "application/json", "retry-after": "2" });
  res.end(JSON.stringify({ error: { code, message: "The API is reconnecting. Please retry shortly." } }));
}

function probeReady(port) {
  return new Promise(resolveProbe => {
    let settled = false;
    const finish = ready => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe(ready);
    };
    const req = http.get({ hostname: "127.0.0.1", port, path: "/ready", agent: false }, res => {
      const ready = res.statusCode === 200;
      res.resume();
      res.once("end", () => finish(ready));
      res.once("error", () => finish(false));
    });
    // A wall-clock bound also covers a partial response that never ends.
    const timeout = setTimeout(() => { req.destroy(); finish(false); }, 1_000);
    req.once("error", () => finish(false));
  });
}

function spawnPonder({ env, schema, viewsSchema, upstreamPort }) {
  const bin = fileURLToPath(new URL("./bin/ponder.js", import.meta.resolve("ponder")));
  return spawn(process.execPath, [bin, "start", "--schema", schema, "--views-schema", viewsSchema,
    "--hostname", "127.0.0.1", "--port", String(upstreamPort)], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...env, PORT: String(upstreamPort) },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/** Injectable timing/spawn hooks are for real-HTTP tests; CLI values are validated above. */
export function createEconomyApi(options) {
  // Node's unspecified host binds IPv6 (and dual-stack IPv4 where supported), preserving
  // Railway private-network access as well as its public ingress.
  const config = { host: undefined, probeMs: 250, stopGraceMs: 10_000, shutdownMs: 30_000, eager: true,
    spawnWorker: spawnPonder, log: () => undefined, ...options };
  const publicDelivery = publicDeliveryConfig(config.env?.PUBLIC_API_URL, config.env?.PUBLIC_DELIVERY_URL);
  let phase = "cold";
  let worker = null;
  let idleTimer;
  let lastActivity = Date.now();
  let waiting = 0;
  let closing = false;
  let closePromise;
  const pending = new Set();
  const sockets = new Set();
  const closingController = new AbortController();
  // Waiting callers remove these listeners on settlement; cold queues are bounded separately.
  setMaxListeners(0, closingController.signal);

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (closing || phase !== "warm" || pending.size !== 0) return;
    const remaining = Math.max(0, lastActivity + config.idleMs - Date.now());
    idleTimer = setTimeout(() => {
      if (!closing && phase === "warm" && pending.size === 0 && Date.now() >= lastActivity + config.idleMs) {
        void stopWorker().catch(() => config.log("worker_stop_failed"));
      } else scheduleIdle();
    }, remaining);
    idleTimer.unref?.();
  }

  async function stopWorker() {
    const current = worker;
    clearTimeout(idleTimer);
    if (!current) return;
    if (current.stopping) return current.stopping;
    phase = "stopping";
    current.stopping = (async () => {
      current.child.kill("SIGTERM");
      if (!await until(current.closed, config.stopGraceMs)) {
        current.child.kill("SIGKILL");
        if (!await until(current.closed, 1_000)) throw new Error("Worker did not stop.");
      }
    })();
    return current.stopping;
  }

  function ensureWarm() {
    if (closing) return Promise.reject(new Error("Gateway is shutting down."));
    if (phase === "warm") return Promise.resolve();
    if (phase === "stopping") return worker.stopping.then(() => ensureWarm());
    if (phase === "starting") return worker.ready;
    phase = "starting";
    let child;
    try { child = config.spawnWorker(config); }
    catch {
      phase = "cold";
      return Promise.reject(new Error("Worker failed to start."));
    }
    let resolveClosed;
    const current = { child, exited: false, stopping: null, ready: null,
      closed: new Promise(resolveClose => { resolveClosed = resolveClose; }) };
    worker = current;
    const markClosed = () => {
      if (current.exited) return;
      current.exited = true;
      resolveClosed();
      if (worker === current) {
        worker = null;
        phase = closing ? "closed" : "cold";
        clearTimeout(idleTimer);
      }
    };
    child.once("close", markClosed);
    // An unsuccessful spawn emits both error and close. Do not expose command/env/error text.
    child.once("error", () => { if (!child.pid) markClosed(); });
    current.ready = (async () => {
      const deadline = Date.now() + config.warmupMs;
      while (!current.exited && !closing && phase === "starting" && worker === current) {
        if (await probeReady(config.upstreamPort)) {
          if (current.exited || closing || phase !== "starting" || worker !== current) break;
          phase = "warm";
          lastActivity = Date.now();
          config.log("worker_ready");
          scheduleIdle();
          return;
        }
        if (Date.now() >= deadline) break;
        const pause = delay(config.probeMs);
        try { await Promise.race([pause.promise, current.closed]); }
        finally { pause.cancel(); }
      }
      if (!current.exited && worker === current) await stopWorker();
      throw new Error("Worker is not ready.");
    })();
    return current.ready;
  }

  function waitForWarm(signal) {
    return new Promise((resolveWarm, rejectWarm) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        closingController.signal.removeEventListener("abort", abort);
        if (error) rejectWarm(error); else resolveWarm();
      };
      const abort = () => finish(new Error("Request cancelled."));
      const timeout = setTimeout(() => finish(new Error("Worker wait timed out.")), config.requestWaitMs);
      signal.addEventListener("abort", abort, { once: true });
      closingController.signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || closing) { abort(); return; }
      ensureWarm().then(() => finish(), () => finish(new Error("Worker unavailable.")));
    });
  }

  async function handle(req, res) {
    if (closing) { unavailable(res, "api_stopping"); return; }
    const path = req.url ?? "/";
    if (!path.startsWith("/")) { unavailable(res, "invalid_path", 400); return; }
    const pathname = path.split("?", 1)[0];
    if (req.method === "OPTIONS") {
      const requested = String(req.headers["access-control-request-headers"] ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
      if (requested.some(name => !PREFLIGHT_HEADERS.has(name))) { unavailable(res, "unsupported_preflight", 403); return; }
      res.writeHead(204, { ...GATEWAY_HEADERS, "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": [...new Set(requested)].join(","), "access-control-max-age": "86400",
        vary: "Origin, Access-Control-Request-Headers" });
      res.end();
      return;
    }
    // Reuse the API's exact route/CID/credential policy. Old public URLs should reach the
    // CDN without waking the indexer; the alias itself and private requests still reach Ponder.
    let absoluteUrl;
    try { absoluteUrl = new URL(`http://${req.headers.host ?? "localhost"}${path}`); }
    catch { unavailable(res, "invalid_path", 400); return; }
    const redirect = publicDeliveryRedirectFor(publicDelivery, {
      method: req.method ?? "GET", url: absoluteUrl, headers: req.headers,
    });
    if (redirect) {
      res.writeHead(redirect.status, { ...GATEWAY_HEADERS, ...redirect.headers, location: redirect.location });
      res.end();
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/health") {
      res.writeHead(200, { ...GATEWAY_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: "economy", worker: phase, active: pending.size }));
      return;
    }
    const healthProbe = pathname === "/ready";
    if (healthProbe && phase !== "warm") { unavailable(res); return; }
    const queued = phase !== "warm";
    if (queued && waiting >= config.maxQueue) { unavailable(res, "api_busy"); return; }
    if (queued) waiting += 1;
    const controller = new AbortController();
    const entry = { req, res, upstream: null, response: null, queued };
    pending.add(entry);
    clearTimeout(idleTimer);
    let released = false;
    const releaseQueue = () => {
      if (!entry.queued) return;
      entry.queued = false;
      waiting -= 1;
    };
    const release = () => {
      if (released) return;
      released = true;
      releaseQueue();
      controller.abort();
      entry.upstream?.destroy();
      entry.response?.destroy();
      pending.delete(entry);
      if (!healthProbe) lastActivity = Date.now();
      scheduleIdle();
    };
    res.once("finish", release);
    res.once("close", release);
    res.once("error", release);
    req.once("aborted", () => { release(); res.destroy(); });
    req.once("error", () => { release(); res.destroy(); });
    try {
      await waitForWarm(controller.signal);
      releaseQueue();
      if (controller.signal.aborted || res.destroyed || closing) return;
      const upstream = http.request({ hostname: "127.0.0.1", port: config.upstreamPort,
        method: req.method, path, headers: proxyHeaders(req.headers), agent: false }, response => {
        entry.response = response;
        if (released) { response.destroy(); return; }
        res.writeHead(response.statusCode ?? 502, proxyHeaders(response.headers));
        res.flushHeaders();
        response.once("error", () => { release(); res.destroy(); });
        response.once("aborted", () => { release(); res.destroy(); });
        response.pipe(res);
      });
      entry.upstream = upstream;
      upstream.once("error", () => unavailable(res, "api_unavailable"));
      // Nothing consumes request bodies while starting: Node/TCP backpressure bounds buffering.
      req.pipe(upstream);
    } catch {
      releaseQueue();
      if (!controller.signal.aborted && !res.destroyed) unavailable(res);
    }
  }

  const server = http.createServer((req, res) => { void handle(req, res).catch(() => unavailable(res)); });
  server.headersTimeout = 20_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  // MemeFun uses SSE, not WebSockets; unsupported upgrades must not become open proxy tunnels.
  server.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });

  return {
    server,
    get state() { return { phase, active: pending.size, waiting, pid: worker?.child.pid ?? null }; },
    ensureWarm,
    async start() {
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(config.port, config.host, () => { server.off("error", rejectListen); resolveListen(); });
      });
      if (config.eager) void ensureWarm().catch(() => config.log("worker_start_failed"));
      return server.address().port;
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearTimeout(idleTimer);
        closingController.abort();
        const stopped = new Promise(resolveClose => server.close(() => resolveClose()));
        const drainMs = Math.max(0, config.shutdownMs - config.stopGraceMs - 1_000);
        await until(stopped, drainMs);
        for (const { req, res, upstream, response } of pending) {
          req.destroy(); res.destroy(); upstream?.destroy(); response?.destroy();
        }
        for (const socket of sockets) socket.destroy();
        await stopWorker();
        phase = "closed";
        await stopped;
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gateway = createEconomyApi({ ...economyConfig(), log: event => console.log(JSON.stringify({ service: "memefun-economy", event })) });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void gateway.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await gateway.start();
}
