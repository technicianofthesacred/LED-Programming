# Handoff

## State — what works, what's stubbed, what's untested.

- **PR #7** (`claude/tender-dirac-b575t8` → `main`) is **open, green, mergeable** (`mergeable_state: clean`). 61 files, 13 commits. Subscribed to its PR activity.
- **CI green**: firmware compiles on GitHub Actions; the `deploy` check passes (skips cleanly with a notice because no Cloudflare secrets are set). CI has committed a fresh factory binary matching current source.
- **Firmware fixes (compile-verified by CI, NOT bench-tested — no card access)**: WiFi recovery buttons, AP-fallback banner + auto-rejoin state machine, scan polling + hidden-SSID entry, CORS origin allowlist, multi-range zone render, NVS-size guard, XSS escaping, Q10 animation timing, breathe BPM clamp, WLED JSON compat (`mac`/`col`/`sx`/`ix`/`pal`, per-segment `bri`), pinned lib majors.
- **led-art-mapper fixes (build-verified)**: real WLED index ledmap export, compiling FastLED header, HTTP `seg.i` live push, hidden-strip crash fix, project-save SVG round-trip, autosave-quota toast.
- **Studio fixes (test:unit 70/70, test:core all pass, build OK)**: SVG-import early return, flasher magic-byte validation, serial lifecycle, bridge async error path, bench-IP removed, dev-endpoint poll stop, HTTPS error messaging, keyed Timeline inputs.
- **Pipeline/docs**: deploy ownership settled (this repo → `studio` preview branch; prod = mandalacodes bundle), rollup-native recovery in gates, CI test gate, firmware→deploy dispatch (`source=ci` skips clean without secrets), lazy serialport import, debris removed, docs synced to ESP32-only plan.
- **Stubbed/deferred** (tracked in `TODO.md`): non-blocking fades, OTA, touch support on both editors, DevicesPanel convergence, mapper SVG transforms, `docs/segments.md` (still a template stub).
- **Untested**: all firmware behaviour on real hardware; Cloudflare deploy (no secrets configured → deploy step skips).

## Next — the exact commands or steps to continue, one per line, specific enough to paste.

- Merge PR #7: `gh pr merge 7 --squash` (or via the GitHub UI) — only blocker is your review.
- After merge, watch the rebuild+deploy chain: `gh run list --workflow=build-firmware.yml --branch main -L 3`
- (Optional) enable real deploys: add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` under Settings → Secrets and variables → Actions.
- Bench-test firmware before flashing a customer card — follow the checklist under "Bench verification" in `TODO.md` (wrong-password recovery banner, router power-cycle rejoin within ~2 min, captive-portal stability during retries, Studio + mapper push from localhost and led.mandalacodes.com).
- Redeploy the mandalacodes production bundle so `led.mandalacodes.com/design` and `/firmware/...factory.bin` pick up these changes (see `docs/led-mandalacodes-setup.md`).
