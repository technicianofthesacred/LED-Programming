# LED Art Mapper — Feature Roadmap

Ranked by implementation effort given the current architecture.
Items marked ✅ are already shipped.

---

## Already shipped

| Feature | Notes |
|---|---|
| ✅ SVG import → Illustrator layers as sections | Each `<g>` = one strip |
| ✅ Auto LED count from path length + pitch | pitch × px/mm |
| ✅ Layer highlight on section select | Dims other artwork layers |
| ✅ Eye toggle — hide/show section + artwork layer | Mirrors both at once |
| ✅ Per-section speed | Independent accumulated time per strip |
| ✅ Master speed slider | Scales all sections simultaneously |
| ✅ Physical length display per section | mm in sidebar |
| ✅ WLED / FastLED / CSV export | ledmap.json ready to upload |

---

## Tier A — Trivial  (< 2 hours each, isolated changes)

### A1. Per-section brightness
**What:** A 0–100% slider on each section row. After `evalPixel` returns `{r,g,b}`, multiply by `strip.brightness`. A paused section at 0% is visually off; a dimmed section at 30% becomes ambient fill.

**Why now:** Single multiply in the render callback. `strip.brightness` slot is ready (the strip object takes arbitrary fields already). One slider in `renderStripsList`, two lines in `_tick`.

**Effort:** ~45 min

---

### A2. Master brightness
**What:** Global brightness slider in the header, same pattern as master speed. Final RGB gets multiplied by `masterBrightness` before the canvas draws it. Essential for fade-to-black between scenes without touching patterns.

**Why now:** Zero architectural work — just a number in state applied at the end of the render callback.

**Effort:** ~20 min

---

### A3. Per-section hue shift
**What:** A −180° to +180° number input on each section row. After `evalPixel`, convert RGB→HSV, rotate H by `strip.hueShift`, convert back. Run the same "fire" pattern on every section but offset each section by 30° and suddenly the installation has a warm-to-cool sweep without any extra code.

**Why now:** One small `rgbToHsv` / `hsvToRgb` utility function (8 lines), one rotation in the render callback. The hard part (stripId routing) already exists.

**Effort:** ~1 hour

---

### A4. Per-section direction reversal
**What:** A ⇄ toggle on each section row. When `strip.reversed = true`, reverse the pixel array after `samplePath()` so index 0 is at the far end of the path. Critical for physically wired installations where two mirrored sections run in opposite directions — otherwise a "chase" effect would appear to chase toward the center on both sides instead of outward.

**Why now:** One `strip.pixels.reverse()` call after sampling, one boolean in the strip object, one button in the row.

**Effort:** ~30 min

---

## Tier B — Easy  (half to full day each)

### B1. Color palette system
**What:** Six named color swatches shown below the pattern editor. Patterns reference them as `palette[0]` through `palette[5]`. Change a swatch and every pattern using it updates immediately — no code edit required.

**Technical path:** Add `palette` as a 7th argument to `compile()` / `evalPixel()` in `patterns.js`. Inject the current `state.palette` array in the `_tick` render callback. The palette is stored as `[{r,g,b}, ...]` and converted to hex for the color picker UI. Recompile is not needed on palette change — the live value is passed at eval time.

**Why it matters:** Lets you define the installation's color language once (brand colors, seasonal palette, mood) and change it globally in seconds during setup or performance.

**Effort:** ~3 hours

---

### B2. BPM tap tempo + `beat` variable in patterns
**What:** A **Tap** button in the header. Tap it repeatedly in time with music; the tool computes BPM from the interval between taps. Patterns gain two new variables: `beat` (0→1 sawtooth that resets on each beat) and `beatSin` (sine of beat, 0→1). Pattern example: `return hsv(x, 1, beatSin)` pulses brightness on every beat.

**Technical path:** Store `state.bpm` and the timestamp of the last beat start. In `_tick`, compute `beat = fract((globalT - beatStart) / (60 / bpm))`. Add `beat` and `beatSin` as two more args to `compile()` and pass them in the render callback. A tap averager (rolling median of last 4 intervals) keeps the BPM stable.

**Effort:** ~4 hours

---

### B3. Scene presets
**What:** Named snapshots of the entire look: master speed, master brightness, palette, and per-section overrides (speed, brightness, hueShift, visible). Save with a name, recall by clicking. Stored in the project JSON automatically.

**Why it matters:** Designs a library of looks (`Opening`, `Ambient`, `Climax`, `Fade Out`) that can be called up during a show or handed to a venue tech.

**Technical path:** `state.scenes = []`. Save = snapshot current state into the array. Recall = apply snapshot values to `state` and re-render. Scene selector is a simple `<select>` in the Pattern tab or a new "Scenes" tab. Per-strip overrides match by strip ID.

**Effort:** ~4 hours

---

### B4. Pattern `params` — per-pattern knobs without code edits
**What:** Patterns declare named parameters at the top:

```js
// @param speed  float  default=1.0  min=0.1  max=5.0
// @param hue    float  default=0.0  min=0.0  max=1.0
return hsv(fract(x + time * params.speed + params.hue), 1, 1);
```

The editor parses the `@param` comments and generates live sliders in the UI. No recompile on slider change — values are passed at eval time like the palette.

**Why it matters:** The gap between "pattern coder" and "installation operator" collapses. An operator can tune a commissioned pattern without touching code.

**Effort:** ~5 hours (comment parser + slider generation + state)

---

## Tier C — Medium  (1–3 days each)

### C1. Per-section pattern assignment
**What:** Each section gets its own pattern dropdown. Defaults to a "global" pattern but can be overridden independently. Left arch runs Fire, center runs Plasma, base runs a slow static warm glow — all simultaneously.

**Technical path:** The hard wiring is already done — `stripId` flows into the render callback, and `state.stripTimes` already makes time per-strip. The remaining work: store `strip.patternId` (null = use global), maintain `state.compiledFns = new Map(stripId → fn)`, look up the right fn in the render callback, add a compact pattern dropdown to each section row.

**This is the single highest-value feature on the list.** Every other Tier B item becomes 10× more useful once sections can run different patterns.

**Effort:** ~1 day

---

### C2. Live WLED push over network
**What:** IP address input + Connect button in the header. On connect, posts `ledmap.json` to the device. During animation, streams the current frame's pixel colors to WLED in real time via its JSON API — what you see in the browser preview is exactly what the hardware shows, with no export/upload cycle.

**Technical path:** WLED exposes `POST /json/state` with `{"seg":[{"col":[[r,g,b],...]}]}`. The render callback already produces per-pixel RGB — after computing a frame, format it into WLED's segment payload and POST it. Rate-limit to ~25 fps (WLED's practical ceiling over WiFi) using a separate interval. The `ledmap.json` upload stays a one-time step after layout changes.

**Caveats:** Requires CORS or a same-origin proxy (a small script on the Raspberry Pi) since browsers block cross-origin requests. The Pi is already planned as the bridge.

**Effort:** ~1.5 days (including Pi proxy script)

---

### C3. Section groups / zones
**What:** Logical grouping of sections. Create a group ("Left Side", "Perimeter", "Focal Point"), assign sections to it. Group-level controls (speed, brightness, pattern) override individual settings. Collapsible group header rows in the section list.

**Why it matters:** A 20-section installation becomes manageable in three zone groups.

**Effort:** ~2 days (new state layer + group UI)

---

## Tier D — Complex  (1+ week each)

### D1. Scene crossfade transitions
**What:** When switching between presets, instead of a hard cut, the output lerps between two compiled pattern outputs over a configurable duration. Transition types: dissolve (linear RGB blend), wipe (sections transition with a spatial offset), cascade (sections stagger their transitions left→right by physical position).

**Technical path:** Run two `compiledFn` evaluations per pixel during the transition window, lerp by progress. Requires a transition state machine and running both functions simultaneously — roughly doubles CPU cost during transitions.

**Effort:** ~3 days

---

### D2. Timeline / show sequencer
**What:** A horizontal timeline where scenes are placed on a track. Press play and the installation runs the choreographed sequence. Exports as a standalone playback JSON that the Raspberry Pi can execute without a browser.

**Effort:** ~2 weeks (new UI component + playback engine)

---

### D3. Spatial effect bus
**What:** A second effect layer defined in the artwork's global 2D coordinate space — independent of which pattern each section runs. A sweep of white light that crosses the whole installation is defined once and composited on top of all sections. Essential for making a multi-section installation feel like one unified piece.

**Effort:** ~1 week (new render pass + compositing)

---

## Recommended build order

```
A3 hue shift
A4 direction
A1 brightness (section)
A2 brightness (master)
B1 palette
B2 BPM / beat
B3 scene presets
B4 pattern params
C1 per-section pattern   ← biggest unlock
C2 live WLED push        ← closes hardware loop
C3 groups/zones
D1 scene transitions
D2 timeline
D3 spatial bus
```
