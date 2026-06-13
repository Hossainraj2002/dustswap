# Deploying Dustswap Docs (free, custom domain)

Your docs are now an MkDocs Material site in `docs/site-src/`. Cost: **$0/month**, with `docs.dustswap.wtf` as a custom domain.

## 1. Local preview

```bash
cd docs/site-src
pip install mkdocs-material
mkdocs serve
```

Open http://127.0.0.1:8000 to preview. `mkdocs build` produces a static `site/` folder you could also upload anywhere.

## 2. Push to GitHub

Put `docs/site-src/` (or your whole repo) on GitHub — Cloudflare Pages builds straight from a repo.

## 3. Deploy on Cloudflare Pages (free)

1. Go to the Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Select your repo and the branch.
3. Build settings:
   - **Build command**: `pip install mkdocs-material && mkdocs build`
   - **Build output directory**: `docs/site-src/site` (adjust path if `site-src` is at repo root, use `site`)
   - **Root directory**: point at `docs/site-src` if you want the build command to run from there instead.
4. Deploy. You'll get a free `*.pages.dev` URL immediately.

## 4. Add the custom domain

1. In the Pages project, go to **Custom domains** → **Set up a custom domain** → enter `docs.dustswap.wtf`.
2. Cloudflare gives you a CNAME target (something like `your-project.pages.dev`).
3. In your DNS for `dustswap.wtf` (Cloudflare DNS if your domain is already on Cloudflare, otherwise your registrar's DNS panel), add:

   | Type  | Name | Target               |
   |-------|------|----------------------|
   | CNAME | docs | your-project.pages.dev |

4. Wait for DNS propagation (minutes to a few hours) and HTTPS to provision automatically — free TLS cert included.

## Alternative: GitHub Pages (also free)

- Add a `CNAME` file containing `docs.dustswap.wtf` to the built `site/` output (or configure via repo Settings → Pages → custom domain).
- Add a CNAME DNS record pointing `docs` → `<username>.github.io`.
- Enable "Enforce HTTPS" in repo Pages settings once DNS resolves.

## Notes

- Screenshots: drop your real images into `docs/site-src/docs/assets/screenshots/`, same filenames as the current placeholders, and rebuild.
- Search, dark/light toggle, and the collapsible sidebar groups are all built into the Material theme — no extra config needed.
- To add a logo/favicon later, set `theme.logo` and `theme.favicon` in `mkdocs.yml` to a path under `docs/assets/`.
