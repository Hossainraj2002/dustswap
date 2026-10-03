import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Environment access for every memefun backend process. Ponder loads .env.local by itself; the
 * keeper and scripts call `loadLocalEnv()` first. Values already in the environment win, so a
 * deployment's variables are never overridden by a stray local file.
 */
export function loadLocalEnv(root = process.cwd()) {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;
    process.loadEnvFile(path);
    return path;
  }
  return null;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function envBool(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`Environment variable ${name} must be true or false, got "${value}".`);
}

export function envInt(name: string, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}".`);
  if (bounds.min !== undefined && value < bounds.min) throw new Error(`${name} must be at least ${bounds.min}.`);
  if (bounds.max !== undefined && value > bounds.max) throw new Error(`${name} must be at most ${bounds.max}.`);
  return value;
}
