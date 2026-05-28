# TODO — Lightweaver (folder `led/`)

Living list of outstanding work on the LED installation controller. Project is branded **Lightweaver** in user-facing copy — `led/` is just the folder slug. See `CLAUDE.md` for stack and intent.

## Soon

(Add items here as they come up. Project is in active build, status snapshots live in [[project_led_is_lightweaver]] and recent capture logs.)

## Future

- [ ] **Mode 4 — Live Host runtime.** Reserved for future laptop/Pi/Madrix/sound-reactive streaming. Spec sketched but not built. See `docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md` for the four-mode runtime architecture (Mode 1 Factory Card / Mode 2 Website Loads The Card / Mode 3 Memory Card Advanced Sequence / Mode 4 Live Host).

## Operational notes (not TODOs — context for future-you)

- Lightweaver is hosted on Cloudflare Pages project `lightweaver` (NOT `mandalacodes`, NOT `adrian-website`). Custom domain `led.mandalacodes.com` is attached. Fallback URL: `lightweaver-edw.pages.dev`.

- ESP32-S3 firmware + WLED for the hardware side. Reliable write path is the ESP32 AP page at `http://192.168.4.1` — public HTTPS-to-private HTTP may be blocked by browsers.
