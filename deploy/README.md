# Publishing Verea

| Piece | Where | Cost |
|---|---|---|
| Web app (`frontend/`, static) | Cloudflare Pages, `https://verea.pages.dev` | free |
| 4G coverage map tiles (186 MB PMTiles) | Cloudflare R2 bucket `verea-tiles`, public URL | free tier (10 GB, no egress fees) |
| API (`backend/` + `core/`) | Fly.io app `verea-api`, Querétaro (`qro`), 1 GB, stops when idle | ≈ US$2–6 / month |
| Data for the API (DEM, 4G GeoPackage + tile cache, relief) | Fly volume `verea_data` (10 GB) at `/data` | ≈ US$1.5 / month |
| Accounts and projects | Supabase (free plan; pauses after a week without use) | free |

Tokens live in `~/.config/verea/deploy.env` (outside the repo, `chmod 600`); `deploy.sh` reads them.

## Once

1. **R2 bucket for the tiles** (with the Cloudflare token):
   ```
   cd frontend
   npx wrangler r2 bucket create verea-tiles
   npx wrangler r2 bucket dev-url enable verea-tiles      # prints https://pub-….r2.dev → VEREA_TILES_URL
   npx wrangler r2 bucket cors set verea-tiles --file ../deploy/r2-cors.json
   ../deploy/deploy.sh tiles
   ```
2. **Pages project:** `npx wrangler pages project create verea --production-branch main`.
3. **API on Fly.io:**
   ```
   flyctl apps create verea-api
   flyctl volumes create verea_data --region qro --size 10 --app verea-api --yes
   flyctl secrets set SUPABASE_ANON_KEY=<the public anon key> --app verea-api --stage
   deploy/deploy.sh api
   # fill the volume on a bigger machine for an hour (≈ US$0.30), then back to 1 GB:
   flyctl scale vm performance-4x --memory 8192 --app verea-api --yes
   flyctl ssh console --app verea-api -C "python scripts/server_data.py"
   flyctl scale vm shared-cpu-1x --memory 1024 --app verea-api --yes
   ```
   The API opens the DEM and the 4G files when it starts: after `server_data.py`, the scale back
   restarts it with the data.
4. **Web app:** `deploy/deploy.sh web`.
5. **Supabase:** site URL and redirects for the new address (keeps localhost for development):
   `scripts/supabase_setup.py <ref> --site-url https://verea.pages.dev --redirect http://localhost:5173`.
6. **Google sign-in:** in Google Cloud → Google Auth Platform → Branding, home page
   `https://verea.pages.dev` and privacy policy `https://verea.pages.dev/privacidad.html`;
   then Audience → Publish app.

## Updates

- Frontend changed: `deploy/deploy.sh web`. Backend / core changed: `deploy/deploy.sh api`.
- New quarter of 4G data: rebuild the tiles (`scripts/build_coverage_tiles.py`), `deploy.sh tiles`;
  publish the new GeoPackage in the GitHub release, update `scripts/get_coverage.py` and run
  `server_data.py` on the server again (bigger machine, as above).
