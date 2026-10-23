import { Hono } from "hono";
import { getClientIp } from "../utils/clientIp";
import { runtimeCache } from "../utils/runtimeCache";
import {
  fetchUserStatus,
  isBaseNotificationsConfigured,
  normalizeAddress,
} from "../services/baseNotifications";
import { CAMPAIGNS, isCampaignEnabled } from "../services/notificationCampaigns";
import { CFG } from "../services/pointsEngine";

const notificationsRoutes = new Hono();

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Base's own limit is 20 req/min per IP shared across all notification
 * endpoints, and the campaign dispatcher needs most of that budget. Cache
 * aggressively so a client polling this route cannot starve the sender.
 */
const STATUS_CACHE_TTL_MS = 10 * 60 * 1000;
const PER_IP_LIMIT = 12;
const PER_IP_WINDOW_MS = 60 * 1000;

export type PinBenefit = {
  icon: "bell" | "sparkle" | "ticket";
  label: string;
  detail: string;
};

/**
 * What the prompt is allowed to promise.
 *
 * Derived from the campaigns that are actually switched on, so the sheet can
 * never advertise a notification the backend does not send. dust_detected and
 * streak_broken ship disabled, and a hardcoded UI list would have offered
 * "Dust alerts" to every user regardless.
 *
 * The ticket count comes from CFG for the same reason: the prompt said "Three
 * every check-in" as literal text, which silently becomes a lie the moment
 * SPIN_TICKETS_PER_CHECK_IN changes.
 */
function getLiveBenefits(): PinBenefit[] {
  const benefits: PinBenefit[] = [];

  if (isCampaignEnabled(CAMPAIGNS.streak_at_risk)) {
    benefits.push({
      icon: "bell",
      label: "Streak reminders",
      detail: "Before midnight UTC",
    });
  }

  if (isCampaignEnabled(CAMPAIGNS.dust_detected)) {
    benefits.push({
      icon: "sparkle",
      label: "Dust alerts",
      detail: "When it is worth sweeping",
    });
  }

  if (isCampaignEnabled(CAMPAIGNS.daily_check_in)) {
    benefits.push({
      icon: "ticket",
      label: "Free spin tickets",
      detail: `${CFG.SPIN_TICKETS_PER_CHECK_IN} every check-in`,
    });
  } else if (isCampaignEnabled(CAMPAIGNS.unspent_tickets)) {
    benefits.push({
      icon: "ticket",
      label: "Spin ticket reminders",
      detail: "When yours go unused",
    });
  }

  return benefits;
}

export type PinStatusResponse = {
  /** True once the wallet has saved DustSwap inside Base App. */
  appPinned: boolean;
  /** True only when pinned AND notifications are left on. */
  notificationsEnabled: boolean;
  /**
   * What the client should ask for, if anything. Kept server-side so the
   * prompt copy cannot drift from what Base actually reports.
   *   none      -> already receiving notifications, stay quiet
   *   pin       -> not saved yet
   *   enable    -> saved, but notifications are off
   */
  prompt: "none" | "pin" | "enable";
  /** Only the campaigns that are actually switched on. */
  benefits: PinBenefit[];
};

/**
 * GET /api/notifications/pin-status/:address
 *
 * Public on purpose: it reveals nothing beyond whether a wallet saved a public
 * app, and the prompt needs it before the user has signed anything. Rate
 * limited per IP and cached per wallet so it cannot be used to burn the
 * shared Base budget.
 */
notificationsRoutes.get("/pin-status/:address", async (c) => {
  const address = normalizeAddress(c.req.param("address"));

  if (!EVM_ADDRESS_RE.test(address)) {
    return c.json({ success: false, error: "Invalid address" }, 400);
  }

  if (!isBaseNotificationsConfigured()) {
    // Not an error: the prompt simply stays hidden until the key is present.
    return c.json({
      success: true,
      data: {
        appPinned: false,
        notificationsEnabled: false,
        prompt: "none",
        benefits: [],
      },
    });
  }

  const ip = getClientIp(c) || "unknown";
  const limit = runtimeCache.consumeRateLimit(
    `notif-pin-status:${ip}`,
    PER_IP_LIMIT,
    PER_IP_WINDOW_MS
  );

  if (!limit.allowed) {
    return c.json(
      { success: false, error: "Too many requests" },
      429,
      { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) }
    );
  }

  try {
    const data = await runtimeCache.getOrSet<PinStatusResponse>(
      `notif-pin-status:wallet:${address}`,
      STATUS_CACHE_TTL_MS,
      async () => {
        const status = await fetchUserStatus(address);

        return {
          appPinned: status.appPinned,
          notificationsEnabled: status.notificationsEnabled,
          prompt: status.notificationsEnabled
            ? "none"
            : status.appPinned
              ? "enable"
              : "pin",
          benefits: getLiveBenefits(),
        };
      }
    );

    c.header("Cache-Control", "private, max-age=300");
    return c.json({ success: true, data });
  } catch (error) {
    // Never surface a Base outage as a prompt. Failing closed keeps the UI
    // quiet rather than nagging someone who may already have notifications on.
    console.error("[Notifications] pin-status lookup failed", error);
    return c.json({
      success: true,
      data: {
        appPinned: false,
        notificationsEnabled: false,
        prompt: "none",
        benefits: [],
      },
    });
  }
});

export { notificationsRoutes };
