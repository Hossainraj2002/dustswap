/**
 * API watchdog.
 *
 * The 2026-08-22 outage ran for roughly three hours before anyone noticed, and
 * it was found through Discord support tickets rather than any monitor. Raising
 * the connection pool fixed that specific cause; this fixes the reason it went
 * unnoticed.
 *
 * It deliberately lives in the Discord bot process, not in the API. A monitor
 * that runs inside the thing it monitors cannot report that the thing is
 * wedged: during the outage the API was still accepting connections and
 * answering /health, it just could not reach the database. So this polls the
 * public URL from a separate process, exactly as a user would.
 *
 * It alerts on state changes only. A flapping endpoint must not produce a
 * message every minute, or the channel gets muted and the next real outage is
 * invisible again.
 */

import type { Client, TextBasedChannel } from "discord.js";

type WatchdogConfig = {
  enabled: boolean;
  apiBase: string;
  channelId: string;
  intervalMs: number;
  failThreshold: number;
  timeoutMs: number;
};

type ProbeResult = {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  detail: string;
};

const DEFAULT_API_BASE = "https://dustswap-production.up.railway.app";
const DEFAULT_INTERVAL_MS = 60_000;
/** Three consecutive misses, so a single blip or a deploy does not page anyone. */
const DEFAULT_FAIL_THRESHOLD = 3;
const DEFAULT_TIMEOUT_MS = 25_000;

function readEnv(name: string) {
  return (process.env[name] || "").trim();
}

function isEnabled(value: string, fallback: boolean) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function boundedInt(name: string, fallback: number, min: number, max: number) {
  // readEnv returns "" for an unset variable, and Number("") is 0, not NaN.
  // Without this guard every default silently clamped to its minimum: the
  // watchdog came up polling every 15s with a 2s timeout and alerting after a
  // single failure, which would have produced false alarms on any request that
  // took longer than two seconds.
  const raw = readEnv(name);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function getWatchdogConfig(): WatchdogConfig {
  const channelId =
    readEnv("WATCHDOG_CHANNEL_ID") ||
    readEnv("MOD_LOG_CHANNEL_ID") ||
    readEnv("DISCORD_EARLY_LOG_CHANNEL_ID");

  return {
    // Off unless a channel exists to alert into, otherwise it is a no-op loop.
    enabled: isEnabled(readEnv("WATCHDOG_ENABLED"), Boolean(channelId)),
    apiBase: (readEnv("WATCHDOG_API_BASE") || DEFAULT_API_BASE).replace(/\/+$/, ""),
    channelId,
    intervalMs: boundedInt("WATCHDOG_INTERVAL_MS", DEFAULT_INTERVAL_MS, 15_000, 900_000),
    failThreshold: boundedInt("WATCHDOG_FAIL_THRESHOLD", DEFAULT_FAIL_THRESHOLD, 1, 20),
    timeoutMs: boundedInt("WATCHDOG_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 2_000, 60_000),
  };
}

async function probe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    const latencyMs = Date.now() - startedAt;

    return {
      ok: response.ok,
      status: response.status,
      latencyMs,
      detail: response.ok ? "ok" : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      detail:
        (error as Error).name === "AbortError"
          ? `no response in ${timeoutMs}ms`
          : (error as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatDuration(ms: number) {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

class ApiWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private alerted = false;
  private downSince: number | null = null;

  constructor(
    private readonly client: Client,
    private readonly config: WatchdogConfig
  ) {}

  start() {
    if (!this.config.enabled) {
      console.log("[API Watchdog] Disabled");
      return;
    }

    if (!this.config.channelId) {
      console.log("[API Watchdog] No alert channel configured, not starting");
      return;
    }

    console.log(
      `[API Watchdog] Watching ${this.config.apiBase}/health/db every ${
        this.config.intervalMs / 1000
      }s, alerting after ${this.config.failThreshold} consecutive failures`
    );

    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick() {
    try {
      // /health/db is the one that matters. During the outage the process was
      // alive and /health would have answered fine while every real request
      // failed, so a liveness probe would have reported all clear.
      const result = await probe(
        `${this.config.apiBase}/health/db`,
        this.config.timeoutMs
      );

      if (result.ok) {
        await this.handleSuccess(result);
        return;
      }

      await this.handleFailure(result);
    } catch (error) {
      console.error("[API Watchdog] Tick failed", error);
    }
  }

  private async handleSuccess(result: ProbeResult) {
    const wasAlerted = this.alerted;
    const downSince = this.downSince;

    this.consecutiveFailures = 0;
    this.alerted = false;
    this.downSince = null;

    if (!wasAlerted) {
      return;
    }

    const downFor = downSince ? formatDuration(Date.now() - downSince) : "unknown";
    await this.announce(
      [
        "**API recovered**",
        `The database health check is passing again (${result.latencyMs}ms).`,
        `Down for approximately ${downFor}.`,
      ].join("\n")
    );
  }

  private async handleFailure(result: ProbeResult) {
    this.consecutiveFailures += 1;

    if (this.downSince === null) {
      this.downSince = Date.now();
    }

    console.warn(
      `[API Watchdog] Health check failed (${this.consecutiveFailures}/${this.config.failThreshold}): ${result.detail}`
    );

    if (this.alerted || this.consecutiveFailures < this.config.failThreshold) {
      return;
    }

    this.alerted = true;
    await this.announce(
      [
        "**API health check failing**",
        `\`GET ${this.config.apiBase}/health/db\` returned: ${result.detail}`,
        `Failed ${this.consecutiveFailures} checks in a row.`,
        "",
        "If this is a database connection timeout, check `DB_POOL_MAX` on the API service before anything else. A pool that is too small produces exactly this while Postgres itself sits idle.",
      ].join("\n")
    );
  }

  private async announce(content: string) {
    try {
      const channel = await this.client.channels.fetch(this.config.channelId);
      if (!channel || !channel.isTextBased()) {
        console.error(
          `[API Watchdog] Channel ${this.config.channelId} is not a text channel`
        );
        return;
      }

      await (channel as TextBasedChannel & { send: (c: string) => Promise<unknown> }).send(
        content
      );
    } catch (error) {
      console.error("[API Watchdog] Failed to post alert", error);
    }
  }
}

export function startApiWatchdog(client: Client) {
  const watchdog = new ApiWatchdog(client, getWatchdogConfig());
  watchdog.start();
  return watchdog;
}
