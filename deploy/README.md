# Publishing Verea

| Piece | Where | Cost |
|---|---|---|
| Domain `verea.app` (DNS on Cloudflare) | Cloudflare Registrar | ≈ US$14 / year |
| Web app (`frontend/`, static) | Cloudflare Pages, `https://verea.app` (also `verea.pages.dev`) | free |
| 4G coverage map tiles (186 MB PMTiles) | Cloudflare R2 bucket `verea-tiles`, `https://tiles.verea.app` | free tier (10 GB, no egress fees) |
| API (`backend/` + `core/`) | Fly.io app `verea-api` at `https://api.verea.app`, Dallas (`dfw`; Querétaro was retired), 1 GB, stops when idle | ≈ US$2–6 / month |
| Data for the API (DEM, 4G GeoPackage + tile cache, relief) | Fly volume `verea_data` (10 GB) at `/data` | ≈ US$1.5 / month |
| Accounts and projects | Supabase (free plan; pauses after a week without use) | free |

The Cloudflare token needs Account › Cloudflare Pages: Edit, Account › Workers R2 Storage: Edit and
Zone › DNS: Edit (verea.app). Tokens live in `~/.config/verea/deploy.env` (outside the repo, `chmod 600`); `deploy.sh` reads them.

## Once

1. **R2 bucket for the tiles** (with the Cloudflare token):
   ```
   cd frontend
   npx wrangler r2 bucket create verea-tiles
   npx wrangler r2 bucket domain add verea-tiles --domain tiles.verea.app --zone-id <verea.app zone id>
   # VEREA_TILES_URL=https://tiles.verea.app (r2.dev URLs are rate-limited)
   npx wrangler r2 bucket cors set verea-tiles --file ../deploy/r2-cors.json
   ../deploy/deploy.sh tiles
   ```
2. **Pages project:** `npx wrangler pages project create verea --production-branch main --force`
   (`--force` = classic Pages: without it wrangler 4.149+ turns the app into a Worker, rewriting
   `vite.config.ts` / `package.json`, and fails with this token). Then add the custom domain
   `verea.app` to the project (API `pages/projects/verea/domains`) and a proxied DNS CNAME
   `verea.app → verea.pages.dev`.
3. **API on Fly.io:**
   ```
   flyctl apps create verea-api
   flyctl volumes create verea_data --region dfw --size 10 --app verea-api --yes
   flyctl secrets set SUPABASE_ANON_KEY=<the public anon key> --app verea-api --stage
   flyctl secrets set SUPABASE_SERVICE_ROLE_KEY=<the secret service_role key> --app verea-api --stage   # admins create accounts
   deploy/deploy.sh api
   # fill the volume on a bigger machine for an hour (≈ US$0.30), then back to 1 GB:
   flyctl scale vm performance-4x --memory 8192 --app verea-api --yes
   flyctl ssh console --app verea-api -C "python scripts/server_data.py"
   flyctl scale vm shared-cpu-1x --memory 1024 --app verea-api --yes
   ```
   The API opens the DEM and the 4G files when it starts: after `server_data.py`, the scale back
   restarts it with the data. Own address: `flyctl certs add api.verea.app --app verea-api` and a
   DNS CNAME `api → verea-api.fly.dev` (not proxied, so Fly can issue the certificate).
4. **Web app:** `deploy/deploy.sh web`.
5. **Supabase:** site URL and redirects for the new address (keeps localhost for development):
   `scripts/supabase_setup.py <ref> --site-url https://verea.app --redirect http://localhost:5173`.
6. **Google sign-in:** in Google Cloud → Google Auth Platform → Branding, home page
   `https://verea.app` and privacy policy `https://verea.app/privacidad.html` (verify `verea.app`
   in Google Search Console first);
   then Audience → Publish app.
   Clients → the web client → Authorized JavaScript origins: `https://verea.app` and `http://localhost:5173`
   (Google's own sign-in button, `VITE_GOOGLE_CLIENT_ID` in `frontend/.env.local`).

## Updates

- Frontend changed: `deploy/deploy.sh web`. Backend / core changed: `deploy/deploy.sh api`.
- New quarter of 4G data: rebuild the tiles (`scripts/build_coverage_tiles.py`), `deploy.sh tiles`;
  publish the new GeoPackage in the GitHub release, update `scripts/get_coverage.py` and run
  `server_data.py` on the server again (bigger machine, as above).
