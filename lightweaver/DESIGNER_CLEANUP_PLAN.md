# Designer cleanup plan — WLED → Lightweaver Card rebrand

Wave 2 of the parent plan. The card now exposes a "pretend-WLED" JSON API
(`/json/info`, `/json/state`, `/json/effects`, `/json/palettes`) alongside the
Lightweaver-native API (`/api/status`, `/api/control`, `/api/zones`,
`/api/patterns`, `/api/config`). The designer should stop pretending the card
is a generic WLED controller it discovered on the LAN and start treating the
card as the first-class output. Months of pattern / timeline / patch-board
work stay untouched.

This document is a **plan**. No code is changed in this pass.

---

## 1. Inventory

### Components

| Path | Classification | Notes |
|---|---|---|
| `src/components/WledBar.jsx` | **Rename only** | The dot + IP input + Connect button is genuinely useful as a card connection bar. The wire underneath (`useWled` → `ws://host/ws` + `/json/state` POSTs) is exactly what the pretend-WLED API answers. Relabel "WLED" → "card". |
| `src/components/DevicesPanel.jsx` | **Hide/remove + Repoint** | Five sections of "WLED Controller / Controller Profile / First-Run Setup / Knob / WLED Basic Installer" are install-time WLED-firmware ceremony that no longer applies once the card runs Lightweaver firmware. Hide behind an "Advanced WLED tools" disclosure. Keep "Lightweaver Card" section and surface it first. |
| `src/components/Chrome.jsx` (`StatusBar`) | **Rename only** | Top-status reads `wledConnected / wledIp` which the card answers via the pretend-WLED endpoints. Just relabel. |
| `src/components/PatchBoardScreen.jsx` | **Keep as-is** | Already uses `cardPushClient` + `cardRuntimeContract`. This is the model for everything else. |
| `src/components/ExportDialog.jsx` | **Rename only** for the WLED preset path; **Keep as-is** for the Lightweaver Card target. The "Lightweaver Basic WLED" target is a file-format name (downloadable WLED preset bundle) so it stays a real, separate export option, just relabeled clearly so it doesn't look like the main path. |
| `src/components/SettingsScreen.jsx` | **Rename only** | "WLED push fps" → "Card push fps". |
| `src/components/LayoutScreen.jsx` | **Rename only** | Comment about "USB direct cap ... WLED/export can keep the project count above that" and `<WledBar/>` at line 2982 — relabel. |
| `src/components/OtherScreens.jsx` (`ExportScreen`) | **Rename only** | Headings "WLED + FastLED exports", row label "WLED 2D layout", `wled-basic.json` filename — leave filenames as is (file-format names), relabel the headings to clarify these are interchange formats, not the primary push. |
| `src/components/OtherScreens.jsx` (`FlashScreen`) | **Hide/remove** | The WLED firmware uploader is dead path now. The card ships with Lightweaver firmware. Move behind "Advanced WLED tools" disclosure. |
| `src/components/PatternModes.jsx` | **Rename only** | "WLED" / "PORT" portability badges (lines 922-923) get relabeled to "card preset" / "card port". Rotary copy reads "on chip after WLED install" — change to "on the card". |
| `src/components/Tweaks.jsx` | **Rename only** | `wledFps` state key + `lw_wled_push_fps` localStorage key. Keep the storage key for backwards compat, relabel in UI. |

### Lib files

| Path | Classification | Notes |
|---|---|---|
| `src/lib/deviceController.js` | **Keep as-is** | This is the card transport once Wave 2 lands. Functions like `postWledState`, `makeWledFrameMessage`, `makeWledWsUrl` will speak to the card's pretend-WLED endpoints unmodified. Worth a top-of-file comment that says "talks to the card via its pretend-WLED API; not for generic WLED devices anymore". |
| `src/lib/wledPixels.js` | **Keep as-is** | Pure RGB → hex string conversion, format-locked, no rename needed. |
| `src/lib/wledDiscovery.js` | **Keep as-is**, partially **Hide/remove** | The `SAFE_WLED_TEST_COLORS` and `sortWledDevices` helpers are still useful for the card. The "scan a /24 for /json/info" path is dead path on the card LAN if we use mDNS — survive as fallback but hide the LAN scan button. |
| `src/lib/wledControlContract.js` | **Hide/remove** (module level) | Encodes WLED encoder usermod + preset binding details that the card replaces with its native `/api/control`. The card already has its own controls config in `cardRuntimeContract.DEFAULT_CARD_CONTROLS`. Keep the file for advanced users still working on a real WLED rig; hide the section. |
| `src/lib/wledBasicExport.js` | **Keep as-is** | This builds a downloadable WLED preset bundle, a real interchange file. Useful when shipping a project to someone with a stock WLED ESP. Stays a Wave-N export target, not the primary path. |
| `src/lib/wledStockLooks.js` | **Keep as-is** | Pure data — WLED effect / palette IDs for the export bundle. |
| `src/lib/wledInstallWizard.js` | **Hide/remove** | "Save a WLED snapshot, audit the controller, apply the package" is install-time ceremony for a stock WLED controller. Move behind the same "Advanced WLED tools" disclosure. |
| `src/lib/controllerCompatibility.js` | **Hide/remove** | `auditWledControllerCompatibility` is used by the install wizard. Same disclosure. |
| `src/lib/controllerProfiles.js` | **Hide/remove** | The whole "save a profile from this WLED controller, calibrate color order, save a snapshot" flow disappears now that the card is the only target. Keep the module for the advanced path. |
| `src/lib/runtimeTargets.js` | **Rename only** | Tier IDs `wled-basic` / `advanced-artnet` should stay (file-format names) but new tier `card-native` should be added in Wave 2 (this is a Wave 2 todo, not a rename). |
| `src/lib/patternCompatibility.js` | **Keep as-is** | Pure compatibility gating logic. |
| `src/lib/flash.js`, `src/lib/flashPlan.js` | **Hide/remove** | ESP32 Web Serial WLED flasher. The card is pre-flashed with Lightweaver firmware. Behind disclosure. |
| `src/lib/cardRuntimeContract.js` | **Keep as-is** | Already the canonical card config builder. |
| `src/lib/cardPushClient.js` | **Keep as-is** | Already the canonical push client. |
| `src/hooks/useWled.js` | **Rename only** | This is the WebSocket hook the WledBar / StatusBar lean on. Talks `/json/state` so the card answers it unmodified. Rename file to `useCard.js` and exported hook to `useCard`; keep `lw_wled_ip` localStorage key for back-compat or migrate on read. |

### State / config

| Path | Classification | Notes |
|---|---|---|
| `src/state/ProjectContext.jsx` | **Rename only** | `wledIp`, `wledConnected`, `wledTransport`, `wledConnect`, `wledDisconnect`, `wledPush`, `wledGetInfo`, `wledGetState`, `wledSegmentMap` — large surface, mechanical rename to `card*`. Touch every consumer. |
| Serialized project keys (`devices.wledIp`, `devices.segmentMap`) | **Rename only with migration** | Bump project schema version, read both old + new on load, write new only. |
| localStorage keys (`lw_wled_ip`, `lw_wled_push_fps`) | **Keep as-is** | Leave the keys alone so existing users don't lose state. Read once, optionally migrate to `lw_card_*`. Not worth churn. |

### "Visitor Page" / Pi proxy

`/api/wled/*` routes referenced in `DevicesPanel.jsx` (`/api/wled/discover`,
`/api/wled/raw`, `/api/wled/snapshot`, `/api/wled/recover`, `/api/wled/ws`)
live on the Pi. None of these are needed for direct card talk. **Hide/remove**
from the primary UI; the only one we keep using is `/api/wled/ws` as the
proxy fallback for the WebSocket in the case where the card is on a different
subnet and the designer is hosted on the Pi.

---

## 2. Specific rename decisions

| Where | Current label | New label |
|---|---|---|
| WledBar.jsx | "WLED" (label next to IP input) | "Card" |
| WledBar.jsx | placeholder "192.168.x.x" | "lightweaver.local or 192.168.x.x" |
| WledBar.jsx | aria-label "WLED IP address" | "Card hostname or IP" |
| WledBar.jsx | aria-label "Connect to WLED" / "Disconnect from WLED" | "Connect to card" / "Disconnect from card" |
| WledBar.jsx | hint "Pi proxy" / "direct" · 25 fps max | "via Pi" / "direct" · 25 fps max (unchanged otherwise) |
| WledBar.jsx | "⚠ {n} LEDs" tooltip "WLED WebSocket may have trouble above ~500 LEDs per segment" | "Above ~500 LEDs the card's realtime stream may stutter; split into zones." |
| Chrome.jsx (StatusBar) | "WLED" · "● connected" / "○ disconnected" | "Card" · same dots |
| DevicesPanel.jsx | Modal section "WLED Controller" | "Card connection" |
| DevicesPanel.jsx | Row "IP Address" | "Hostname or IP" |
| DevicesPanel.jsx | Row "Network scan" / "Scan LAN" button | Move behind "Advanced WLED tools" disclosure; primary CTA becomes "Find card on this network" with mDNS resolve. |
| DevicesPanel.jsx | Status text "Looking for WLED..." / "WLED detected" / "{n} WLED device(s) found" | "Looking for card…" / "Card detected" / "{n} card(s) found" |
| DevicesPanel.jsx | Discover hint "uses Pi discovery, falls back in dev" | hide, or "tries mDNS first, then a LAN scan" |
| DevicesPanel.jsx | Section "Controller Profile" / "First-Run Setup" / "Knob" / "LED Basics" / "Calibration" / "Power Safety" / "Backup & Recovery" / "WLED Basic Installer" / "Madrix / Art-Net" / "Install Report" | Move all of these into "Advanced WLED tools" disclosure (kept, not deleted). |
| DevicesPanel.jsx | Section "Lightweaver Card" | promote to top of modal, just under "Card connection". |
| DevicesPanel.jsx | Section "WLED Segments" + "Push to WLED" button | Hide. The card uses zones from PatchBoard, not WLED segments. |
| DevicesPanel.jsx | Section "Visitor Page" / "Configure PRESET_MAP in visitor.html to match your WLED preset numbers" | leave; update copy to "match your card's pattern IDs". |
| SettingsScreen.jsx | Row label "WLED push fps" | "Card push fps" (storage key unchanged) |
| SettingsScreen.jsx | About line "Pattern engine: per-pixel JS sandbox · WLED WebSocket push" | "Pattern engine: per-pixel JS sandbox · card WebSocket push" |
| LayoutScreen.jsx | Tooltip "USB direct cap {n} LEDs; WLED/export can keep the project count above that." | "USB direct cap {n} LEDs; the card and export targets can hold more." |
| OtherScreens.jsx (ExportScreen) | Section "WLED + FastLED exports" | "Interchange exports (WLED, FastLED, CSV)" |
| OtherScreens.jsx (ExportScreen) | Tile desc "WLED 2D layout" | "WLED-format 2D layout" |
| OtherScreens.jsx (ExportScreen) | Tile desc "WLED presets, playlist, port list" | "WLED preset bundle for stock controllers" |
| OtherScreens.jsx (FlashScreen) | Tab/button "Fetch latest WLED", "● Flash complete — WLED is booting", "Official WLED release binaries..." | Keep wording (this whole screen is hidden by default behind "Advanced WLED tools"). |
| ExportDialog.jsx | Target tile "Lightweaver Basic WLED" / sub "WLED presets, playlist, and port checklist" | leave name, rewrite sub to "Preset bundle for stock WLED controllers (not your card)" so users know it's not the main path. |
| ExportDialog.jsx | Done-screen message "WLED Basic preset package generated. Upload or apply the included presetsJson, then load the playlist preset to cycle looks." | leave. |
| PatternModes.jsx | Rotary summary "...on chip after WLED install" | "...on the card after Push to card" |
| PatternModes.jsx | Portability badges "WLED" / "PORT" | "CARD" / "PORT" |
| ProjectContext.jsx | (internal symbol names) `wledIp`, `wledConnected`, `wledTransport`, `wledConnect`, `wledDisconnect`, `wledPush`, `wledGetInfo`, `wledGetState`, `wledSegmentMap` | `cardIp`, `cardConnected`, `cardTransport`, `cardConnect`, `cardDisconnect`, `cardPush`, `cardGetInfo`, `cardGetState`, `cardSegmentMap` |
| useWled.js → useCard.js | exported hook `useWled` | `useCard` |
| deviceController.js | top-of-file JSDoc | add "Speaks to a Lightweaver card via its pretend-WLED API. Not used for generic third-party WLED devices anymore (those live under Advanced WLED tools)." |

Note: filenames containing `wled` (`wledBasicExport.js`, `wledStockLooks.js`,
etc.) should **stay**. They name WLED-format interchange files; the format
name itself is "WLED", that's not the rebrand. Same for `toWLEDLedmap`,
`DEFAULT_WLED_APP_FLASH_ADDRESS`, `WLED_BASIC_TIER_ID`. Mechanical renames
across pure interchange-format helpers create churn without clarifying
anything.

---

## 3. Where the customer-facing "card" status should surface

The designer already has heavy chrome (left panel, right panel, timeline,
master strip, status bar, WledBar). Adding a new panel is wrong. Two
placements, one primary and one detail.

### Primary: a single card strip just above the bottom WledBar (or replacing WledBar)

The existing `WledBar` already lives at the bottom of the chrome. Promote it
to the canonical **Card bar**, expand it slightly, and have it show all six
facts in one line:

```
[●] Card  lightweaver.local  ·  44 px  ·  Aurora  ·  192.168.18.70  ·  receiving Art-Net  ·  [Connect]
```

Layout left-to-right:

1. status dot (green / amber / red — connected / connecting / disconnected)
2. label "Card"
3. hostname (editable when disconnected, locked when connected)
4. pixel count from `/json/info` (`info.leds.count`)
5. current pattern name (from new `/api/status` — the card publishes its
   currently-playing pattern)
6. IP (resolved from hostname)
7. **streaming indicator** — small badge that lights up when the card reports
   it's currently receiving Art-Net or a WLED realtime stream (the firmware
   work Agents A + B are doing in parallel will expose this as a field on
   `/api/status`, e.g. `liveSource: "artnet" | "wled-realtime" | "self"`).
   Badge reads "Art-Net live" / "WLED stream live" / nothing when self-driven.
8. Connect / Disconnect button

This single bar gives the operator everything at a glance and matches the
"every status must be actionable" rule — clicking the streaming badge opens
the Devices panel to the relevant section; clicking the pattern name jumps
to PatternModes filtered to that pattern; clicking the IP copies it.

### Detail: top section of DevicesPanel.jsx

When the operator wants more, the Devices modal opens with the new "Card
connection" section at the top showing the same fields in a vertical Row
layout, plus:

- firmware version (`/json/info` → `ver`, but cross-checked with
  `/api/status` so we can show "Lightweaver fw 0.3.2" vs "stock WLED
  0.15.4")
- last "Push to card" timestamp
- free RAM / heap (already supported via `info.freeheap`)

Do not invent a third location. The bar is the at-a-glance read; the modal
is the deep dive. Everything else (PatchBoardScreen's own "Push to card"
button, the Chrome StatusBar) consumes the same `cardConnected / cardIp /
cardLiveSource` state, no new UI surface.

---

## 4. Things to deprecate quietly

All of these go behind one collapsed disclosure at the bottom of
DevicesPanel, labeled **"Advanced WLED tools"** with subtext "For working
with stock WLED controllers — not needed for your Lightweaver card."

| Bit | What it is today | Why it deprecates | Where it lives |
|---|---|---|---|
| WLED firmware uploader (`OtherScreens.jsx` FlashScreen + `lib/flash.js`) | Web Serial flow that downloads latest WLED .bin from GitHub and writes it to an ESP32 over USB | The card ships pre-flashed with Lightweaver firmware; there is no WLED install step anymore | "Advanced WLED tools" → "Flash WLED firmware" button that opens the existing FlashScreen modal |
| WLED Basic Installer + audit (`DevicesPanel.jsx` "WLED Basic Installer" section + `lib/wledInstallWizard.js` + `lib/controllerCompatibility.js`) | Audit a remote WLED controller and apply a preset bank to it | Card's pattern bank lives in firmware + zones; not preset slots | "Advanced WLED tools" → "Install WLED preset bundle" |
| WLED preset bank editor (the export target "Lightweaver Basic WLED" in ExportDialog + `wledBasicExport.js`) | Builds a downloadable presets bundle for any third-party WLED rig | Still useful as an export target if user gives a project to someone with stock WLED | Stays in ExportDialog with clearer sub-copy ("for stock WLED controllers, not your card") so it doesn't masquerade as the primary path |
| WLED Controller Profile + First-Run Setup + Knob setup + LED Basics + Calibration + Power Safety + Backup & Recovery sections in DevicesPanel | Configure a remote WLED ESP: name, MAC, color order, snapshot, encoder pin binding | All replaced by the card's `cardRuntimeContract.DEFAULT_CARD_CONTROLS` defaults + the firmware's own setup AP | "Advanced WLED tools" → "Configure WLED controller" disclosure (sub-collapsed, since it's deep) |
| Madrix / Art-Net section (DevicesPanel) | Enable Art-Net on a WLED controller, set start universe + fps | The card will accept Art-Net natively after Agent A's work; the UI for it should move to a new "Live input" section in PatchBoardScreen, not DevicesPanel | Move to PatchBoardScreen or a small "Live input" section in DevicesPanel that talks to the card's `/api/control`, not WLED cfg; the existing Madrix section gets hidden |
| WLED Segments section + "Push to WLED" button (DevicesPanel) | Maps strips to WLED segment IDs and pushes a `seg` array | The card uses zones from PatchBoard, not segments | Hide entirely; the existing patch board → card flow replaces it |
| WLED LAN scan ("Scan LAN" button in DevicesPanel) | Probes 192.168.x.1-254 for `/json/info` to find any WLED device | The card answers mDNS at `lightweaver.local`; LAN scan is for finding strangers' WLEDs | Move "Scan LAN" into the Advanced disclosure |
| `/api/wled/*` Pi proxy routes (DevicesPanel raw fetches) | Pi-side helpers that forward to a WLED device | The card is on the same LAN as the designer; direct fetch works | Quietly hide; keep the `/api/wled/ws` route as a WebSocket-proxy fallback only |

Implementation note: rather than building seven separate disclosure
mechanisms, put one `<Section>` at the bottom of DevicesPanel — `<Section
title="Advanced WLED tools" collapsed>` — and group all the above inside it.
Default-collapsed, label makes intent obvious.

---

## 5. The hostname → IP fallback

Today: `WledBar` has an IP input with placeholder `192.168.x.x`.
DevicesPanel's `cardHost` already accepts hostnames or IPs (logic at
`cardUrlBase()` in DevicesPanel).

`useWled.js` (becoming `useCard.js`) reads the IP from localStorage and
passes it to `makeWledWsUrl` which builds `ws://<host>/ws`. That URL accepts
a hostname (browsers will mDNS-resolve `lightweaver.local` on macOS / iOS /
desktop Chrome on Windows). The breakage path is Android Chrome (no mDNS) and
older routers that don't reflect mDNS.

### Smallest UI change

In WledBar, today's input is a single line with placeholder "192.168.x.x".
Three changes:

1. Change placeholder to `lightweaver.local or 192.168.x.x`.
2. Accept whatever the user types. Same `setIp(value)` call.
3. On Connect, if the input contains letters (i.e. looks like a hostname),
   try the connection. If the WebSocket open fails within ~3s
   (`CONNECTING_TIMEOUT_MS` already in WledBar), show a one-line inline hint
   under the bar: **"Can't reach lightweaver.local. On Android? Type the
   card's IP (printed on the card, or check your router)."**

That's it. No new screens, no router-scan UI, no QR code. The input field
itself is the fallback because it accepts both. The hint is the only
addition, and it only shows on failed connect.

Storage-wise: the existing `lw_wled_ip` localStorage key already stores
arbitrary strings, no schema change needed.

---

## 6. Risk notes

Things in the current code that will fight back when we point WLED-shaped
requests at the card.

**WLED `seg` (segments) array.** `makeWledSegments` and the "Push to WLED"
button in DevicesPanel build a `seg: [{ id, start, stop, on }]` array per
strip and POST to `/json/state`. The card's pretend-WLED API has to either
accept and ignore the `seg` array, or accept and translate it to zones. If
it ignores it, "Push to WLED" silently no-ops. The fix is to **hide that
button** (already covered in §4) and let the canonical "Push to card" flow
(zones via `cardRuntimeContract`) be the only path. **Risk: medium.** Catch
this in Wave 2 firmware acceptance criteria.

**`/json/state` POST with frame data.** `useWled` push path sends
`{ v: true, seg: [{ i: pixelsHexArray }] }` at up to 25 fps. The card's
pretend-WLED `/json/state` has to either honor the `seg.i` raw pixel array
(stock WLED does — this is the "live frame stream" path) or drop it cleanly.
If it drops, all live-preview-to-card output dies silently. **Risk: high
for the live preview feature.** Wave 2 firmware spec must explicitly include
"accept `seg[0].i` as a raw pixel array and render it on the default zone".

**`/json/info` response shape.** DevicesPanel reads `info.leds.count`,
`info.leds.fps`, `info.mac`, `info.freeheap`, `info.wifi.signal`,
`info.ver`, `info.name`. The card must publish all of these on its pretend
`/json/info`, otherwise the StatusBar / WledBar / DevicesPanel will all show
"unknown" or zero. **Risk: low.** Easy to verify with a snapshot test.

**`auditWledControllerCompatibility` in `controllerCompatibility.js`** reads
about a dozen fields from `/json/info`, `/json/state`, `/cfg.json`,
`/presets.json`, `/ledmap.json` and produces structured findings. The card
will not have `/cfg.json` or `/presets.json` or `/ledmap.json`. The audit
will report many "missing" findings on the card — looking like the card is
broken. Since we're hiding the audit under "Advanced WLED tools", this
becomes correct behavior ("running a WLED audit against your Lightweaver
card will show many missing fields — that's expected; your card is not a
WLED device"). Worth a one-line warning at the top of the Advanced
disclosure to that effect.

**Mixed-content on `led.mandalacodes.com/design`.** Designer at HTTPS,
card at HTTP. `cardPushClient` already handles this with a typed error +
copy-paste fallback. The WledBar / WebSocket path needs the same handling
when the designer is hosted at the public URL (`wss://` to `ws://card`
won't work). The Pi proxy at `/api/wled/ws` exists for this case, already
wired in `makeWledWsUrl`. Verify still wired in Wave 2.

**Color-order calibration on USB direct vs card.** WledBar has USB direct
controls (Warm, RGB Test, Cycle, swatch buttons) that are independent of
the card path. These stay; they target a separately-connected USB LED
controller, not the card. Don't accidentally hide them.

**Encoder firmware modes.** `WLED_ENCODER_FIRMWARE_MODES.LIGHTWEAVER_WLED`
exists as one of three encoder firmware options (alongside `STOCK_WLED`
and `ROTARY_USERMOD`). The rebrand should not collapse "Lightweaver WLED"
into "the card" — they're different things. "Lightweaver WLED" is a
custom WLED build that someone is running on a non-card ESP. Keep the
distinction in the Advanced disclosure.

---

## 7. Scope check for this pass

Wave 2 must **not** touch:

- **Pattern editor** (PatternModes.jsx beyond the three string renames in §2)
- **Timeline screen** (TimelineScreen.jsx)
- **AI pattern creator** (AiPatternAssistant.jsx)
- **Symmetry mode** (SymmetryMode.jsx)
- **Layout screen drawing tools** (LayoutScreen.jsx beyond relabeling the
  one tooltip in §2 and re-importing the renamed CardBar)
- **Patch board logic** (PatchBoardScreen.jsx push-to-card path is already
  correct and is the model for the rest)
- **Frame engine** (frameEngine.js, patternRegistry.js, patterns.js,
  patterns-library.js, customPatterns.js, motionSmoothing.js)
- **Preview surface** (Preview.jsx, previewVisuals.js,
  previewFallbackStrip.js)
- **Live recorder** (liveRecorder.js, LiveScreen.jsx)
- **Visitor page** (`src/visitor/`)
- **USB direct LED path** (usbLedFrame.js, usbLedColorOrder.js,
  usbLedStatusPolling.js, usbRotaryInput.js) — distinct from card, stays
- **Project serialization** (projectModel.js beyond adding the
  `cardIp / cardSegmentMap` migration shim)
- **Export interchange formats themselves** — wledBasicExport.js,
  wledStockLooks.js, wled-format ledmap export — these are file formats,
  format names stay
- **Tests** — only update the assertions that touch renamed strings;
  don't rewrite test scaffolding

Wave 2 **should** touch, in roughly this order:

1. `WledBar.jsx` → rename file to `CardBar.jsx`, relabel strings, add hostname placeholder, add streaming-source indicator hook
2. `ProjectContext.jsx` → rename `wled*` → `card*` keys; export both old + new selector names for one release to keep consumers building
3. `useWled.js` → rename to `useCard.js`; keep `lw_wled_ip` localStorage read for back-compat
4. `Chrome.jsx` StatusBar → relabel; consume new selectors
5. `DevicesPanel.jsx` → reorganize sections, move advanced bits behind disclosure, surface "Card connection" first
6. `OtherScreens.jsx` FlashScreen → behind disclosure
7. `SettingsScreen.jsx`, `Tweaks.jsx`, `PatternModes.jsx`, `LayoutScreen.jsx`, `ExportDialog.jsx` → string-level renames per §2
8. Add hostname→IP fallback hint in CardBar
9. Verify Push to card path on PatchBoardScreen still works (it should, no changes there)
10. Update `tests/` Playwright assertions for any of the renamed strings

The whole pass is mostly mechanical relabeling plus one large reorganization
of DevicesPanel. No deletions. Everything stays in the bundle.
