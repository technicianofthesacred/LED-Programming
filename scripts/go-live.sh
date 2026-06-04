#!/usr/bin/env bash
#
# GO LIVE — publish the Lightweaver Studio (and the current firmware binary it
# flashes) to led.mandalacodes.com.
#
# Run this ON YOUR DESKTOP, once PR #4 is merged to main. It is the only manual
# step left: CI already rebuilt the firmware binary from current source, so this
# just builds and deploys the website (which serves that binary).
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
npm install                              # 'install' (not 'ci') dodges a known npm rollup optional-dep bug

echo "==> 3/4  Build the static site (also runs the launch gate's build)"
npm run build

echo "==> 4/4  Deploy to Cloudflare Pages (led.mandalacodes.com)"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if ! npx --yes wrangler whoami >/dev/null 2>&1; then
    echo
    echo "Not authenticated to Cloudflare. Do ONE of:"
    echo "    npx wrangler login        # opens a browser, then re-run this script"
    echo "  or set CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) and re-run."
    exit 1
  fi
fi
npx --yes wrangler pages deploy dist --project-name lightweaver

echo
echo "================================================================"
echo "LIVE. Verify in a browser (hard-refresh):"
echo "  https://led.mandalacodes.com"
echo "  https://led.mandalacodes.com/firmware/lightweaver-controller-esp32s3-factory.bin"
echo
echo "Then have the worker flash, following:  docs/worker-flash-runbook.md"
echo "(Deploy first, THEN flash — otherwise the card just gets old firmware.)"
echo "================================================================"
