# DustSwap API Notes

## Early Contributor Tweet Claim Bot

Standalone Railway service settings:

- Service root: `apps/api`
- Start command: `pnpm start:early-bot`
- Dev command: `pnpm dev:early-bot`

Required environment variables:

- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID=1494584551630962808`
- `DISCORD_EARLY_SUBMIT_CHANNEL_ID=1495705489672241272`
- `DISCORD_EARLY_LOG_CHANNEL_ID=1507650151337037844`
- `DISCORD_EARLY_ROLE_ID=1495670418407948351`
- `DISCORD_EARLY_MAX_CLAIMS=5000`

Operational note:

- The bot reads historical `CLAIM_SUCCESS` entries from the private log channel on startup and keeps all claim state in Discord, not in the DustSwap app database.
- Non-token campaign IDs and the max-claims value currently default to the values above in code, so you can override them later in Railway without changing the main API service.
- The same running bot process now also watches server boosters and safely manages the custom OG role using a separate private log channel.

Booster OG watcher env:

- `DISCORD_SERVER_BOOSTER_ROLE_ID=1496260996627562628`
- `DISCORD_BOOSTER_OG_ROLE_ID=1495670561332789289`
- `DISCORD_BOOSTER_OG_LOG_CHANNEL_ID=1508507311323218082`
- `DISCORD_BOOSTER_OG_SYNC_ON_START=true`
- `DISCORD_BOOSTER_OG_SYNC_INTERVAL_MINUTES=30`
- `DISCORD_BOOSTER_OG_DEBUG=false`

Booster OG watcher behavior:

- Uses `dustswap-bot-og-log` as the only persistent storage for bot-managed OG ownership.
- Grants the custom OG role only when a current booster does not already have OG.
- Removes the custom OG role only when the user is no longer boosting and the OG role was previously granted by this bot.

One-time booster OG backfill:

- Dev command: `pnpm dev:booster-og-backfill`
- Start command: `pnpm start:booster-og-backfill`
- Safety default: `DISCORD_BOOSTER_OG_BACKFILL_DRY_RUN=true`
- Optional cap: `DISCORD_BOOSTER_OG_BACKFILL_LIMIT=25`

Booster OG backfill behavior:

- Scans all current guild members and filters to current server boosters only.
- Ignores boosters who already have the custom OG role.
- Adds the custom OG role only to current boosters who are missing OG.
- Writes `BOOSTER_OG_GRANTED` only when a new active bot-managed grant needs to be created.
- Never removes OG from anyone.

One-time backfill:

- Dry run: `pnpm backfill:early-bot`
- Apply the backfill: `pnpm backfill:early-bot -- --apply`
- Optional test batch: `pnpm backfill:early-bot -- --apply --limit=25`

Backfill behavior:

- Scans historical messages in the submit channel oldest-first.
- Reconstructs missing `CLAIM_SUCCESS` log entries for valid past submissions.
- Adds the role only for members who still do not have it.
