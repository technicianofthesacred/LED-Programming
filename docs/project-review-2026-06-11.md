# Lightweaver full-project review — 2026-06-11

Four parallel deep reviews: firmware (`firmware/lightweaver-controller`), Studio
(`lightweaver/`), design tool (`led-art-mapper/`), and docs/CI/repo hygiene.
Builds and test suites were actually run where the sandbox allowed. Findings are
ordered by how badly they hurt a real customer or the artist, not by code area.

**Verified green:** firmware factory binary is fresh (bin commit post-dates last
src commit); `lightweaver` contract tests 36/36, unit 70/70 pass; production
build succeeds; `/e2e/` Playwright suite passes (5/5 chromium) when a dev server
is already running; `docs/handoff-card.md` matches actual firmware behavior.

---

## CRITICAL — things that do not function

### 1. Customer WiFi recovery is a dead end (firmware)
- The visitor page's **"Change WiFi" and "Factory reset" buttons are silently
  broken**: `src/LightweaverWeb.cpp:467-468` posts `{}` to `/api/factory-reset`,
  which requires `{"confirm":"RESET"}` and returns 400; no error is shown.
- Combined with the fallback logic at `LightweaverWeb.cpp:166-174` (setup form
  only shows when `!wifiConfigured`), a **typo'd WiFi password permanently
  strands a non-technical customer**: bad creds save → join fails → AP fallback
  shows the pattern page whose only WiFi escape hatch doesn't work.
- **No automatic station rejoin from AP fallback** (`LightweaverWeb.cpp:1117-1140`
  returns early when not in STA mode): a whole-house power blip where the router
  boots slower than the ESP32 leaves the piece stuck in AP mode until someone
  power-cycles it.
- Fix: point the visitor button at `/api/reset-wifi`, send the confirm token,
  surface errors; retry `WiFi.begin()` every 1–5 min while in AP-with-saved-SSID;
  show a "WiFi not connecting — re-enter password" card in that state. Also
  validate the password by attempting the join *before* saving + rebooting
  (`LightweaverWeb.cpp:808-823` currently saves blind).

### 2. led-art-mapper's headline exports are broken
- **The "WLED ledmap.json" export is not a valid WLED 0.15 ledmap**
  (`app/src/export.js:21-51`): it emits normalized float coordinate pairs
  (Pixelblaze-style); stock WLED expects an index-based `{"map":[i0,i1,...]}`.
  The README's "upload via WLED web UI" instruction will be rejected.
- **The FastLED header export never compiles** (`app/src/export.js:60`): whole
  numbers serialize as `0f`/`1f` — ill-formed C++. With normalize on (default),
  0 and 1 always appear, so every export fails. Fix: `pt.toFixed(4)+'f'`.
- **Live push to the card is a silent no-op**: `app/src/main.js:2378-2393` sends
  binary `[0x02,RGB...]` to `ws://<ip>/ws`, but the firmware explicitly ignores
  binary WS frames (`LightweaverWledWebSocket.cpp:131-134`) and serves WS on
  port 81; stock WLED doesn't accept this either. The UI still counts "N sent".
  The working HTTP `seg.i` fallback only engages if the WS *errors*.

### 3. Data-loss bugs in both design tools
- **Studio: a failed SVG import wipes the saved layout**
  (`lightweaver/src/components/LayoutScreen.jsx:787-808`): `setError` without
  `return`, then strips/patch board are cleared and the autosave overwritten.
  Undo is memory-only, so a reload after a bad import loses everything.
- **Mapper: "Save project" loses the artwork** (`app/src/main.js:2881-2902`
  omits `_svgSource` and `artworkLayers`) — the file save is *less* complete
  than the localStorage autosave; round-tripping to another machine drops the
  background and layers panel. Autosave restore also loses layer hidden/color
  state, and quota failures are swallowed (`main.js:3036 catch {}`).
- **Mapper: hiding a strip during playback crashes the animation loop**
  (`preview.js:250` global index vs visible-only `normalisedPixels`) — uncaught
  TypeError kills the rAF chain, and the WLED push frame misaligns.

### 4. Flasher can brick a card with HTML (Studio)
`src/components/OtherScreens.jsx:801-816` only checks `response.ok` on the
bundled firmware fetch; Cloudflare Pages returns the SPA `index.html` with 200
for missing paths, and `eraseAll` defaults true → erase chip, flash HTML.
Latent today (the bin exists) but one bad deploy triggers it. Fix: validate the
ESP image magic byte `0xE9` and a minimum size.

### 5. Launch gate and go-live fail on a fresh machine
`npm run launch:check` fails at the build step on a fresh clone (npm optional-
deps bug, missing `@rollup/rollup-linux-x64-gnu`); `scripts/go-live.sh:31`
claims plain `npm install` dodges this — it does not, and the CI deploy uses
the same `npm install`. Fix: add rollup-native recovery (or `npm ci` retry) to
launch:check, go-live, and `deploy-site.yml`. Related: `vite.config.js` imports
`server/index.js` at config-load time, making the *static* build depend on the
native `serialport` module — lazy-import the middleware.

### 6. Deploy/CI chain can put the wrong artifact in front of customers
- **Two artifacts deploy to the same Cloudflare Pages project**:
  `docs/led-mandalacodes-setup.md` says the mandalacodes-repo bundle (landing
  at `/`, Studio at `/design/`); `deploy-site.yml` / `go-live.sh` /
  `deploy:pages` deploy this repo's `lightweaver/dist` (Studio at root). Last
  writer wins — an auto-deploy clobbers the landing page (or the doc is stale).
- **The "never ship stale firmware" chain is broken by design**:
  `build-firmware.yml` pushes the rebuilt binary with `GITHUB_TOKEN`, whose
  pushes don't trigger workflows — so `deploy-site.yml` never redeploys after a
  firmware rebuild; the flasher serves a stale bin until a manual deploy.
- **No CI runs any tests** — `deploy-site.yml` deploys to production on push
  with no gate; launch:check is pure Node and fast.
- **The e2e webServer self-kills**: `led-art-mapper/app` dev script's
  `pkill -f 'vite'` matches its own launching shell → exit 143; e2e can never
  start cold / in CI.

---

## MAJOR — works wrong, degrades, or misleads

### Firmware
- **Stored XSS on the card page**: `escapeHtml` misses `'` inside single-quoted
  attributes (`LightweaverWeb.cpp:76-88`, used at `:359-365`); pattern labels go
  into `innerHTML` unescaped (`:453`, `:732`).
- **CORS `*` + private-network allow on every unauthenticated control endpoint**
  (`LightweaverWeb.cpp:37-43`): any website the homeowner visits can command the
  card, including `/api/reset-wifi` and factory reset (the confirm token is in
  the page source). Restrict to the Studio origin list the postMessage bridge
  already uses; consider an AP password on the handoff card.
- **Animations visibly degrade after days of uptime**: `scaleTime`
  (`LightweaverPatterns.cpp:3-6`) float-scales `millis()` — 24-bit mantissa
  quantizes to 32 ms steps by day 6, 128 ms by day 24, plus float→uint32 UB at
  speed >1. Accumulate scaled phase per frame in 64-bit instead.
- **Push-to-card can exceed the ~4 KB NVS string cap**
  (`LightweaverStorage.cpp:468`) — large playlists fail with an opaque "nvs
  write failed". Store in LittleFS/blob chunks and return a clear error.
- **Factory default mirrors the frame to 8 GPIOs**, over-subscribing the 4
  ESP32-S3 RMT channels (`main.cpp:469-481`; the code's own Serial warning at
  `:488-493` says this can silently drop outputs). Cap at 4 or make opt-in.
- **Multi-range zones render only their first range** (`main.cpp:705-707`)
  while storage and `/api/zones` advertise all ranges — split zones go dark
  with no error. Implement the loop or reject `rangeCount > 1` at save.
- **WLED JSON API diverges from its own spec doc** (`FUTURE_WLED_COMPAT.md`):
  colon/uppercase `mac` (`LightweaverWledJsonApi.cpp:52`), no `lm`, `pwr` hard 0,
  segments missing `col`/`sx`/`ix`/`pal` (WLED app indexes `seg[].col[0]`
  unguarded), `v:true` ignored, per-segment `bri` skipped once any earlier
  segment pushed a frame (loop-global `framePushed`, `:277`).
- **WiFi scan UI fetches once** (`LightweaverWeb.cpp:717-719`) while the scan is
  still async-running → permanent "No networks found", no rescan button, no
  hidden-SSID manual entry.

### Studio (lightweaver/)
- **The public site's WLED connect path fails silently**: default `direct` mode
  opens `ws://host:81` from HTTPS → throws, swallowed (`src/hooks/useWled.js:46-68`);
  HTTP controls prefer a `/api/wled` proxy that only exists in dev/Pi, then fall
  back to mixed-content-blocked `http://` (`src/lib/deviceController.js:58-82`).
  Result: spinner → red dot, no message, every control rejects.
- **Bridge-missing error escapes the friendly error path**:
  `sendCardBridgeRequest` throws synchronously when no card page is open
  (`src/lib/cardBridge.js:310-316`), bypassing the typed mixed-content wrapping
  in `cardPushClient.js:261-269` — the exact first-push case gets a raw error.
  Wrap the body in `async`.
- **Hardcoded personal bench IP shipped to everyone**:
  `src/lib/cardConnection.js:5` includes `192.168.18.70` in the probe/persist
  fallbacks. Remove.
- **DevicesPanel is a broken legacy push/scan path** (always `http://`, guessed
  diagnoses, 254 blocked fetches → "No WLED devices found"); ChipScreen does it
  right — converge.
- **Production app polls a dev-only endpoint at 1 Hz forever**
  (`src/hooks/useUsbLed.js:82-89`, mounted globally) — downloads the SPA HTML
  every second.
- **AI Pattern Assistant can't work on the deployed site**
  (`src/lib/aiPatternClient.js:37` posts to a dev/Pi-only route) — shows raw
  HTTP 404/405 to the user. Hide or explain.
- **Editing is mouse-only** (Layout drags/lasso/pan, Timeline drags, hover-only
  buttons) despite "accessible from phone" being the target. Pointer Events +
  coarse-pointer visible controls.
- Flash screen lifecycle holes (no try/finally on disconnect, no
  `navigator.serial` disconnect listener, port left locked on unmount); stale
  Timeline inspector inputs (`defaultValue` without `key`); single key `a`
  replaces all drawn strips with no confirm; silent autosave-quota failures;
  install audit reports results computed from swallowed-error empty data;
  fake hardcoded status text ("MIDI Launchkey", "WS2812B · 60/m", fixed mm
  dimensions) in `Chrome.jsx`.

### led-art-mapper
- SVG import ignores `transform` attributes (`canvas.js:1067-1122`) — Illustrator/
  Inkscape exports land offset/scaled and mm lengths (auto LED counts) are wrong.
- Compound-path split breaks relative (`m`) paths (`canvas.js:1128-1135`).
- Click mapping ignores viewBox origin and letterboxing (`canvas.js:120-127`).
- **The Draw tool documented in GUIDE/README doesn't exist in the UI** — no
  button, no `D` key handler; all the drawing code is dead. CLAUDE.md calls this
  "the canonical design tool: drawing LED strip paths."
- User pattern JS runs un-sandboxed via `new Function` with no infinite-loop
  guard — `while(true)` freezes the tab (worker + watchdog, or iteration cap).
- `strip.visible=false` not applied on load; pitch fencepost (`len/(N-1)` vs
  `round(len/pitch)`); gamma applied before pushing to WLED (double-gamma risk);
  `dev` script's `pkill -f 'vite'` kills every Vite on the machine; canvas is
  entirely mouse-event-based — no touch/tablet support.

---

## Docs / repo hygiene

- **`docs/deployment-checklist.md` (the named "deployment source of truth") is
  still Pi-centric** — no smoke test exists for the actual ESP32-only runtime
  (card page, knob, captive portal). Add an ESP32 lane; mark Pi sections deferred.
- **Four conflicting SSID conventions** across firmware (`Lightweaver-XXXX`,
  the real one), deployment-checklist, roadmap, and branded-installation-ui.
  Standardize on the firmware's.
- **`AGENTS.md` is a stale pre-ESP32-only copy of CLAUDE.md** (still says Pi 5
  in the runtime). Sync or include.
- **CLAUDE.md next-steps says "Flash WLED 0.15.4" is open**, but roadmap/
  hardware-setup record it done 2026-05-24.
- **`led-art-mapper/pi-server/` is an orphaned third Express server** referenced
  by zero docs, duplicating `lightweaver/server`; `controller/` and `pi-server/`
  carry byte-identical 1161-line `patterns.js` copies. Archive/deprecate.
- **`reference-repos/` are broken gitlinks with no `.gitmodules`** — fresh
  clones get empty dirs. `git rm --cached` them; the README documents the URLs.
- **`INDEX.md` is broken** (claims a generator script that doesn't exist; lists
  1 file). Fix or delete.
- Tracked debris: root `debug-*.mjs`/`test-*.mjs`/`*.png`, `lightweaver/ss-*.png`,
  `lightweaver/test-results/.last-run [conflicted 6].json` (needs `git rm` —
  gitignore won't untrack it).
- mDNS collision in waiting: checklist assigns `lightweaver.local` to the Pi
  while the firmware claims it for the card; handoff card promises
  `lightweaver.local` works on home WiFi, but Android mDNS is unreliable and no
  IP fallback is printed.
- `platformio.ini` pins no library versions (FastLED/ArduinoJson/WebSockets
  unpinned) — a CI rebuild of identical source can pick up a breaking major.
- No OTA path at all: shipped cards can only be fixed by USB reflash (house
  call / mail-back). Roadmap item.

---

## Top "make it effortless" moves, in order

1. **Fix the first-night failure chain on the card** (broken Change-WiFi button,
   no auto-rejoin, save-blind password flow, one-shot WiFi scan). This is the
   single most likely way a customer's first evening goes bad, and every part
   is firmware-only.
2. **Make the export/push moments actually work**: real WLED index ledmap +
   compiling FastLED header in led-art-mapper; fix the silent live-push no-op
   (JSON `seg.i` as primary, right port); fix the Studio bridge sync-throw so
   the friendly "open your card page" guidance always appears on HTTPS.
3. **Never lose work**: early-return on failed SVG import (Studio), embed the
   SVG in the mapper's saved project file, visible "autosave failed" banners.
4. **One connection story in the Studio**: collapse WledBar / DevicesPanel /
   ChipScreen / StatusBar into one protocol-aware card widget that leads with
   the bridge on HTTPS instead of letting `ws://`/`http://` fail silently.
5. **Harden the ship pipeline**: rollup-native recovery in launch:check/go-live/
   CI, resolve the Pages deploy-source conflict, fix the GITHUB_TOKEN trigger
   gap, add a CI test gate, fix the self-killing e2e dev script, magic-byte
   check in the flasher.
6. **Phone/tablet pass** on both editors (Pointer Events, visible controls on
   coarse pointers) — the stated target is "web interface accessible from
   phone" and today the editing surfaces are inert on touch.
