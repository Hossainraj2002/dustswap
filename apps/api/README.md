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

## Global Discord Anti-Scam Link Filter

The same Railway bot process also runs a server-wide anti-scam link filter. It listens globally, not channel-by-channel, across normal text channels, announcement channels, forum post threads, forum comments, public threads, visible private threads, new messages, and message edits.

Allowed links:

- `x.com`
- `twitter.com`
- `dustswap.wtf`
- Any real subdomain ending in `.dustswap.wtf`, such as `app.dustswap.wtf`

Blocked examples:

- `dustswap-wtf.com`
- `dustswap.web.app`
- `dustswapwtf.com`
- `dustswap.claim.xyz`
- `dustswap-wtf.vercel.app`
- `dustswap.wtf.evil.com`
- `bit.ly`, `tinyurl.com`, `discord.gg`, `discord.com/invite`, and any other unapproved domain

Anti-scam env:

- `MOD_LOG_CHANNEL_ID`
- `TRUSTED_ROLE_IDS=` comma-separated staff role IDs only
- `ALLOWED_DOMAINS=x.com,twitter.com,dustswap.wtf`
- `CHANNEL_WARNING_ENABLED=true`
- `DM_WARNING_ENABLED=true`

`DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` are already used by this service. The aliases `DISCORD_TOKEN` and `GUILD_ID` are also supported.

Violation policy:

- 1st blocked-link message in 24 hours: delete full message, warn, timeout 1 hour
- 2nd blocked-link message in 24 hours: delete full message, warn, timeout 12 hours
- 3rd blocked-link message in 24 hours: delete full message, ban immediately

Only roles in `TRUSTED_ROLE_IDS` are exempt from deletion. Normal community roles such as Verified, Early User, OG, Ambassador, Partner, and Server Booster should not be added there. Staff-exempt external links are still logged to `MOD_LOG_CHANNEL_ID` as `STAFF EXEMPT - EXTERNAL LINK NOT DELETED`.

Developer Portal setup:

1. Go to Discord Developer Portal.
2. Open the Dustswap bot application.
3. Go to the Bot tab.
4. Scroll to Privileged Gateway Intents.
5. Enable Message Content Intent.

Required code intents are already enabled in `src/bots/earlyContributorBot.ts`:

- `Guilds`
- `GuildMessages`
- `MessageContent`
- `GuildMembers`

OAuth2 invite scopes:

- `bot`
- `applications.commands`

Recommended bot permissions:

- View Channels
- Read Message History
- Manage Messages
- Send Messages
- Moderate Members
- Ban Members

Server role setup:

- Put the bot role above normal community roles.
- Put the bot role above every member role it must timeout or ban.
- Do not give Administrator by default. Prefer the least privileges above.
- Give the bot access to every channel and private thread area that should be protected.
- If a private channel or private thread is hidden from the bot, the bot cannot protect it.

Operational checks:

- On startup, the bot scans guild channels and active threads for missing protection permissions.
- Permission gaps are logged to console and `MOD_LOG_CHANNEL_ID` when possible.
- Run the domain examples locally with `pnpm check:anti-scam`.

Booster OG watcher env:

- `DISCORD_SERVER_BOOSTER_ROLE_ID=1496260996627562628`
- `DISCORD_BOOSTER_OG_ROLE_ID=1495670561332789289`
- `DISCORD_BOOSTER_OG_LOG_CHANNEL_ID=1508507311323218082`
- `DISCORD_BOOSTER_OG_SYNC_ON_START=true`
- `DISCORD_BOOSTER_OG_SYNC_INTERVAL_MINUTES=30`
- `DISCORD_BOOSTER_OG_MAX_ACTIVE_GRANTS=25`
- `DISCORD_BOOSTER_OG_DEBUG=false`

Booster OG watcher behavior:

- Uses `dustswap-bot-og-log` as the only persistent storage for bot-managed OG ownership.
- Grants the custom OG role only when a current booster does not already have OG.
- Keeps bot-managed booster OG grants capped at 25 active users. When a bot-managed booster stops boosting, that slot opens for a later booster.
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
- Respects the same 25 active bot-managed OG grant cap as the runtime watcher.
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
