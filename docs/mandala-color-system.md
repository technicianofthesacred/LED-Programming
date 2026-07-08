# Lightweaver — Color System Specification

*Color director: Fable. Three-zone warm palette for the sound-reactive mandala. All values PRE-gamma 8-bit RGB (gamma 2.2 + 75% ceiling applied downstream). Linear interpolation in pre-gamma space. No color decisions remain open.*

## 0. Unifying idea
Three paths through ONE hue corridor: HSV 18°–42°, never outside. G/R rises 0.31→0.93, B/R rises 0.06→0.80; each ramp a monotonic walk up. **Hearth** hugs the saturated lower edge (fire), **Patina** the desaturated middle (metal), **Candlelight** the pale upper edge (light). The three dim floors are within a few RGB points; the three tops nearly converge — so any cross-fade stays in-family. One bronze object under three lights. Light reflects off warm wood (eats ~¼ of blue) — Patina/Candlelight carry slightly more blue than looks right on a monitor; judge on the piece, not on screen.

## 1. The three palettes

### HEARTH — the fireplace (saturated fire; the only fiery one)
| Intensity | R | G | B |
|---|---|---|---|
| 0.00 | 32 | 10 | 2 |
| 0.18 | 120 | 38 | 8 |
| 0.40 | 190 | 84 | 22 |
| 0.62 | 228 | 138 | 56 |
| 0.82 | 248 | 190 | 96 |
| 1.00 | 255 | 224 | 168 |
Amber stop B=56 (green-guard fix). Top B/R 0.66 = sunlight not white. Dark stays ≥69% sat below amber (red-dark, never brown).

### PATINA — the metal (desaturated antique bronze)
| Intensity | R | G | B |
|---|---|---|---|
| 0.00 | 30 | 16 | 8 |
| 0.20 | 92 | 56 | 26 |
| 0.42 | 150 | 102 | 48 |
| 0.65 | 198 | 148 | 76 |
| 0.85 | 232 | 192 | 120 |
| 1.00 | 250 | 226 | 178 |
B/R 0.27–0.38 through lower half (~4× Hearth) greys gold to antique metal. Every dark stop sat ≥0.68, B/G ≥0.46 → dark metal not dead brown. Top = parchment, never white.

### CANDLELIGHT — the light itself (palest, warm-white, never clinical)
| Intensity | R | G | B |
|---|---|---|---|
| 0.00 | 34 | 20 | 10 |
| 0.20 | 96 | 66 | 38 |
| 0.45 | 168 | 128 | 84 |
| 0.70 | 222 | 184 | 134 |
| 0.88 | 246 | 218 | 172 |
| 1.00 | 255 | 238 | 204 |
Value climbs steeply (minimal dwell in muddy mids). Top B capped 0.80×R (~2850K tungsten) — no blend reaches neutral white. R leads B by ≥20%R everywhere (charcoal 34 vs 10) → smoky ivory not putty.

## 2. Warmth-with-brightness law (incandescent)
Dim = low color temp (deep, red, saturated); bright = paler but still warm, capped ~2900K. Brightness never buys blue past the cap. Checkable guardrails (assert on every stop AND every blended pixel):
1. **B ≤ G ≤ R** always (blue smallest, red largest).
2. **B ≤ 0.55×R for intensity <0.65; B ≤ 0.80×R everywhere** (R−B ≥ 20%R always = permanent warmth margin).
3. **G/R and B/R monotonically non-decreasing with intensity** within each ramp (dimming makes redder, never greyer).
Corollary: constraints are linear in RGB → any linear blend of two compliant colors is automatically compliant. Cross-palette blending can't break the law.

## 3. How modes use the zones
**(a) Spectrum (Strata) — 5 rings bass→treble inside→out:** rings 1–2 (bass) → Hearth; ring 3 (mid) → Patina; rings 4–5 (treble) → Candlelight. Bass=heat at the core, treble=light at the rim; also the rim's oblique wood-reflection muddies saturated color, and pale Candlelight survives there. Each boundary ring blends 25% of its neighbor's ramp (same-intensity lerp) — one graded object, not five bands.
**(b) "Warms toward Candlelight as it crests":** blend outputs not intensities — `color = lerp(Hearth(i), Candlelight(i), w)`, w = crest amount, smoothstep-eased, **cap w ≤ 0.85** (never fully leaves Hearth). Same recipe for any two-zone mode.
**(c) Dim floor — never dead, never glow-worm:** while a mode runs, never idle at (0,0,0) (true black = OFF state only). Minimum = each palette's 0.00 anchor exactly: Hearth (32,10,2), Patina (30,16,8), Candlelight (34,20,10). Post-gamma these land at 2–3 LSB red — a faint living-coal field, invisible across the room, alive up close. Don't raise them; above ~(4,2,1) post-gamma reads as a nightlight.

## 4. Anti-cheap checklist (check every stop + rendered frame)
1. **Muddy grey-brown lowlights:** where max(RGB)<140 pre-gamma, saturation ≥0.55. Dark must be *colored* dark.
2. **Green-tinted amber:** where G ≥0.60×R, require B ≥0.40×G. (Why Hearth amber B=56.)
3. **Harsh white clip:** B ≤0.80×R no exceptions; tops ≤(255,238,204); effects may only *scale* ramp output ≤1.0, never additively boost channels.
4. **Dead black / dull nightlight at idle:** floor per 3(c) — the 0.00 anchor exactly; never (0,0,0) running, never above (4,2,1) post-gamma.
5. **Banding on slow fades:** temporal dithering ON (FastLED built-in); no fade crosses bottom 15% of a ramp without it.
Master check: **every output pixel's hue stays inside 18°–42° HSV** — blends, drafts, future AI patterns all clamp into that corridor before reaching a pixel. Nothing blue/green/purple/pink/neutral ever leaves this object.
