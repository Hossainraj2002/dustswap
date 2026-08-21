/**
 * Operator CLI for Base App notifications.
 *
 *   pnpm notifications probe                     verify key + allowlist, count audience
 *   pnpm notifications sync                      refresh notification_audience
 *   pnpm notifications status 0xabc...           check one wallet's pin state
 *   pnpm notifications send 0xabc...             send a real test to one wallet
 *   pnpm notifications run streak_at_risk        dry run a campaign
 *   pnpm notifications run streak_at_risk --send actually send it
 *
 * `run` is a dry run unless --send is passed. Add --max=N to cap recipients.
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

// Same swap index.ts performs: postgres.railway.internal only resolves inside
// Railway, so a local run needs the public host. Falls back to the migration
// env file, which is where the public URL already lives for this repo.
if (/\.railway\.internal(?::|\/|$)/i.test(process.env.DATABASE_URL || "")) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    dotenv.config({ path: path.resolve(__dirname, "../../../../.env.migration") });
  }

  const publicUrl =
    process.env.DATABASE_PUBLIC_URL || process.env.TARGET_DATABASE_URL;

  if (publicUrl) {
    process.env.DATABASE_URL = publicUrl;
  }
}

import { closeDbPool } from "../lib/db";
import {
  fetchAudience,
  fetchUserStatus,
  isBaseNotificationsConfigured,
  sendNotificationBatch,
  baseNotificationsConfig,
} from "../services/baseNotifications";
import {
  CAMPAIGNS,
  CAMPAIGN_KEYS,
  isCampaignEnabled,
  isCampaignKey,
} from "../services/notificationCampaigns";
import {
  runCampaign,
  syncNotificationAudience,
} from "../services/notificationScheduler";

function usage() {
  console.log(
    [
      "Usage:",
      "  probe                        verify the API key and project allowlist",
      "  sync                         refresh notification_audience from Base",
      "  segments                     preview who each campaign would reach",
      "  status <address>             check whether a wallet pinned the app",
      "  send <address>               send a real test notification to one wallet",
      `  run <campaign> [--send]      run a campaign (${CAMPAIGN_KEYS.join(", ")})`,
      "",
      "Flags:",
      "  --send      turn a dry run into a real send",
      "  --max=N     cap recipients for this run",
    ].join("\n")
  );
}

async function probe() {
  if (!isBaseNotificationsConfigured()) {
    console.error("BASE_NOTIFICATIONS_API_KEY is not set.");
    process.exitCode = 1;
    return;
  }

  const appUrl = baseNotificationsConfig.getAppUrl();
  console.log(`app_url:     ${appUrl}`);
  console.log(`rate limit:  ${baseNotificationsConfig.getRateLimitPerMinute()} req/min`);
  console.log("Calling GET /v1/notifications/app/users ...");

  const users = await fetchAudience({ notificationEnabledOnly: true });

  console.log("");
  console.log(`Allowlist:   OK`);
  console.log(`Opted in:    ${users.length} wallet(s)`);

  if (users.length) {
    console.log(`Sample:      ${users.slice(0, 3).map((u) => u.address).join(", ")}`);
  } else {
    console.log(
      "No opted-in wallets yet. Users must pin the app inside Base App before any campaign can reach them."
    );
  }
}

/**
 * Runs every segment query and prints how many accounts each would reach, plus
 * the copy the first match would receive. Needs no API key, so it is the way to
 * sanity check targeting before notifications are switched on.
 */
async function segments() {
  const now = new Date();

  for (const key of CAMPAIGN_KEYS) {
    const campaign = CAMPAIGNS[key];

    try {
      const rows = await campaign.segment(campaign.cooldownHours);
      const flag = isCampaignEnabled(campaign) ? "enabled" : "disabled";

      console.log("");
      console.log(`${campaign.label} (${key}) [${flag}]`);
      console.log(
        `  would reach: ${rows.length} account(s)  (cooldown ${campaign.cooldownHours}h)`
      );

      if (rows.length) {
        const copy = campaign.render(rows[0], now);
        console.log(`  title:   ${copy.title} (${copy.title.length}/30)`);
        console.log(`  message: ${copy.message} (${copy.message.length}/200)`);
        console.log(`  path:    ${campaign.targetPath}`);
      }
    } catch (error) {
      console.log("");
      console.log(`${campaign.label} (${key})`);
      console.error(`  SEGMENT FAILED: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

async function status(address: string) {
  const result = await fetchUserStatus(address);
  console.log(`appPinned:            ${result.appPinned}`);
  console.log(`notificationsEnabled: ${result.notificationsEnabled}`);
}

async function sendTest(address: string) {
  const response = await sendNotificationBatch({
    walletAddresses: [address],
    title: "DustSwap notifications live",
    message:
      "This is a test from the DustSwap API. If you can read this, notification delivery is working.",
    targetPath: "/profile",
  });

  console.log(JSON.stringify(response, null, 2));

  if (response.failedCount > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positional = args.filter((arg) => !arg.startsWith("--"));

  const maxFlag = flags.find((flag) => flag.startsWith("--max="));
  const maxRecipients = maxFlag ? Number(maxFlag.split("=")[1]) : undefined;

  switch (command) {
    case "probe":
      await probe();
      break;

    case "sync": {
      const result = await syncNotificationAudience();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "segments":
      await segments();
      break;

    case "status": {
      if (!positional[0]) {
        console.error("status requires a wallet address");
        process.exitCode = 1;
        break;
      }
      await status(positional[0]);
      break;
    }

    case "send": {
      if (!positional[0]) {
        console.error("send requires a wallet address");
        process.exitCode = 1;
        break;
      }
      await sendTest(positional[0]);
      break;
    }

    case "run": {
      const campaign = positional[0];

      if (!campaign || !isCampaignKey(campaign)) {
        console.error(`run requires one of: ${CAMPAIGN_KEYS.join(", ")}`);
        process.exitCode = 1;
        break;
      }

      const dryRun = !flags.includes("--send");
      if (dryRun) {
        console.log("Dry run. Nothing will be sent. Pass --send to deliver.");
      }

      const result = await runCampaign(campaign, {
        dryRun,
        force: true,
        source: "script",
        maxRecipients: Number.isFinite(maxRecipients) ? maxRecipients : undefined,
      });

      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default:
      usage();
      break;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDbPool();
  });
