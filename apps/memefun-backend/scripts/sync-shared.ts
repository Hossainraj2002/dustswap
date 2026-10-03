/**
 * Copies the code the backend shares with the app and the contracts, so the indexer, API and
 * keeper compute with exactly the formulas the UI shows and the contracts enforce:
 *
 *   apps/memefun/src/core/**            -> shared/core/**          (pool math, fees, milestones, validation)
 *   apps/memefun/src/lib/market/types.ts -> shared/market-types.ts  (the UI's data contract)
 *   apps/memefun/src/lib/contracts/abis.ts -> shared/abis.ts        (generated from the contracts)
 *   packages/memefun-contracts/deployments/*.json -> deployments/   (addresses per chain)
 *
 * The copies are committed so the service builds on its own (Railway builds this folder alone).
 * test/shared-drift.test.ts fails whenever a copy is stale.
 *
 *   pnpm sync-shared            write the copies
 *   pnpm sync-shared --check    exit 1 if any copy is stale, write nothing
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "../..");

export const SOURCES = {
  core: resolve(repo, "apps/memefun/src/core"),
  marketTypes: resolve(repo, "apps/memefun/src/lib/market/types.ts"),
  abis: resolve(repo, "apps/memefun/src/lib/contracts/abis.ts"),
  deployments: resolve(repo, "packages/memefun-contracts/deployments"),
} as const;

export const TARGETS = {
  core: resolve(root, "shared/core"),
  marketTypes: resolve(root, "shared/market-types.ts"),
  abis: resolve(root, "shared/abis.ts"),
  deployments: resolve(root, "deployments"),
} as const;

const header = (source: string) =>
  `// SYNCED from ${relative(repo, source).replace(/\\/g, "/")} by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.\n`;

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listTs(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out.sort();
}

/** Every file the sync would write, as target path -> exact contents. */
export function expectedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const source of listTs(SOURCES.core)) {
    files.set(join(TARGETS.core, relative(SOURCES.core, source)), header(source) + readFileSync(source, "utf8"));
  }
  // The market types import the core types through the app's "@/" alias.
  const marketTypes = readFileSync(SOURCES.marketTypes, "utf8").replace(/from "@\/core\//g, 'from "./core/');
  files.set(TARGETS.marketTypes, header(SOURCES.marketTypes) + marketTypes);
  files.set(TARGETS.abis, header(SOURCES.abis) + readFileSync(SOURCES.abis, "utf8"));
  if (existsSync(SOURCES.deployments)) {
    for (const name of readdirSync(SOURCES.deployments).filter((n) => n.endsWith(".json")).sort()) {
      files.set(join(TARGETS.deployments, name), readFileSync(join(SOURCES.deployments, name), "utf8"));
    }
  }
  return files;
}

/** Synced files that exist on disk but would no longer be written (a source was removed). */
export function orphanedFiles(expected: Map<string, string>): string[] {
  const orphans: string[] = [];
  if (existsSync(TARGETS.core)) {
    for (const path of listTs(TARGETS.core)) if (!expected.has(path)) orphans.push(path);
  }
  return orphans;
}

export function sourcesAvailable(): boolean {
  return existsSync(SOURCES.core) && existsSync(SOURCES.marketTypes) && existsSync(SOURCES.abis);
}

function main() {
  if (!sourcesAvailable()) {
    console.error("sync-shared: the app sources are not in this checkout; nothing to sync.");
    process.exit(1);
  }
  const check = process.argv.includes("--check");
  const expected = expectedFiles();
  const stale: string[] = [];
  for (const [path, contents] of expected) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === contents) continue;
    stale.push(relative(root, path));
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
  }
  const orphans = orphanedFiles(expected);
  for (const path of orphans) {
    stale.push(`${relative(root, path)} (orphaned)`);
    if (!check) rmSync(path);
  }
  if (check) {
    if (stale.length > 0) {
      console.error(`sync-shared: ${stale.length} stale file(s):\n  ${stale.join("\n  ")}\nRun pnpm sync-shared.`);
      process.exit(1);
    }
    console.log("sync-shared: all copies current.");
    return;
  }
  console.log(stale.length > 0 ? `sync-shared: updated\n  ${stale.join("\n  ")}` : "sync-shared: all copies current.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
