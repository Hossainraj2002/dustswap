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

## Base App Notifications

In-app notifications for Base App users, sent through the Base Dashboard REST API.

Reference: https://docs.base.org/apps/technical-guides/base-notifications

### Why there is no webhook

The Base App stopped honouring the Farcaster mini-app notification spec on
2026-04-09. Notification tokens, per-token callback URLs and Neynar webhooks no
longer reach Base App users, and `apps/web/public/.well-known/farcaster.json`
plays no part in delivery. The only supported path is the REST API below, which
is keyed on **wallet addresses**.

### Billing

`BASE_NOTIFICATIONS_API_KEY` is a Base Dashboard credential, generated at
**Settings > API Key** on the Base.dev project that owns the app URL. It is not
a CDP key and notification traffic does not draw on CDP credits. The only
documented limit is **20 requests per minute per IP, shared across all three
notification endpoints**.

Because that limit is per IP, the dispatcher must run from this Railway service,
which has a stable egress IP. It must never move into the Cloudflare-deployed
web app, where the limiter would be shared with unrelated tenants.

### Setup

```bash
pnpm migrate base_notifications     # creates the three notification tables
pnpm notifications probe            # verifies the key and project allowlist
pnpm notifications sync             # caches the opted-in wallet list
pnpm notifications send 0xYourWallet
```

`probe` is the one that matters first. A 403 means the project is not
allowlisted for notifications, and nothing else will work until that clears.

### Operating the campaigns

```bash
pnpm notifications run streak_at_risk          # dry run, writes ledger only
pnpm notifications run streak_at_risk --send   # actually delivers
pnpm notifications run daily_check_in --send --max=50
```

Admin endpoints (all require the `x-admin-token` header):

- `GET  /api/monitor/admin/notifications` audience size, per-campaign stats, failure reasons
- `POST /api/monitor/admin/notifications/sync` refresh the opted-in wallet list
- `POST /api/monitor/admin/notifications/run` `{ campaign, dryRun, force, maxRecipients }`, dry run unless `dryRun: false`
- `GET  /api/monitor/admin/notifications/status/:address` whether one wallet pinned the app

### Campaigns

| Key | Segment | Target | Schedule (UTC) | Default |
| --- | --- | --- | --- | --- |
| `daily_check_in` | No live streak, no check-in today | `/profile` | 17:00 daily | on |
| `streak_at_risk` | Live streak, no check-in today | `/profile` | 21:00 daily | on |
| `unspent_tickets` | 3+ tickets, no spin in 7d | `/spin` | 16:00 Sunday | on |
| `streak_broken` | Streak of 3+ lapsed yesterday | `/profile` | 12:00 daily | off |
| `dust_detected` | $10 to $1000 of Base dust, no sweep in 14d | `/dustsweep` | 15:00 Thursday | off |

`dust_detected` reads `dustsweep_token_cache`, not `wallet_token_balances`
(which is empty in production). Because that cache is filled when a wallet is
scanned rather than by a crawl, the campaign only reaches people who opened
DustSweep in the last 7 days. Measured against live data it currently matches
about 120 accounts.

**The bounds on that campaign are a correctness guard, not a preference.** Token
prices in the discovery cache come from thin and sometimes faked pairs. The live
cache holds single `swappable` tokens valued at $4.1bn on a HIGH confidence
price and 1.3e42 on a MEDIUM one, so `priceConfidence` alone filters nothing.
Unbounded, this campaign told real users they were holding "$686,470 in dust",
which is both false and indistinguishable from a scam notification. The per
token ceiling removes that entire class of bad copy at no cost, since anything
above it is not dust by definition.

### Design constraints worth knowing before editing

- **Copy caps are hard.** Title 30 chars, message 200, target path 500 and must
  start with `/`. Exceeding any of them is a 400. `clampCopy` in
  `notificationCampaigns.ts` falls back to shorter copy rather than failing a run
  when a dynamic number runs long.
- **Copy must vary between runs.** Base deduplicates identical notifications
  (same app URL, wallet, title, message, target path) inside a 24h window and
  still returns success, so static daily copy would report delivery while
  reaching nobody. `daily_check_in` rotates four phrasings by UTC day; the others
  vary naturally through a streak day, ticket count, or dust value.
- **Segments resolve through `user_wallets`, never `users.address`,** which
  becomes `merged:<id>` after an account merge. Each segment picks one wallet per
  `users.id` so a linked EOA and Base Account are not notified twice.
- **Base returns EIP-55 checksummed addresses**; everything stored here is
  lowercased to match `user_wallets.wallet_address`.
- **The check-in day rolls at UTC midnight** (`getUtcDayKey` in the points
  engine), so every window in this system is UTC.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_NOTIFICATIONS_API_KEY` | unset | Base Dashboard key. Without it everything no-ops. |
| `BASE_NOTIFICATIONS_APP_URL` | `https://app.dustswap.wtf` | Must match the Base.dev primary URL exactly or every call 403s. |
| `BASE_NOTIFICATIONS_RATE_LIMIT_PER_MIN` | `15` | Kept under the documented 20 so manual calls cannot cause 429s. |
| `NOTIFICATIONS_ENABLED` | `false` | Master switch for the scheduler. |
| `NOTIFICATIONS_DRY_RUN` | `false` | Writes the ledger, skips the HTTP call. |
| `NOTIFICATIONS_MAX_PER_RUN` | unset | Hard recipient ceiling per run. Start small. |
| `NOTIFICATIONS_GLOBAL_COOLDOWN_HOURS` | `24` | At most one notification per merged account in this window. |
| `NOTIFICATIONS_AUDIENCE_SYNC_HOUR_UTC` | `6` | When to refresh the opted-in list. |
| `NOTIFICATIONS_CAMPAIGN_<KEY>_ENABLED` | see table | Per-campaign switch. |
| `NOTIFICATIONS_DUST_MIN_USD` | `10` | Account dust total below this is not worth an interruption. |
| `NOTIFICATIONS_DUST_MAX_USD` | `1000` | Above this the account holds a position, not dust. |
| `NOTIFICATIONS_DUST_MAX_TOKEN_USD` | `100` | Per-token ceiling. Excludes mispriced pairs. |

`streak_broken` additionally requires `STREAK_RECOVERY_ENABLED`, since it points
users at the paid restore flow that flag controls.

### Recommended rollout

1. `pnpm notifications probe`. Stop here if it 403s.
2. Run the migration, then `pnpm notifications sync` and check the audience size.
   If it is small, the opt-in prompt matters more than any campaign.
3. `pnpm notifications send 0xYourWallet` and confirm it arrives on your phone.
4. Set `NOTIFICATIONS_ENABLED=true`, `NOTIFICATIONS_DRY_RUN=true` for a day and
   read `notification_sends` to sanity check who would have been targeted.
5. Turn off dry run with `NOTIFICATIONS_MAX_PER_RUN=50` and only
   `streak_at_risk` enabled. It is the one message a user would be annoyed to
   have missed.
6. Widen from there. Opt-outs are permanent and there is no re-permission flow.

### How the audience is built (and why not on-chain detection)

The obvious idea is to find Base App users by classifying wallets on-chain:
Base App uses a Base Account, so look for Coinbase Smart Wallet contract code
or an EIP-7702 delegation to `0x7702cb554e6bfb442cb743a7df23154544a7176c`.

**That was tried against this database and it does not work.** 3,000 wallets
were probed with batched `eth_getCode` on Base across six cohorts: newest
linked, oldest linked, random `TABLESAMPLE`, recent sweepers, recent
check-ins, and the `spin_history.execution_type = 'smart_wallet'` cohort.
Every single one was a plain EOA. Zero contract accounts, zero delegations.

Two reasons it fails, and only one of them can be engineered around:

1. A Coinbase Smart Wallet that has never sent a transaction is
   **counterfactual**: the address is deterministic but no code is deployed, so
   `eth_getCode` returns `0x`. Check-ins are free and sign-in is off-chain, so a
   Base App user can be active in DustSwap for months without ever deploying.
2. Even a correctly identified smart account tells you nothing about whether
   the user **pinned the app and left notifications on**, which is the only
   thing that determines delivery.

So the audience is built from Base's own send response instead, which is an
exact per-wallet oracle delivered 1,000 addresses at a time:

| Response | Meaning | Recorded state |
| --- | --- | --- |
| `sent: true` | Base App user, notifications on | `confirmed` |
| `user has notifications disabled` | **Is** a Base App user, notifications off | `notifications_off` |
| `user has not saved this app` | Not pinned | `not_pinned` |

The middle row is the valuable one: it proves Base App membership without the
user receiving anything, which makes it the cheapest possible signal for who to
show a "turn notifications on" prompt to.

Sending to a non-member delivers nothing and is not spam, so probing is safe.
With `NOTIFICATIONS_DISCOVERY_MODE=true` the segments run over the whole user
base; wallets that fail `NOTIFICATIONS_MAX_CONSECUTIVE_FAILURES` times drop out
of probing, so the list converges on real Base App users within about a week
and new users are picked up automatically.

Dispatch is ordered `is_confirmed DESC` first, so `NOTIFICATIONS_MAX_PER_RUN`
always spends its budget on known Base App users before spending anything on
discovery.

### Cooldowns

Two independent caps, because they solve different problems:

- **Global** (`NOTIFICATIONS_GLOBAL_COOLDOWN_HOURS`, 24h) stops five campaigns
  stacking on one person in a day.
- **Per-campaign** (`cooldownHours` in the campaign definition) stops a single
  campaign repeating against a population that permanently matches it.

`daily_check_in` matches ~165,000 accounts and a dormant account matches it
every day forever, so it runs at **72h**. `streak_at_risk` runs at 20h, which is
safe because its segment additionally requires `last_check_in >= yesterday`:
`current_streak` is never reset when a day is missed, so without that clause a
user who lapsed months ago would match every night indefinitely.

### Measured segment sizes

Run `pnpm notifications segments` to reproduce. Against 209k users in discovery
mode:

| Campaign | Accounts | Requests at 1000/send |
| --- | --- | --- |
| `daily_check_in` | ~164,700 | 165 |
| `unspent_tickets` | ~19,300 | 20 |
| `streak_at_risk` | ~1,370 | 2 |
| `dust_detected` | 119 | 1 |
| `streak_broken` | 29 | 1 |

Worst case is under 200 requests a day, roughly 13 minutes at 15 req/min. The
rate limit is not the binding constraint; the size of the opted-in audience is.

### Discovery mode has a built-in cap

`NOTIFICATIONS_MAX_PER_RUN` unset means "no cap" in steady state, where every
recipient is a confirmed Base App user. It does **not** mean that in discovery
mode: there, an uncapped run fires ~165,000 sends on the first tick after
deploy, nearly all of which come back `user has not saved this app`.

That is not spam (Base delivers nothing to a non-member) but a near-100%
failure rate is exactly the traffic shape an anti-abuse system is built to
notice. So discovery falls back to **2,000 recipients per run** unless an
explicit cap is set. Dispatch is ordered confirmed-first, so that budget is
always spent on real Base App users before any of it goes to probing.

### Audit notes

Bugs found and fixed by executing the write paths against a real database
inside a rolled-back transaction, rather than by reading the code:

| Bug | Symptom if shipped |
| --- | --- |
| `learnFromResults` used `INSERT ... SELECT FROM (VALUES ...)` with untyped parameters | `column "user_id" is of type integer but expression is of type text` on the **first real send**, aborting the run. The audience would never have learned anything. |
| `syncNotificationAudience` never set `state` | Newly synced opted-in wallets defaulted to `state = 'unknown'`, and steady-state segments select on `state = 'confirmed'`, so the audience would have been silently empty. |
| The opt-out sweep cleared `notifications_enabled` but left `state = 'confirmed'` | Opted-out wallets would stay in every steady-state segment forever. |
| `fetchAudience` looped on `nextCursor` with no guard | A repeated cursor spins forever while holding the advisory lock and burning the shared rate limit, wedging every campaign behind it. |
| `resolved` ordered by `is_primary` only | After a merge the Base App wallet is often the linked secondary; the segment kept addressing an unreachable EOA and ignoring the wallet Base had already confirmed. |
| Pin prompt advertised "Dust alerts" | `dust_detected` ships disabled, so the sheet promised a notification the backend never sends. Benefits are now derived server-side from the campaigns that are actually on. |
| Pin sheet action buttons rendered under the mobile nav | Measured at y=778-824 against a nav at y=774-844. Both buttons were unreachable. |
