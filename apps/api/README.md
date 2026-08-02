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

Allowed links (each also allows its real subdomains, e.g. `app.dustswap.wtf`, `mobile.x.com`, `pbs.twimg.com`, `cdn.discordapp.com`, `media.tenor.com`):

- Official: `dustswap.wtf`
- X / Twitter: `x.com`, `twitter.com`, `t.co`, `twimg.com`, `fxtwitter.com`, `vxtwitter.com`, `fixupx.com`
- Discord-native media / GIF pickers: `discordapp.com`, `discordapp.net`, `tenor.com`, `giphy.com`
- Block explorers: `basescan.org`, `bscscan.com`, `etherscan.io` (members share tx links constantly)

Blocked examples:

- `dustswap-wtf.com`
- `dustswap.web.app`
- `dustswapwtf.com`
- `dustswap.claim.xyz`
- `dustswap-wtf.vercel.app`
- `dustswap.wtf.evil.com`, `x.com.evil.com` (lookalikes stay blocked)
- `bit.ly`, `tinyurl.com`, `discord.gg`, `discord.com/invite` (invites intentionally not allowlisted), and any other unapproved domain

How bots and webhooks are handled (this is the anti-abuse core):

- A scammer cannot simply "add a bot" — inviting a bot needs Manage Server (admin). The realistic threat is a **leaked/abused incoming webhook** (webhook URLs get scraped from GitHub/configs and can be posted to by anyone, with a spoofed name/avatar and rich embeds).
- **Trusted integrations** (`TRUSTED_BOT_IDS`, `TRUSTED_WEBHOOK_IDS`) are fully exempt — put your ticket bot / mod bots / CI webhook here so they are never scanned or removed.
- **Untrusted incoming webhooks** are scanned by default (content **and** embeds). A blocked link → the message is deleted immediately; the webhook itself is deleted (`ANTI_SCAM_DELETE_UNTRUSTED_WEBHOOKS`) only after 2 blocked posts in 24h, so one accidental off-allowlist link from a legit-but-un-allowlisted webhook does not nuke it, while a leaked/abused webhook that keeps spamming is killed. Webhooks are never "banned" (there is nothing to ban).
- **Untrusted bots** are left alone by default (they required an admin to add). Enable `ANTI_SCAM_MODERATE_UNTRUSTED_BOTS` to also delete their blocked-link messages. Bots are never timed out or banned — at worst their message is deleted and it is logged for manual review.
- Bot interaction/slash-command replies are correctly distinguished from real webhooks, so a trusted bot's buttons/panels are not mistaken for webhook spam.

What is NOT treated as a human violation:

- Discord's auto-generated link-preview embeds (e.g. the quoted-tweet body when someone posts an X link). See `ANTI_SCAM_SCAN_EMBEDS`.
- Attachment file names — a Discord-hosted upload such as `clip.mkv` or `photo.tiff` is not a phishing link. See `ANTI_SCAM_SCAN_ATTACHMENTS`.
- Messages from members with Administrator / Manage Server / Moderate Members / Manage Messages. See `ANTI_SCAM_EXEMPT_ELEVATED`.

Anti-scam env:

- `MOD_LOG_CHANNEL_ID`
- `TRUSTED_ROLE_IDS=` comma-separated staff role IDs only
- `TRUSTED_BOT_IDS=` comma-separated application/user IDs of bots to fully exempt (e.g. your ticket bot)
- `TRUSTED_WEBHOOK_IDS=` comma-separated webhook IDs to fully exempt
- `ALLOWED_DOMAINS=` optional override of the default allowlist above (comma-separated). When set it replaces the defaults entirely.
- `CHANNEL_WARNING_ENABLED=true`
- `DM_WARNING_ENABLED=true`
- `ANTI_SCAM_MODERATE_WEBHOOKS=true` — scan untrusted incoming webhooks and delete blocked-link messages
- `ANTI_SCAM_DELETE_UNTRUSTED_WEBHOOKS=true` — also delete the offending webhook (needs Manage Webhooks)
- `ANTI_SCAM_MODERATE_UNTRUSTED_BOTS=false` — when true, also delete blocked-link messages from untrusted bots
- `ANTI_SCAM_SCAN_EMBEDS=false` — when true, also scan Discord auto-preview embeds on human messages (can re-flag links inside a quoted page)
- `ANTI_SCAM_SCAN_ATTACHMENTS=false` — when true, scan attachment file names/titles/descriptions
- `ANTI_SCAM_AUTO_BAN=false` — when true, the 3rd human violation is a permanent ban; when false it is a 24h timeout
- `ANTI_SCAM_EXEMPT_ELEVATED=true` — exempt admins/mods from the filter

Not a link-filter job (use Discord's native AutoMod as a complementary layer): link-free scams ("DM me for the airdrop"), keyword/mention-spam rules, and pre-publish blocking that also covers webhooks even while this bot is offline. Also audit who holds Manage Webhooks / Manage Server — that is what limits who can create integrations at all.

`DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` are already used by this service. The aliases `DISCORD_TOKEN` and `GUILD_ID` are also supported.

Violation policy (per human member, rolling 24 hours):

- 1st blocked-link message: delete full message, warn, timeout 1 hour
- 2nd blocked-link message: delete full message, warn, timeout 12 hours
- 3rd blocked-link message: delete full message, then timeout 24 hours by default, or ban immediately if `ANTI_SCAM_AUTO_BAN=true`

Bots, webhooks, trusted-role members, and (by default) admins/mods are never counted, timed out, or banned. Only roles in `TRUSTED_ROLE_IDS` and elevated members are exempt from deletion. Normal community roles such as Verified, Early User, OG, Ambassador, Partner, and Server Booster should not be added there. Staff-exempt external links are still logged to `MOD_LOG_CHANNEL_ID` as `STAFF EXEMPT - EXTERNAL LINK NOT DELETED`.

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
- Manage Webhooks (required to auto-remove malicious/leaked webhooks)

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

## Footprint Drop Allowlist (private data — not in git)

`apps/api/data/all_time_user_totals.json` holds the saved-leaderboard allowlist: real
user wallet addresses paired with each one's all-time USDC sweep volume. It is **user
data**, so it is gitignored and must never be committed. Keep your local copy and ship
it to the API host out-of-band.

`FootprintAirdropService` looks for the file in this order:

1. `FOOTPRINT_ALLOWLIST_PATH` (absolute path — use this on the host)
2. `<cwd>/data/all_time_user_totals.json`
3. `<cwd>/apps/api/data/all_time_user_totals.json`
4. `<cwd>/../data/all_time_user_totals.json`

If none exist the API **still boots**. It logs a `[footprint-drop]` warning and every
lookup falls back to the Blockscout on-chain-activity tiers — the same path
non-allowlisted addresses already take. Saved-leaderboard tiers stay dormant until the
file is present, so watch for that warning after a deploy if you expect them to work.

To restore the tiers in production, mount the file on a Railway volume (for example
`/data/all_time_user_totals.json`) and set `FOOTPRINT_ALLOWLIST_PATH` to that path.
