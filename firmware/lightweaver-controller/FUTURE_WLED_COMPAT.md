# Future WLED compatibility — what we left out

Lightweaver speaks just enough WLED for the in-house designer to talk to it. This file is the running list of what we deliberately skipped, why, and what it would take to add. Read this before you tell a future user "use any WLED app" — it will not work the way they expect.

The canonical Wave-2 decisions live in `lightweaver/DESIGNER_CLEANUP_PLAN.md` §6 (the audit-failure surface). Anything below that contradicts the cleanup plan, trust the plan.

## Known divergences from this doc (audited 2026-06-11)

The "Implemented" sections below were written slightly ahead of the code.
Current actual behaviour:

- `mac` — fixed: now 12 lowercase hex chars, no separators, per WLED convention.
- `seg[]` entries in `/json/state` — fixed: now emit `col` (three zeroed RGB
  triples), `sx`/`ix` (128), `pal` (0), `sel`/`rev`/`mi` with neutral values so
  clients that index `seg[].col[0]` unguarded don't crash. Values are static —
  pattern params are still not exposed.
- `lm` — **not emitted.** Use the non-standard `lwLive.source` instead.
- `leds.pwr` — **hardcoded 0**, not an estimated draw. `maxpwr` is also 0.
- `POST /json/state` with `v:true` — **ignored**; we always return
  `{"success":true}` instead of the verbose full state WLED returns.

---

## Implemented (this pass)

### `GET /json/info`

Returns the card's identity and live status. Fields we publish:

- `ver` — string, hardcoded `"0.15.0"`. Lies about being WLED so the designer's version gate accepts us. Real Lightweaver firmware build is on `/api/firmware-info`.
- `vid` — integer build id, mirrors firmware-info build.
- `leds.count` — total pixel count across all zones.
- `leds.rgbw` — false (we are GRB / RGB only this pass).
- `leds.wv` — 0.
- `leds.pwr` — current estimated draw in mA (rough; not for billing).
- `leds.maxpwr` — configured cap, mA.
- `leds.maxseg` — 1 (we collapse zones into one logical segment on the wire; see "Per-segment" gap below).
- `name` — piece name from storage.
- `udpport` — 21324, the WLED realtime port.
- `live` — boolean, true while a realtime source is driving the strip.
- `lm` — string, current live source: `"wled-realtime"`, `"artnet"`, or `""` when idle.
- `mac` — six-byte MAC as 12 lowercase hex chars, no separators (WLED convention).
- `ip` — current IPv4.
- `product` — `"Lightweaver"`. Intentionally not `"WLED"` — anyone sniffing for genuine WLED can branch on this.
- `lwLive` — Lightweaver-only nested object: `{ streaming: bool, source: string, lastFrameAgeMs: int, fps: int }`. Not part of the WLED spec; designer uses this to decide whether to fade its own UI.

### `GET /json/state`

- `on` — boolean, master on/off.
- `bri` — 0..255, master brightness.
- `transition` — fixed at 7 (WLED's default, in 100ms units).
- `ps` — currently selected preset slot, or -1 if none.
- `pl` — playlist id, -1 (we have no playlists).
- `seg` — array, one entry per zone:
  - `id` — zone index.
  - `start`, `stop` — pixel range.
  - `len` — pixel count.
  - `on` — boolean.
  - `bri` — 0..255.
  - `col` — array of three `[r,g,b]` triples (primary, secondary, tertiary). We populate primary from the active pattern's main colour; the other two are zeroed.
  - `fx` — integer index into the pattern bank (matches `/json/effects`).
  - `sx`, `ix` — speed/intensity, both fixed at 128 (we don't expose pattern params yet).
  - `pal` — palette index, fixed at 0.
  - `sel` — true.
  - `rev` — false.
  - `mi` — false.

### `POST /json/state`

Three accepted shapes, picked apart in order:

1. **Master state:** `{ on?: bool, bri?: 0..255, ps?: int }`. `on` toggles blackout, `bri` sets master, `ps` selects a saved preset (we only honour preset 0 = default, see gap below). Returns `{ success: true }`.
2. **Per-segment pattern + brightness:** `{ seg: [{ id, fx?, bri?, on? }, ...] }`. `fx` selects from the pattern bank. `bri` sets per-zone brightness. Per-segment `on` is parsed; whether the underlying renderer respects it depends on the zone map (see gap).
3. **Realtime frame push:** `{ seg: [{ i: ["RRGGBB", "RRGGBB", ...] }] }` — only the first segment is read. Each string is a hex pixel. Pushes the frame straight through the realtime pipeline and locks out internal patterns for 2 seconds (matches WLED behaviour). Returns `{ success: true }`.

Shapes are mutually exclusive per request. Mix at your own risk; later keys win.

### `GET /json/effects`

JSON array of strings, in the same order as `/api/patterns`. Index in this array is what `seg[].fx` accepts on POST. Length will not match stock WLED's 100+ effects — only the patterns this card actually has.

### `GET /json/palettes`

Fixed 6-element array of strings: `["Default", "Random Cycle", "Warm", "Cool", "Pastel", "Mono"]`. Cosmetic only — `seg[].pal` is parsed but ignored (see gap).

### `GET /json`

Returns `{ info, state, effects, palettes }` in one shot. WLED apps that do one big poll get everything; we don't optimise this — it's the same data, just stitched.

### Realtime UDP

- **WLED realtime, port 21324, DRGB protocol** (`02 <timeout> <R G B> ...`). One packet per frame, up to the pixel count. Timeout byte respected. Other protocols not implemented (see below).
- **Art-Net ArtDMX, port 6454.** 8 universes by default, 170 pixels per universe (512 channels / 3). Universe 0 starts at pixel 0; universe N starts at `N * 170`. Net + sub-net are ignored.

---

## NOT implemented — what a real WLED user might miss

### Other WLED realtime modes

**Stock WLED** also accepts WARLS (`01`), DNRGB (`04` — adds a 16-bit start index so you can push frames longer than one packet), DRGBW (`03`), DDP (port 4048), and E1.31 / sACN (port 5568, multicast).

**We don't** because DRGB covers the designer's use and the strip is short enough to fit in one packet. DNRGB is the most useful next addition for anyone wanting to drive >490 pixels from a single source. E1.31 would matter for lighting-desk integration.

**To add:** parse the first byte in `LightweaverWledRealtime.cpp::onPacket`, branch on `0x01/0x03/0x04`. DNRGB needs a 2-byte offset before the pixel run. E1.31 / DDP need their own listeners on different ports.

### Preset bank, playlists

**Stock WLED** persists up to 250 presets in `/presets.json`, edited via `POST /json/state` with `{psave: N, n: "name"}` and recalled with `{ps: N}`. Playlists chain presets with per-step durations.

**We don't** because our patterns already cover the "preset" concept and we have no UI surface for managing 250 of them.

**To add:** a presets table in `LightweaverStorage`, GET/PUT `/presets.json`, handling `psave`, `pdel`, and `ps>0` in the state POST. Playlists are a second feature on top.

### Per-effect parameter sliders (sx, ix, c1/c2/c3)

**Stock WLED** exposes speed (`sx`), intensity (`ix`), and three custom slider values (`c1/c2/c3`) per segment. Effects use them however they like.

**We don't.** Our patterns have hand-tuned animation parameters baked in. We parse `sx`/`ix` on POST so the request doesn't 400, but the values are discarded.

**To add:** thread params through `LightweaverPatterns::setParams(zoneId, sx, ix, c1, c2, c3)` and let each pattern opt in. Mostly an API + plumbing job.

### Per-segment palette selection (`pal`)

**Stock WLED** has 70+ palettes (gradient LUTs); `seg[].pal` picks one.

**We don't honour it** — patterns own their colours. The 6 names in `/json/palettes` are dressing so the designer dropdown isn't empty.

**To add:** a real palette LUT + a pattern-side hook to read it. Several patterns would need rewriting to query a palette rather than picking colours directly.

### Segment-level on/off/bri actually applied

We **publish** per-zone on/bri on GET, and we **parse** them on POST, but the underlying renderer is driven by the zone map and the global pattern engine — the per-segment values are advisory. Some patterns respect zone brightness, some don't.

**To add:** a per-zone mixer stage between the pattern output and the strip driver. Cleanly done it would also unlock per-zone fade and per-zone blackout from the app.

### UDP sync (master / follower)

**Stock WLED** can broadcast its own state on UDP so a second card mirrors it. Useful for multi-card installations.

**We don't.** Lightweaver installations so far are single-card. The Art-Net path is the supported way to drive multiple cards from one source.

**To add:** a `LightweaverWledSync` module that broadcasts current pattern + colour on a configurable port, and a follower mode that subscribes. The decision point is whether master/follower should preempt Art-Net.

### WebSocket `/ws`

**Stock WLED** serves `/ws` and pushes state updates so clients don't have to poll.

**We don't** because the designer uses HTTP POST to `/json/state` for control and the strip drives itself for status. AsyncWebServer can host a `/ws` endpoint; the bigger cost is the state-diff publisher.

**To add:** a per-client tick that JSON-serialises `state` on change and broadcasts. Reuse the `/json/state` builder.

### `/cfg.json`, `/presets.json`, `/ledmap.json`

**Stock WLED** exposes these as the audit / backup surface — full config, preset bank, and physical pixel map.

**We don't.** `DESIGNER_CLEANUP_PLAN.md §6` documents this as an expected audit failure: any tool that diffs against a vanilla WLED card will flag these as missing. That's fine — the cleanup plan accepts the audit gap rather than synthesising fake files.

**To add:** would mean serialising our config / patterns / zone map into the WLED schema. Lots of surface, modest value, would lock us into WLED's shapes for things we want to keep flexible.

### `ColorOrder` per segment

**Stock WLED** lets each segment declare GRB / RGB / BRG / etc.

**We don't.** A single global order is baked into the build config. Mixed-strip installations would need this.

**To add:** per-zone order in storage + a strip-driver branch. Cheap if FastLED's templated outputs are abandoned in favour of a runtime path.

### Flash partition / WLED OTA firmware update

**Stock WLED** accepts a `.bin` upload at `/update` and reboots into the new firmware.

**We ship our own firmware** and use PlatformIO's OTA flow. There is no value in pretending to be a WLED update target — flashing genuine WLED on the card erases Lightweaver, which is destructive and irreversible without a USB cable.

**To add:** explicitly not on the roadmap. If we ever did, it would be a dedicated `/api/firmware-update` that takes our own signed binary, not the WLED endpoint.

### Sound-reactivity hooks

**Stock WLED** (and WLED-SR / MoonModules forks) exposes a UDP audio-data input and effects that consume it.

**We don't.** No microphone, no audio listener, no sound-reactive patterns.

**To add:** a UDP audio receiver (the WLED SR protocol is documented) plus pattern hooks. Substantial work; would mostly serve a different audience than the gallery-installation case we're building for.

---

## Risk notes for downstream consumers

- **`/json/info.ver` is `"0.15.0"`.** This is a fib so the designer's version check accepts the card. Real firmware build is on `/api/firmware-info.build`. Anyone scripting against the version field will believe they're talking to WLED 0.15.0 and may try to use features we don't have. The `product` field (`"Lightweaver"`) is the honest signal — branch on that.

- **Designer segment editing is decorative.** The `WLED Segments` section of the designer's `DevicesPanel` sends segment arrays we parse and acknowledge but don't fully apply. Per-zone `on` and `bri` may or may not take effect depending on whether the active pattern respects them. Decision documented in cleanup plan §6: designer UI was not pared back to match.

- **`POST /json/state` realtime frames are exclusive.** Once a `{seg:[{i:[...]}]}` POST or a WLED-realtime / Art-Net packet arrives, internal patterns are suspended for 2 seconds after the last frame. Push frames at 25 fps and the card stays locked in realtime until you stop. This matches WLED behaviour exactly. Do not interleave realtime frames with `{seg:[{fx:N}]}` pattern selects at the same rate — the pattern select will be applied and then immediately overwritten by the next frame.

- **8 Art-Net universes by default.** Universe 0 = pixels 0–169, universe 1 = 170–339, etc. If the install grows past 1360 pixels the universe count needs to be bumped in firmware. There is no runtime config for this yet.

- **No authentication on any `/json/*` endpoint.** Anyone on the LAN can change state. Same posture as stock WLED. Not a regression, but worth flagging if the card ever leaves a trusted network.
