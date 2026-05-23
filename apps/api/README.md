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
