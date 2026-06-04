#!/usr/bin/env bash
#
# Rebuild the Lightweaver factory firmware image that the public Studio
# (led.mandalacodes.com) flashes to ESP32-S3 cards at offset 0x0.
#
# Produces a merged bootloader + partition table + boot_app0 + app image with the
# same layout as the committed binary, and writes it into the website's public
# assets so a redeploy ships current firmware.
#
# WHY THIS EXISTS: the flashed binary has no automatic build, so it silently went
# stale (cards flashed old firmware while source kept improving). Run this whenever
# firmware/lightweaver-controller/src changes, then commit the binary. The
# `factory-bin-freshness` test fails the launch gate until you do.
#
# REQUIREMENTS: PlatformIO (`pip install platformio`) with network access to the
# PlatformIO package registry. CI runners and dev machines have this; the
# sandboxed Claude agent environment does NOT (its egress allowlist blocks the
# toolchain host), which is why this is a script you run rather than something the
# agent can execute.
#
# USAGE:
#   firmware/lightweaver-controller/scripts/build-factory-bin.sh
#   git add lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin
#   git commit -m "Rebuild Lightweaver factory firmware binary"
#   cd lightweaver && npm run deploy:pages     # publish so the site serves it

set -euo pipefail

ENV=esp32-s3-n16r8
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$FW_DIR/../.." && pwd)"
BUILD_DIR="$FW_DIR/.pio/build/$ENV"
OUT="$REPO_ROOT/lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin"

echo "==> Building firmware ($ENV)"
pio run -d "$FW_DIR" -e "$ENV"

# boot_app0.bin ships inside the Arduino-ESP32 framework package (the only place
# this filename appears), so match by name alone — note the framework dir is
# "framework-arduinoespressif32", which does NOT contain the literal "esp32".
BOOT_APP0="$(find "${HOME}/.platformio/packages" -name boot_app0.bin 2>/dev/null | head -1 || true)"
if [ -z "${BOOT_APP0}" ]; then
  echo "!! boot_app0.bin not found under ~/.platformio/packages" >&2
  exit 1
fi

echo "==> Merging factory image (bootloader@0x0, partitions@0x8000, boot_app0@0xe000, app@0x10000)"
# Uses esptool's merge_bin. If 'esptool.py' is not on PATH in your PlatformIO,
# try 'esptool' instead. Flash params mirror the esp32-s3-devkitc-1 defaults; the
# Web Serial flasher writes with flashMode/Freq/Size = 'keep', so these headers
# are what the card ends up using.
pio pkg exec -- esptool.py --chip esp32s3 merge_bin \
  --flash_mode dio --flash_freq 80m --flash_size 16MB \
  -o "$OUT" \
  0x0     "$BUILD_DIR/bootloader.bin" \
  0x8000  "$BUILD_DIR/partitions.bin" \
  0xe000  "$BOOT_APP0" \
  0x10000 "$BUILD_DIR/firmware.bin"

# Keep the built-site copy in sync if a dist/ exists locally.
DIST="$REPO_ROOT/lightweaver/dist/firmware/lightweaver-controller-esp32s3-factory.bin"
if [ -d "$(dirname "$DIST")" ]; then
  cp "$OUT" "$DIST"
  echo "==> Synced dist copy"
fi

echo "==> Done"
ls -la "$OUT"
echo
echo "Next:"
echo "  git add ${OUT#"$REPO_ROOT/"}"
echo "  git commit -m 'Rebuild Lightweaver factory firmware binary'"
echo "  cd lightweaver && npm run deploy:pages"
