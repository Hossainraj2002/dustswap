# Quest Env Setup

This project now has a small quest/X env section in both the API and web env files.

## Local development

Fill these in `apps/api/.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` optional fallback
- `NEXT_PUBLIC_APP_URL`
- `QUEST_ADMIN_TOKEN`
- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `X_REDIRECT_URI`
- `X_BEARER_TOKEN`
- `X_STATE_SECRET`

Recommended local values:

- `NEXT_PUBLIC_APP_URL=http://localhost:3000`
- `X_REDIRECT_URI=http://localhost:3001/api/quests/x/callback`

## Supabase dashboard mapping

Supabase now shows newer key names in many dashboards, so the env names in this repo do not always match the exact label you see in the UI.

Use this mapping:

- `SUPABASE_URL` = `Project URL`
- `SUPABASE_ANON_KEY` = `Anon Key (Legacy)` if available
- `SUPABASE_SERVICE_ROLE_KEY` = backend-only elevated key

Important:

- If Supabase shows you a new `Secret Key` like `sb_secret_...`, you can use that value for `SUPABASE_SERVICE_ROLE_KEY` in this repo.
- If you do not see a legacy `service_role` key, that is normal on newer Supabase projects.
- The `Connection String` is not what we need for this app right now.
- Do not put the secret/service key in the web app envs.

If your project only shows:

- `Project URL`
- `Publishable Key`
- `Anon Key (Legacy)`

then you already have enough for:

- `SUPABASE_URL` from `Project URL`
- `SUPABASE_ANON_KEY` from `Anon Key (Legacy)`

For `SUPABASE_SERVICE_ROLE_KEY`, go to the API keys or API settings area and create/copy a server-side secret key. Supabase docs now recommend secret keys over the old legacy `service_role` key.

For this repo today, the minimum backend setup is:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`SUPABASE_ANON_KEY` is optional because the API already prefers the service key first.

Fill these in `apps/web/.env.local`:

- `NEXT_PUBLIC_API_URL=http://localhost:3001`
- `NEXT_PUBLIC_APP_URL=http://localhost:3000`

## Railway API envs

Set these on Railway for the API service:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_APP_URL`
- `QUEST_ADMIN_TOKEN`
- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `X_REDIRECT_URI`
- `X_BEARER_TOKEN`
- `X_STATE_SECRET`

Production example:

- `NEXT_PUBLIC_APP_URL=https://your-web-app.vercel.app`
- `X_REDIRECT_URI=https://your-api.railway.app/api/quests/x/callback`

## Vercel web envs

Set these on Vercel for the web app:

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_APP_URL`

Production example:

- `NEXT_PUBLIC_API_URL=https://your-api.railway.app`
- `NEXT_PUBLIC_APP_URL=https://your-web-app.vercel.app`

## Current admin login

Right now the admin page is protected by `QUEST_ADMIN_TOKEN`.

Flow:

1. Set `QUEST_ADMIN_TOKEN` in the API env.
2. Open `/admin/quests` in the web app.
3. Paste the same token into the admin page input.
4. The page sends it as the `x-admin-token` header.

## Better admin auth later

Best next upgrade for this product:

1. Wallet whitelist in Supabase
2. Sign-In With Ethereum style signed message
3. Server checks signed wallet against the whitelist

That is a better fit than username/password for a wallet-first app.
