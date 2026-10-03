/**
 * Local Postgres for the memefun backend: one `postgres:16-alpine` container with its own volume,
 * on port 54329 so it never collides with other local databases. (Ponder supports Postgres 14+;
 * override the image with MEMEFUN_PG_IMAGE.)
 *
 *   pnpm dev:db            start (or create) the container and wait until it accepts connections
 *   pnpm dev:db --reset    delete the container AND its data, then start fresh
 *   pnpm dev:db --stop     stop the container (data kept)
 *
 * On Windows, Docker runs inside WSL (MEMEFUN_WSL_DISTRO, default Ubuntu-24.04).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTAINER = "memefun-pg";
const DISTRO = process.env.MEMEFUN_WSL_DISTRO ?? "Ubuntu-24.04";
const KEEPALIVE_PID = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "data", "wsl-keepalive.pid");
const VOLUME = "memefun-pg-data";
const PORT = 54329;
const IMAGE = process.env.MEMEFUN_PG_IMAGE ?? "postgres:16-alpine";
export const DEV_DATABASE_URL = `postgres://memefun:memefun@127.0.0.1:${PORT}/memefun`;

function docker(args: string[], options: { quiet?: boolean } = {}): string {
  const [cmd, cmdArgs] = process.platform === "win32" ? ["wsl", ["-d", DISTRO, "--", "docker", ...args]] : ["docker", args];
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: options.quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "inherit"] }).trim();
}

function state(): "running" | "stopped" | "missing" {
  try {
    const status = docker(["inspect", "-f", "{{.State.Running}}", CONTAINER], { quiet: true });
    return status === "true" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

async function waitReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      docker(["exec", CONTAINER, "pg_isready", "-U", "memefun", "-d", "memefun"], { quiet: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${CONTAINER} did not become ready within ${timeoutMs / 1000}s`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * WSL stops a distro (and Docker and Postgres with it) about a minute after its last wsl.exe
 * session ends, even with services running inside. A detached `sleep infinity` session keeps it up
 * until `pnpm dev:db --stop`.
 */
function ensureWslKeepAlive() {
  if (process.platform !== "win32") return;
  if (existsSync(KEEPALIVE_PID) && processAlive(Number(readFileSync(KEEPALIVE_PID, "utf8")))) return;
  const child = spawn("wsl", ["-d", DISTRO, "--", "sleep", "infinity"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  mkdirSync(dirname(KEEPALIVE_PID), { recursive: true });
  writeFileSync(KEEPALIVE_PID, String(child.pid));
}

function stopWslKeepAlive() {
  if (!existsSync(KEEPALIVE_PID)) return;
  const pid = Number(readFileSync(KEEPALIVE_PID, "utf8"));
  if (processAlive(pid)) process.kill(pid);
  rmSync(KEEPALIVE_PID);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--stop")) {
    if (state() === "running") docker(["stop", CONTAINER]);
    stopWslKeepAlive();
    console.log(`${CONTAINER} stopped (data kept).`);
    return;
  }
  ensureWslKeepAlive();
  if (args.has("--reset")) {
    if (state() !== "missing") docker(["rm", "-f", CONTAINER]);
    try {
      docker(["volume", "rm", VOLUME], { quiet: true });
    } catch {
      // no volume yet
    }
    console.log(`${CONTAINER}: container and data removed.`);
  }

  const current = state();
  if (current === "missing") {
    docker([
      "run", "-d",
      "--name", CONTAINER,
      "--restart", "unless-stopped",
      "-e", "POSTGRES_USER=memefun",
      "-e", "POSTGRES_PASSWORD=memefun",
      "-e", "POSTGRES_DB=memefun",
      "-p", `127.0.0.1:${PORT}:5432`,
      "-v", `${VOLUME}:/var/lib/postgresql/data`,
      IMAGE,
    ]);
  } else if (current === "stopped") {
    docker(["start", CONTAINER]);
  }
  await waitReady();
  console.log(`${CONTAINER} ready: ${DEV_DATABASE_URL}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
