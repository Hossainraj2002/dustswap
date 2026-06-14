# Deploying Dustswap Docs (free, custom domain)

Your docs are an MkDocs Material site in `docs/` at the repo root (`docs/mkdocs.yml`, content in `docs/docs/`, build output in `docs/site/`). This is its own deployable unit, separate from `apps/` — Cloudflare Pages can build and deploy it independently. Cost: **$0/month**, with `docs.dustswap.wtf` as a custom domain.

## 1. Local preview

```bash
cd docs
pip install mkdocs-material
mkdocs serve
```

Open http://127.0.0.1:8000 to preview. `mkdocs build` produces a static `site/` folder you could also upload anywhere.

## 2. Push to GitHub

This `docs/` folder is tracked in the main `dustswap` repo (see `.gitignore` — `docs/*` is ignored except `docs/mkdocs.yml`, `docs/DEPLOY.md`, and `docs/docs/`; `docs/site/` build output stays ignored). Push your branch/commit to GitHub as usual — Cloudflare Pages builds straight from the repo.

## 3. Deploy on Cloudflare Pages (free) — as its own project

Create a **separate Pages project** just for the docs, so it deploys independently from your web app:

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Select the `dustswap` repo and the branch you want to deploy (e.g. `main`).
3. Build settings:
   - **Root directory**: `docs`
   - **Build command**: `pip install mkdocs-material && mkdocs build`
   - **Build output directory**: `site`
4. Deploy. You'll get a free `*.pages.dev` URL immediately. Future pushes to that branch auto-redeploy just the docs — your `apps/` projects are unaffected.

## 4. Add the custom domain

1. In the docs Pages project, go to **Custom domains** → **Set up a custom domain** → enter `docs.dustswap.wtf`.
2. Cloudflare gives you a CNAME target (something like `your-docs-project.pages.dev`).
3. In your DNS for `dustswap.wtf` (Cloudflare DNS), add:

   | Type  | Name | Target               |
   |-------|------|----------------------|
   | CNAME | docs | your-docs-project.pages.dev |

4. Wait for DNS propagation (minutes to a few hours) and HTTPS to provision automatically — free TLS cert included.

## Alternative: GitHub Pages (also free)

- Add a `CNAME` file containing `docs.dustswap.wtf` to the built `site/` output (or configure via repo Settings → Pages → custom domain).
- Add a CNAME DNS record pointing `docs` → `<username>.github.io`.
- Enable "Enforce HTTPS" in repo Pages settings once DNS resolves.

## 5. Edit pages from a web admin panel (no GitHub UI needed)

`docs/functions/` contains a small Cloudflare Pages Functions app — a password-protected `/admin`
page on the same `dustswap-docs` Pages project. It lets you browse, edit, create, and delete the
markdown files in `docs/docs/`, committing changes straight to GitHub on save.

- URL: `https://docs.dustswap.wtf/admin` (or `https://dustswap-docs.pages.dev/admin`)
- **No password is stored in the repo.** You must set `ADMIN_PASSWORD` yourself (see below) —
  until it's set, `/admin` login is disabled entirely.

**Required setup**: in the `dustswap-docs` Cloudflare Pages project → **Settings → Environment
variables**, add:

| Variable        | Value                                                                 |
|-----------------|------------------------------------------------------------------------|
| `ADMIN_PASSWORD`| Required. Pick your own password for `/admin` — not stored anywhere in the repo |
| `GITHUB_TOKEN`  | A GitHub fine-grained Personal Access Token, scoped to the `dustswap` repo, with **Contents: Read and write** permission |
| `GITHUB_REPO`   | `Hossainraj2002/dustswap` (only needed if it ever differs from the default) |
| `GITHUB_BRANCH` | `main` (only needed if it ever differs from the default) |

Until `ADMIN_PASSWORD` is set, every `/admin` login attempt is rejected (503). Until `GITHUB_TOKEN`
is set, `/admin` still works for browsing and viewing files, but Save/Delete will show an error
explaining the token is missing.

Each save/delete creates a normal commit on `main` (message like `docs admin: update <path>`),
which triggers the usual Cloudflare Pages rebuild — so edits go live automatically a minute or two
after saving.

## Notes

- Screenshots: drop your real images into `docs/docs/assets/screenshots/`, same filenames as the current placeholders, and rebuild.
- Search, dark/light toggle, and the collapsible sidebar groups are all built into the Material theme — no extra config needed.
- To add a logo/favicon later, set `theme.logo` and `theme.favicon` in `docs/mkdocs.yml` to a path under `docs/docs/assets/`.
- A leftover empty `docs/site-src/` directory may remain from a previous layout — it's harmless and can be deleted manually from your file explorer if it bothers you (the mounted filesystem wouldn't let the agent remove it).
