# Card provisioning branch closeout — 2026-07-25

This branch is closed as a software hardening release, not as a completed
physical production acceptance. The exact bench card is currently disconnected.

## What shipped

- `origin/main`, `origin/led-density-per-meter`, and the workspace all point to
  signed release commit `a3d5530`.
- The current official factory release is firmware `1.0.0`, build
  `85bcda15c03e466f7c6528165641ae734cfffc4e`, target `esp32-s3-n16r8`.
- Cloudflare deployment run `29884602213` completed successfully and verified
  the live Studio, signed firmware, provenance, indexed production job, and
  reachable build assets.
- The final local verification before publishing passed 748 unit tests, all 65
  Production Setup browser tests, and the production build.
- Production Setup now keeps USB identity immutable, distinguishes blank from
  connected, bounds USB/reset and LAN waits, retries stale AP/station page
  addresses through one named card tab, and requires exact fresh command-ready
  evidence before showing a connected/success state.
- Firmware now exposes explicit blank/readiness state, a bounded factory beacon,
  verified Wi-Fi join/handoff phases, delayed exact acknowledgement, bounded AP
  retirement, deterministic station retry, and recovery AP behavior.

## Real-card evidence

- USB/eFuse MAC `44:1B:F6:81:FE:B0` was repeatedly identified as canonical card
  `lw-b0fe81f61b44`; the former byte-swapped ID was rejected.
- Live Studio fully erased and flashed that card with the then-current signed
  build `e4b4858`. The previous station route at `192.168.18.70` disappeared
  after erase, and Studio remained **Not connected**.
- Before erase, the same card had returned on the gallery LAN and truthfully
  reported factory/blank state with `commandReady: false`. That proved the Wi-Fi
  association and blank classification, not a finished card.
- In the final live retry, Studio again verified the exact USB card, released
  USB, and attempted the bounded local-page preflight. The workstation stayed
  on the gallery network while the card was expected on its setup AP, so neither
  the setup route nor mDNS supplied current exact-card evidence. Studio stopped
  with `LW-CARD-202`, offered same-card recovery, made no project mutation, and
  continued to show **Not connected**. A browser-cached card page was not
  accepted as authority.
- The requested macOS switch to `Lightweaver-1B44` was not performed. Adrian
  later confirmed that the card was no longer connected.

## What was not proved

The card is not ship-ready, and the production flow does not yet have a complete
real-card acceptance record. No pass is credited for:

- the current official firmware build being installed on the card;
- the setup-AP-to-gallery-LAN handoff completing uninterrupted in live Studio;
- **Blank — load a project** being observed after that handoff;
- project write and independent read-back for GPIO 18, 44 pixels, GRB, Aurora,
  1500 mA, and brightness limit 0.35;
- full-strip boundary checks or a visible 44-pixel Aurora result;
- power-cycle persistence, offline playback, recovery AP timing, or automatic
  same-card return; or
- an exported JSON/CSV production pass record.

The exact continuation procedure and stop rules remain in
[`new-card-checklist.md`](new-card-checklist.md). The next hardware session must
start a fresh Production Setup run and reidentify the card over USB; it must not
resume from a cached card tab or infer success from the earlier flash.

