#!/usr/bin/env bash
# Publish Verea (deploy/README.md):
#   deploy/deploy.sh tiles   4G coverage map tiles → Cloudflare R2 (once per quarter)
#   deploy/deploy.sh api     the API → Fly.io (after changing backend/ or core/)
#   deploy/deploy.sh web     the web app → Cloudflare Pages (after changing frontend/)
#   deploy/deploy.sh all     the three
# Tokens come from ~/.config/verea/deploy.env (outside the repo, chmod 600), never from here:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FLY_API_TOKEN, VEREA_TILES_URL (the bucket's public URL)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${VEREA_DEPLOY_ENV:-$HOME/.config/verea/deploy.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
export PATH="$HOME/.local/node/bin:$HOME/.fly/bin:$PATH"

PAGES_PROJECT=verea
API_URL=https://api.verea.app
TILES_BUCKET=verea-tiles
TILES_FILE=telcel_4g_2026q2.pmtiles

tiles() {
  (cd "$ROOT/frontend" && npx wrangler r2 object put "$TILES_BUCKET/$TILES_FILE" --remote \
    --file "$ROOT/data/coverage/$TILES_FILE" --content-type application/octet-stream)
}

api() {
  # --depot=false: the Depot builder hung rejecting the org token (2026-10-23)
  (cd "$ROOT" && flyctl deploy --remote-only --depot=false)
}

web() {
  : "${VEREA_TILES_URL:?set VEREA_TILES_URL (the R2 bucket public URL) in $ENV_FILE}"
  (cd "$ROOT/frontend" \
    && VITE_API_URL="$API_URL" VITE_COVERAGE_URL="$VEREA_TILES_URL/$TILES_FILE" npm run build \
    && npx wrangler pages deploy dist --project-name "$PAGES_PROJECT" --branch main --commit-dirty=true)
}

case "${1:-}" in
  tiles) tiles ;;
  api) api ;;
  web) web ;;
  all) tiles && api && web ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
