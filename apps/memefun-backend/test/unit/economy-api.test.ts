import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
// @ts-expect-error The plain Node entry deliberately has no TypeScript runtime dependency.
import { createEconomyApi, economyConfig, proxyHeaders } from "../../scripts/economy-api.mjs";

interface Gateway {
  start(): Promise<number>;
  close(): Promise<void>;
  state: { phase: string; active: number; waiting: number; pid: number | null };
}
interface Reply { status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }
const gateways: Gateway[] = [];
let directory: string;
let childScript: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "memefun-economy-test-"));
  childScript = join(directory, "worker.mjs");
  await writeFile(childScript, `
import http from 'node:http';
import { gzipSync } from 'node:zlib';
const readyAt = Date.now() + Number(process.env.TEST_READY_DELAY || 0);
const server = http.createServer((req,res) => {
  if (req.url === '/ready') { res.writeHead(Date.now() >= readyAt ? 200 : 503); res.end(); return; }
  if (req.url === '/crash') { process.exit(1); }
  if (req.url === '/gzip') { res.writeHead(200, {'content-encoding':'gzip','set-cookie':['one=1; HttpOnly','two=2; Secure']}); res.end(gzipSync('compressed payload')); return; }
  if (req.url === '/stream') { res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'}); res.write('data: first\\n\\n'); const timer=setInterval(()=>res.write('data: next\\n\\n'),25); res.on('close',()=>clearInterval(timer)); return; }
  if (req.url === '/slow') { setTimeout(()=>res.end('finished'),250); return; }
  if (req.method === 'POST' && req.headers.origin === 'https://foreign.example') { res.writeHead(403); res.end('origin_not_allowed'); return; }
  const chunks=[];
  req.on('data',data=>chunks.push(data));
  req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({pid:process.pid,headers:req.headers,body:Buffer.concat(chunks).toString('utf8'),ready:Date.now()>=readyAt}));});
});
server.listen(Number(process.env.PORT),'127.0.0.1');
const stop = ()=>setTimeout(()=>server.close(()=>process.exit(0)),Number(process.env.TEST_STOP_DELAY || 0));
process.on('SIGTERM',stop);
process.on('message',message=>{ if(message.stop) stop(); });
if (process.env.TEST_EXIT_EARLY) setTimeout(()=>process.exit(1),10);
`);
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
});
afterAll(async () => {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("memefun-economy-test-")) {
    throw new Error("Refusing to remove an unexpected test directory.");
  }
  await rm(target, { recursive: true, force: true });
});

async function freePort() {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function setup(options: { idleMs?: number; eager?: boolean; maxQueue?: number; readyDelay?: number;
  stopDelay?: number; requestWaitMs?: number; warmupMs?: number; exitEarly?: boolean; delivery?: boolean } = {}) {
  let starts = 0;
  const upstreamPort = await freePort();
  const gateway = createEconomyApi({
    port: 0, host: "127.0.0.1", upstreamPort, schema: "same_deployment", viewsSchema: "memefun_mainnet",
    idleMs: options.idleMs ?? 120, probeMs: 15, stopGraceMs: 300, shutdownMs: 1_500,
    requestWaitMs: options.requestWaitMs ?? 4_000, warmupMs: options.warmupMs ?? 4_000,
    eager: options.eager ?? true, maxQueue: options.maxQueue ?? 100,
    env: options.delivery ? { PUBLIC_API_URL: "https://api.example", PUBLIC_DELIVERY_URL: "https://cdn.example" } : {},
    spawnWorker: () => {
      starts += 1;
      const child = spawn(process.execPath, [childScript], { env: { ...process.env, PORT: String(upstreamPort),
        TEST_READY_DELAY: String(options.readyDelay ?? 0), TEST_STOP_DELAY: String(options.stopDelay ?? 0),
        TEST_EXIT_EARLY: options.exitEarly ? "1" : "" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      // Windows forcibly terminates on kill(SIGTERM). IPC models Linux's graceful handler
      // while the gateway still uses real sockets and a real child process/close event.
      const kill = child.kill.bind(child);
      child.kill = signal => signal === "SIGTERM" && child.connected ? child.send({ stop: true }) : kill(signal);
      return child;
    },
  }) as Gateway;
  gateways.push(gateway);
  const port = await gateway.start();
  return { gateway, port, starts: () => starts };
}

function request(port: number, path: string, options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}) {
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: options.headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

async function eventually(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Condition timed out.");
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

describe("economy API gateway", () => {
  it("validates CLI configuration and only removes hop-by-hop headers", () => {
    expect(() => economyConfig({ PORT: "0", RAILWAY_DEPLOYMENT_ID: "deployment" })).toThrow("PORT");
    expect(() => economyConfig({ PORT: "42069" })).toThrow("RAILWAY_DEPLOYMENT_ID");
    expect(() => economyConfig({ RAILWAY_DEPLOYMENT_ID: "deployment", MEMEFUN_API_IDLE_MS: "1" })).toThrow("IDLE");
    const defaults = economyConfig({ PORT: "4000", RAILWAY_DEPLOYMENT_ID: "deployment" });
    expect(defaults).toMatchObject({
      port: 4000, upstreamPort: 4001, schema: "deployment", viewsSchema: "memefun_mainnet", idleMs: 60_000,
      requestWaitMs: 10_000, warmupMs: 3_600_000,
    });
    // The error must reach both clients before their attempt aborts or neither retry path runs.
    expect(defaults.requestWaitMs).toBeLessThan(15_000);
    expect(defaults.requestWaitMs).toBeLessThan(20_000);
    expect(proxyHeaders({ connection: "keep-alive, remove-me", "remove-me": "secret", authorization: "Bearer auth",
      "x-forwarded-for": "198.51.100.2", cookie: "session=1", "accept-encoding": "gzip" })).toEqual({
      authorization: "Bearer auth", "x-forwarded-for": "198.51.100.2", cookie: "session=1", "accept-encoding": "gzip",
    });
  });

  it("pins an explicit compatible schema across deployments without changing the views schema", () => {
    const first = economyConfig({ RAILWAY_DEPLOYMENT_ID: "old-deployment", MEMEFUN_INDEX_SCHEMA: " resumed-index ", DATABASE_VIEWS_SCHEMA: "memefun_mainnet" });
    const next = economyConfig({ RAILWAY_DEPLOYMENT_ID: "new-deployment", MEMEFUN_INDEX_SCHEMA: "resumed-index", DATABASE_VIEWS_SCHEMA: "memefun_mainnet" });
    expect(first.schema).toBe("resumed-index");
    expect(next.schema).toBe(first.schema);
    expect(next.viewsSchema).toBe("memefun_mainnet");
    expect(() => economyConfig({ RAILWAY_DEPLOYMENT_ID: "deployment", MEMEFUN_INDEX_SCHEMA: "memefun_mainnet" })).toThrow("distinct");
    expect(() => economyConfig({ RAILWAY_DEPLOYMENT_ID: "deployment", MEMEFUN_INDEX_SCHEMA: "invalid;schema" })).toThrow("distinct");
    expect(economyConfig({ RAILWAY_DEPLOYMENT_ID: "deployment", MEMEFUN_API_WARMUP_MS: "7200000" }).warmupMs).toBe(7_200_000);
    expect(() => economyConfig({ RAILWAY_DEPLOYMENT_ID: "deployment", MEMEFUN_API_WARMUP_MS: "86400001" })).toThrow("WARMUP");
  });

  it("keeps backfill running beyond a caller's wait while liveness and readiness stay distinct", async () => {
    const { gateway, port, starts } = await setup({ readyDelay: 500, requestWaitMs: 60, warmupMs: 2_000, idleMs: 1_000 });
    expect((await request(port, "/echo")).status).toBe(503);
    const health = await request(port, "/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.bytes.toString()).worker).toBe("starting");
    expect((await request(port, "/ready")).status).toBe(503);
    expect(gateway.state.phase).toBe("starting");
    await eventually(() => gateway.state.phase === "warm");
    expect((await request(port, "/ready")).status).toBe(200);
    expect(starts()).toBe(1);
  });

  it("gates readiness, streams authenticated POST bodies after warmup, and preserves gzip/cookies", async () => {
    const { gateway, port } = await setup({ readyDelay: 180, idleMs: 1_000 });
    const cold = await request(port, "/ready");
    expect(cold.status).toBe(503);
    expect(cold.headers["access-control-allow-origin"]).toBe("*");
    expect(cold.headers["access-control-expose-headers"]).toBe("Retry-After");
    expect(cold.headers["access-control-allow-credentials"]).toBeUndefined();
    const body = "x".repeat(256 * 1024);
    const result = await request(port, "/echo", { method: "POST", body, headers: {
      authorization: "Bearer wallet-session", cookie: "wallet=abc", origin: "https://memefun.dustswap.wtf",
      host: "memefun-api.dustswap.wtf", "x-forwarded-for": "198.51.100.10", "x-forwarded-proto": "https",
      "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)),
    } });
    expect(result.status).toBe(200);
    const echo = JSON.parse(result.bytes.toString());
    expect(echo.body).toBe(body);
    expect(echo.ready).toBe(true);
    expect(echo.headers).toMatchObject({ authorization: "Bearer wallet-session", cookie: "wallet=abc",
      origin: "https://memefun.dustswap.wtf", host: "memefun-api.dustswap.wtf", "x-forwarded-for": "198.51.100.10", "x-forwarded-proto": "https" });
    expect((await request(port, "/ready")).status).toBe(200);
    const warmHealth = JSON.parse((await request(port, "/health")).bytes.toString());
    expect(warmHealth).toEqual({ ok: true, mode: "economy", worker: "warm", active: 0 });
    const gzip = await request(port, "/gzip");
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gzip.headers["set-cookie"]).toEqual(["one=1; HttpOnly", "two=2; Secure"]);
    expect(gunzipSync(gzip.bytes).toString()).toBe("compressed payload");
    expect(gateway.state.active).toBe(0);
  });

  it("serves preflight without waking and leaves cross-origin write rejection to the upstream", async () => {
    const { port, starts } = await setup({ eager: false, idleMs: 1_000 });
    const preflight = await request(port, "/echo", { method: "OPTIONS", headers: {
      origin: "https://foreign.example", "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,x-admin-token",
    } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(preflight.headers["access-control-allow-headers"]).toBe("authorization,content-type,x-admin-token");
    expect(starts()).toBe(0);
    expect((await request(port, "/echo", { method: "OPTIONS", headers: { "access-control-request-headers": "x-unknown" } })).status).toBe(403);
    const blocked = await request(port, "/echo", { method: "POST", headers: { origin: "https://foreign.example" }, body: "data" });
    expect(blocked.status).toBe(403);
    expect(blocked.bytes.toString()).toBe("origin_not_allowed");
    expect(starts()).toBe(1);
  });

  it("redirects canonical anonymous reads and valid CIDs while cold without spawning", async () => {
    const { gateway, port, starts } = await setup({ eager: false, delivery: true });
    const query = "/v1/coins?q=cat%20dog&limit=20";
    const catalog = await request(port, query, { headers: { host: "api.example" } });
    expect(catalog.status).toBe(307);
    expect(catalog.headers.location).toBe(`https://cdn.example${query}`);
    expect(catalog.headers["cache-control"]).toBe("public, max-age=300");
    expect(catalog.headers.vary).toBe("Authorization, Cookie, X-Admin-Token, Range");
    expect(catalog.headers["access-control-allow-origin"]).toBe("*");
    const cid = `b${"a".repeat(50)}`;
    const image = await request(port, `/media/${cid}`, { method: "HEAD", headers: { host: "api.example" } });
    expect(image.status).toBe(307);
    expect(image.headers.location).toBe(`https://cdn.example/media/${cid}`);
    expect(image.bytes.length).toBe(0);
    expect(starts()).toBe(0);
    expect(gateway.state.phase).toBe("cold");
  });

  it("keeps credential/range, invalid-CID and alias traffic on the normal upstream path", async () => {
    const { port, starts } = await setup({ eager: false, delivery: true, idleMs: 1_000 });
    for (const header of ["authorization", "cookie", "x-admin-token", "range"]) {
      const reply = await request(port, "/v1/coins", { headers: { host: "api.example", [header]: "private" } });
      expect(reply.status).toBe(200);
      expect(reply.headers.location).toBeUndefined();
      expect(JSON.parse(reply.bytes.toString()).headers[header]).toBe("private");
    }
    const invalid = await request(port, "/media/not-a-cid", { headers: { host: "api.example" } });
    expect(invalid.status).toBe(200);
    expect(invalid.headers.location).toBeUndefined();
    const alias = await request(port, "/v1/coins", { headers: { host: "cdn.example", "x-forwarded-host": "api.example",
      forwarded: "host=api.example;proto=https" } });
    expect(alias.status).toBe(200);
    expect(alias.headers.location).toBeUndefined();
    expect(starts()).toBe(1);
  });

  it("does not trust a forged forwarded host to redirect a cold request", async () => {
    const { port, starts } = await setup({ eager: false, delivery: true, idleMs: 1_000 });
    const reply = await request(port, "/v1/coins", { headers: { host: "other.example", "x-forwarded-host": "api.example" } });
    expect(reply.status).toBe(200);
    expect(reply.headers.location).toBeUndefined();
    expect(starts()).toBe(1);
  });

  it("sleeps when idle, leaves health probes cheap, and shares one concurrent wake", async () => {
    const { gateway, port, starts } = await setup();
    const first = await request(port, "/echo");
    const firstPid = JSON.parse(first.bytes.toString()).pid;
    await eventually(() => gateway.state.phase === "cold");
    const health = await request(port, "/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.bytes.toString())).toEqual({ ok: true, mode: "economy", worker: "cold", active: 0 });
    expect((await request(port, "/ready")).status).toBe(503);
    expect(starts()).toBe(1);
    const replies = await Promise.all(Array.from({ length: 8 }, () => request(port, "/echo")));
    const pids = new Set(replies.map(reply => JSON.parse(reply.bytes.toString()).pid));
    expect(pids.size).toBe(1);
    expect(pids.has(firstPid)).toBe(false);
    expect(starts()).toBe(2);
  });

  it("keeps the worker alive for slow responses and SSE until the client disconnects", async () => {
    const { gateway, port, starts } = await setup({ idleMs: 80 });
    expect((await request(port, "/slow")).bytes.toString()).toBe("finished");
    expect(starts()).toBe(1);
    const streaming = await new Promise<{ req: http.ClientRequest; res: http.IncomingMessage; first: string }>((resolve, reject) => {
      const req = http.get({ hostname: "127.0.0.1", port, path: "/stream", agent: false }, res => {
        res.once("data", chunk => resolve({ req, res, first: String(chunk) }));
      });
      req.on("error", reject);
    });
    expect(streaming.first).toContain("data: first");
    await new Promise(resolve => setTimeout(resolve, 240));
    expect(gateway.state).toMatchObject({ phase: "warm", active: 1 });
    streaming.req.destroy(); streaming.res.destroy();
    await eventually(() => gateway.state.phase === "cold");
    expect(gateway.state.active).toBe(0);
  });

  it("waits for SIGTERM completion before waking a replacement", async () => {
    const { gateway, port, starts } = await setup({ idleMs: 60, stopDelay: 150 });
    await request(port, "/echo");
    await eventually(() => gateway.state.phase === "stopping");
    expect((await request(port, "/echo")).status).toBe(200);
    expect(starts()).toBe(2);
  });

  it("bounds queued requests, releases aborted clients, and rejects timed-out wakes without replay", async () => {
    const { gateway, port, starts } = await setup({ eager: false, maxQueue: 1, readyDelay: 500, requestWaitMs: 200 });
    const aborted = http.request({ hostname: "127.0.0.1", port, path: "/echo", method: "POST", agent: false });
    aborted.on("error", () => undefined);
    aborted.write("partial body");
    await eventually(() => gateway.state.waiting === 1);
    expect((await request(port, "/echo")).status).toBe(503);
    aborted.destroy();
    await eventually(() => gateway.state.waiting === 0);
    const timeout = await request(port, "/echo");
    expect(timeout.status).toBe(503);
    expect(timeout.headers["retry-after"]).toBe("2");
    expect(starts()).toBe(1);
    await eventually(() => gateway.state.active === 0);
  });

  it("does not restart-loop after an early child failure and drains active streams on shutdown", async () => {
    const broken = await setup({ exitEarly: true, readyDelay: 1_000 });
    expect((await request(broken.port, "/echo")).status).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(broken.starts()).toBe(1);
    const { gateway, port } = await setup({ idleMs: 1_000 });
    const stream = http.get({ hostname: "127.0.0.1", port, path: "/stream", agent: false });
    stream.on("error", () => undefined);
    stream.on("response", response => { response.on("error", () => undefined); response.resume(); });
    await eventually(() => gateway.state.phase === "warm" && gateway.state.active === 1);
    await gateway.close();
    expect(gateway.state).toMatchObject({ phase: "closed", active: 0, pid: null });
    stream.destroy();
  });
});
