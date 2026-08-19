#!/usr/bin/env bash
# One-command bench loop: build the Lightweaver firmware locally and flash it
# over USB. No CI, no signer, no signing — the signature gate only guards the
# Wi-Fi update path, and USB flashing is how development iterates.
#
#   bash scripts/firmware-dev.sh              # auto-detect the USB card
#   bash scripts/firmware-dev.sh /dev/cu.usbmodemXXXX
#
# Measured on this repo: ~50s clean build, ~20s incremental, ~22s flash.
# The card hard-resets itself after the write and keeps Wi-Fi, the installed
# project, patterns, and settings (only the app partition is rewritten).
#
# Dev builds report buildId "dev" and buildNumber 0 on /api/status — that is
# deliberate, so a bench build can never be mistaken for a signed release.
# Shipping to the world (or to a card you cannot reach over USB) still goes
# through merge → protected signer → signed Wi-Fi update.
set -euo pipefail

cd "$(dirname "$0")/../firmware/lightweaver-controller"

PIO="${PIO:-}"
if [ -z "$PIO" ]; then
  if command -v pio >/dev/null 2>&1; then PIO=pio
  elif [ -x "$HOME/.platformio/penv/bin/pio" ]; then PIO="$HOME/.platformio/penv/bin/pio"
  else
    echo "PlatformIO not found. Install it or set PIO=/path/to/pio." >&2
    exit 1
  fi
fi

PORT="${1:-$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)}"
if [ -z "$PORT" ]; then
  echo "No USB card found (looked for /dev/cu.usbmodem*). Plug the card in, or pass the port explicitly." >&2
  exit 1
fi

echo "Building and flashing to $PORT …"
"$PIO" run -t upload --upload-port "$PORT"

echo
echo "Flashed. The card reboots itself and keeps Wi-Fi, project, and settings."
echo "Check it:   curl -s http://lightweaver.local/api/status | head -c 300"
echo "Serial log: $PIO device monitor --port $PORT"
