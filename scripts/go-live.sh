#!/usr/bin/env bash
#
# GO LIVE — publish the Lightweaver Studio (and the current firmware binary it
# flashes) to the `studio` PREVIEW branch of the lightweaver Pages project.
#
# DEPLOY OWNERSHIP (decided 2026-06-11, see docs/led-mandalacodes-setup.md):
# production at led.mandalacodes.com is the mandalacodes repo's bundle (landing
# at /, Studio at /design/). This script deploys this repo's Studio dist to the
# preview branch (https://studio.lightweaver-edw.pages.dev) so it can NEVER
# clobber the customer landing page. To ship production, rebuild and deploy the
# mandalacodes bundle per docs/led-mandalacodes-setup.md.
#
# Run this ON YOUR DESKTOP. CI already rebuilt the firmware binary from current
# source, so this just builds and deploys the preview site (which serves that
# binary for verification).
#
# PREREQUISITES (one-time on the desktop):
#   - Node.js 20+ and npm
#   - A Cloudflare account that owns the "lightweaver" Pages project
#   - Cloudflare auth, either:
#       npx wrangler login          # opens a browser, easiest
#     OR export a token before running this script:
#       export CLOUDFLARE_API_TOKEN=...      # token with "Pages: Edit"
#       export CLOUDFLARE_ACCOUNT_ID=...
#
# USAGE:
#   bash scripts/go-live.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # repo root

echo "==> 1/4  Update main"
git checkout main
git pull --ff-only origin main

echo "==> 2/4  Install web dependencies"
cd lightweaver
# `npm ci` installs exactly what lightweaver/package-lock.json pins, for a
# reproducible deploy (vs `npm install`, which can drift the dependency tree).
# NOTE: npm still does NOT reliably install platform-specific optional deps
# (npm/cli#4828). The ensure-rollup-native step below detects and recovers from
# the missing @rollup/rollup-<platform>-<arch>[-gnu] package automatically.
npm ci
node scripts/ensure-rollup-native.mjs

echo "==> 3/4  Build the static site (also runs the launch gate's build)"
npm run build

echo "==> 4/4  Deploy to Cloudflare Pages (studio preview branch)"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if ! npx --yes wrangler whoami >/dev/null 2>&1; then
    echo
    echo "Not authenticated to Cloudflare. Do ONE of:"
    echo "    npx wrangler login        # opens a browser, then re-run this script"
    echo "  or set CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) and re-run."
    exit 1
  fi
fi
npx --yes wrangler pages deploy dist --project-name lightweaver --branch studio

echo
echo "================================================================"
echo "PREVIEW DEPLOYED. Verify in a browser (hard-refresh):"
echo "  https://studio.lightweaver-edw.pages.dev"
echo "  https://studio.lightweaver-edw.pages.dev/firmware/lightweaver-controller-esp32s3-factory.bin"
echo
echo "PRODUCTION (led.mandalacodes.com = landing + /design) deploys from the"
echo "mandalacodes repo — see docs/led-mandalacodes-setup.md. Redeploy it after"
echo "Studio changes so /design and the served firmware binary pick them up."
echo
echo "Then have the worker flash, following:  docs/worker-flash-runbook.md"
echo "(Deploy production first, THEN flash — otherwise the card gets old firmware.)"
echo "================================================================"
