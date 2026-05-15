# Quest Env Setup

This project now has a small quest/X env section in both the API and web env files.

The current quest flow does **not** use X OAuth for normal user linking anymore.
Users now save their X username manually on `/quests`, and the backend uses your
`X_BEARER_TOKEN` to verify public post links.

## Local development

Fill these in `apps/api/.env`:

- `DATABASE_URL`
- `NEXT_PUBLIC_APP_URL`
- `QUEST_ADMIN_TOKEN`
- `X_BEARER_TOKEN`

Recommended local values:

- `NEXT_PUBLIC_APP_URL=http://localhost:3000`

## Railway Postgres Mapping

This repo uses plain PostgreSQL through `DATABASE_URL`.

Use this mapping in Railway:

- `DATABASE_URL` = the Railway-injected Postgres connection string for the API service
- `DATABASE_SSL_MODE=require` if the public Railway URL needs explicit SSL
- leave `DATABASE_SSL_MODE` blank for the default auto-detection

Important:

- Do not put `DATABASE_URL` in the web app envs.
- If you run SQL manually, run it against the Railway Postgres database.
- For local migrations through `.env.migration`, set `TARGET_DATABASE_URL` to Railway's public/external Postgres URL.

Fill these in `apps/web/.env.local`:

- `NEXT_PUBLIC_API_URL=http://localhost:3001`
- `NEXT_PUBLIC_APP_URL=http://localhost:3000`

## Railway API envs

Set these on Railway for the API service:

- `DATABASE_URL`
- `NEXT_PUBLIC_APP_URL`
- `QUEST_ADMIN_TOKEN`
- `X_BEARER_TOKEN`
- `STREAK_RECOVERY_ENABLED=false` unless you want to enable paid streak recovery

Production example:

- `NEXT_PUBLIC_APP_URL=https://your-web-app.vercel.app`

To re-enable the $1 check-in streak recovery flow later, set
`STREAK_RECOVERY_ENABLED=true` on the API service and redeploy/restart it.

## Vercel web envs

Set these on Vercel for the web app:

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_VOLUME_LEADERBOARD_ENABLED=false` unless you want the Volume leaderboard tab visible

Production example:

- `NEXT_PUBLIC_API_URL=https://your-api.railway.app`
- `NEXT_PUBLIC_APP_URL=https://your-web-app.vercel.app`

To make the Volume leaderboard public again later, set
`NEXT_PUBLIC_VOLUME_LEADERBOARD_ENABLED=true` on the web app and redeploy it.

## Current admin login

Right now the admin page is protected by `QUEST_ADMIN_TOKEN`.

Flow:

1. Set `QUEST_ADMIN_TOKEN` in the API env.
2. Open `/admin/quests` in the web app.
3. Paste the same token into the admin page input.
4. The page sends it as the `x-admin-token` header.

## Better admin auth later

Best next upgrade for this product:

1. Wallet whitelist in the database
2. Sign-In With Ethereum style signed message
3. Server checks signed wallet against the whitelist

That is a better fit than username/password for a wallet-first app.

## X Username Linking

Users now link X on the quest page by typing a username manually.

Accepted input examples:

- `DustswapOnBase`
- `@DustswapOnBase`

Saved output:

- `@DustswapOnBase`

Internal comparison key:

- `dustswaponbase`

That means:

- users never get saved as `@@name`
- username checks stay case-insensitive
- the backend can verify a pasted post link against the saved username

## X Post Verification

For `x_post_link` quests, the backend currently does one public X API lookup with
your app bearer token and verifies:

1. the pasted link contains a valid tweet id
2. the tweet author username matches the wallet's saved X username
3. required mentions match the quest rules
4. required hashtags match the quest rules
5. required links match the quest rules if you configured them

This does **not** require user OAuth.

## Optional Legacy OAuth

The API still contains legacy X OAuth routes for backward compatibility, so these
env vars are only optional now:

- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `X_REDIRECT_URI`
- `X_STATE_SECRET`

You do not need them for the current username-based quest flow.
