# Lightweaver Mandala — Effect Set Direction v2

*Design director: Fable. Diagnosis by Opus (`mandala-effects-diagnosis.md`). Governing aesthetic: high-end listening gallery, NOT festival. For owner approval BEFORE code. On sign-off, next artifact is the implementation spec (per-effect tables, palette hex ramps, smoothing constants).*

## 1. North star
A quiet companion to listening, not a performance. Reference: firelight and patina — embers, candle-flame, sun crawling across brass. Music breathes *through* the mandala; nothing performs at you. Test: could two people hold a conversation in front of it for an hour and still be glad it's on the wall?

## 2. Diversity strategy — vary instruments, not petal counts
Each effect owns a different combination of six axes:
- **Color-temperature zones (unlock, carefully):** one bronze object under three lights, all inside amber–cream (1800–3200K, no hue ever leaves it). **Hearth** (coal→ember→amber→gold→sun-gold), **Patina** (bronze→aged brass→antique gold→parchment; the Rothko-dark end), **Candlelight** (charcoal→smoke-amber→candle-white→ivory; light itself, not fire).
- **Density (unlock hard):** two effects must be sparse (<10% lit, darkness as canvas). Absence of black is why everything currently blurs together.
- **Edge (unlock):** one effect crisp (machined brass rim); the rest soft-by-choice.
- **Rhythmic time-scale (most important):** each effect listens on a different clock. At most ONE effect relates to individual musical events, heavily slewed. Kills the "four effects fire on bass" problem.
- **Motion type:** radial-static / radial-flow / rotational / stochastic / positional / near-still — no two share.
- **Symmetry:** perfect radial → low-order arms → none. Petal count stops being an identity.

## 3. The new set — six effects
Verdicts: EQ + Temperature kept/refined (flagships). Bloom+Ripple merged→Tide. Spiral kept, slowed 40×. Interference retired (its snap violates "nothing snaps"; its good idea absorbed into Procession).

| # | Effect | Zone | Density | Edge | Clock | Motion | Symmetry |
|---|---|---|---|---|---|---|---|
| 1 | Strata (EQ) | all three by ring | full | soft | seconds | radial-static | perfect radial |
| 2 | Hearth (Temp) | Hearth | full | soft | minutes | field drift | none |
| 3 | Embers | Hearth on black | sparse 3–8% | point | texture | stochastic | none |
| 4 | Meridian | Patina | ~1 ring | crisp | tens of sec | positional | perfect radial |
| 5 | Procession | Patina | medium | soft-med | tens of sec | rotational | 2–3 arms |
| 6 | Tide | Hearth→Candlelight | full low-contrast | soft | seconds→tens | radial-flow | perfect radial |

- **1. Strata** *(EQ flagship)* — spectrum made architectural; bass center → highs rim. Slowed ballistics (attack ~300ms, release 2–4s). Each ring at a different palette point (ember-core → ivory-rim). Only effect with a seconds-clock; spends it on envelope not events. No rotation.
- **2. Hearth** *(Temp flagship)* — fireplace; overall temperature integrates energy over 60–120s. Drift field evolves 20–40s. Hears the record, not the bar. Gets the minutes-clock exclusively.
- **3. Embers** *(new, owns sparse)* — darkness with 20–50 living embers; each ignites coal-red, breathes up, dies over 4–10s. High/centroid raise ignition *probability* only — never brightness of existing embers. First dark pointillist look. ~50-struct array.
- **4. Meridian** *(new, owns crisp)* — one thin precisely-lit ring at a time, machined-brass. Centroid chooses which ring; migrates by slow crossfade over 10–20s. The late-night solo-listening effect.
- **5. Procession** *(Spiral, slowed)* — 2–3 broad aged-brass arms, one revolution per 60–90s (sun-across-wall). Sustained mid (30s-smoothed) modulates arm brightness/breadth only; **audio never touches rotation**. Arms on different radii-weightings create slow emergent moiré (Interference's idea, no snap).
- **6. Tide** *(Bloom+Ripple merged)* — not a beat wavefront but a breathing; low-band energy over 5–10s feeds a swell traveling center→rim over 10–15s (was 1.1s), Hearth-gold core → candle-ivory rim as it crests. Only effect with radial travel; travels at the pace of a slow exhale.

## 3b. Livelier tier — three revived modes (owner request: don't overcorrect to only-calm)
The six above are the meditative tier. The owner wants *several modes* spanning slow→lively, all still gallery-grade (warm, never harsh, never strobing). These three revive the visually-striking looks from the old set, retuned to the restraint rules — they are the "more alive, still sophisticated" end of the library. Distinct from Procession/Tide by having more visible motion, but bounded by the lively-tier band in §4.

| # | Effect | Zone | Density | Edge | Clock | Motion | Symmetry |
|---|---|---|---|---|---|---|---|
| 7 | Bloom | Hearth | full | soft | seconds | radial-flow | 8 petals |
| 8 | Spiral | Patina→Hearth | medium | soft | seconds | rotational | 2–3 arms |
| 9 | Lattice | Hearth | full | soft-med | tens of sec | rotational | 6-fold star |

- **7. Bloom** *(revived flower — the livelier cousin of Tide)* — an 8-petalled flower that opens outward and draws back in with the bass, faster and more articulate than Tide's slow swell. Petal edges visible; opening cycle ~3–6s (not Tide's 10–15s). Still eased, never snapping. This is "the flower is dancing" vs Tide's "the tide is breathing" — same family, different tempo, so both earn a slot.
- **8. Spiral** *(gallery-grade spiral — the middle speed the old one never had)* — 2–3 arms rotating at **one revolution per 12–20s** (vs the old ~2–4s and Procession's 60–90s). Alive and turning, clearly in motion, but slow enough to watch a single arm travel. Mid energy modulates arm brightness/breadth; rotation speed is authored and constant per the "audio never touches velocity" rule — the liveliness is in the *visible turning*, not in reactivity. Warmer Hearth arms (vs Procession's cooler Patina) so it reads as the more active sibling.
- **9. Lattice** *(revived 6-fold star — Interference without the snap)* — the beautiful six-petal standing star, kept for its shape, but the bass no longer *snaps* it hard. Instead node contrast rises and falls on a slow eased envelope (attack ~400ms, release ~2.5s) so the star *breathes* between soft-glow and defined-star over seconds, and a slow node precession turns it over ~20–30s. Bass raises contrast amplitude, never triggers a hard transition. The geometric, symmetric, "sacred pattern" mode.

## 4. Restraint rules (guardrails — cannot be violated)
1. Nothing completes a revolution under 45s. Radial traversal ≥8s. Positional migration crossfade ≥10s.
2. Nothing snaps: min attack 250ms, min release 2s, ease-in-out curves, on every audio-driven parameter.
3. Audio modulates amplitude/probability/position — **never velocity**. Motion speed is authored, constant, slow.
4. One events-adjacent effect maximum (Strata). All others listen to windows ≥5s.
5. Brightness ceiling ~75% of hardware max; brighter means paler (desaturate toward ivory). Full-saturation full-brightness is the festival tell — banned.
6. Change budget: ≤~15% of total field luminance may change per second in full-field effects.
7. Silence must be beautiful: on music stop, decay over ~10s to a dim idle of each effect's character. Never black, never frozen.
8. Hue never leaves amber–cream. Three zones are the entire color universe.

**Lively-tier band (rules 1–4 relax, but only within these limits — the livelier modes 7–9 may NOT become festival):**
- Rotation: livelier modes may turn as fast as **one revolution per 12s** (Spiral) — never faster. Still authored/constant; audio never changes speed.
- Radial travel: Bloom's flower may cycle as fast as **3s** open-to-close (vs the ≥8s meditative floor), still eased.
- Transient response: a livelier mode may respond over a **1–3s** window (vs ≥5s meditative), but the "nothing snaps" attack floor (250ms) and the brightness/paleness ceiling (rule 5) still hold absolutely.
- The festival line stays hard: no rotation under 12s, no snapping ever, no full-saturation full-brightness, no per-beat strobing. Ceiling test unchanged — a fire fed another log, never a light show.

All nine remain per-pixel arithmetic + a few smoothed scalars — inside ESP32 budget. Embers adds one ~50-element array.

## The library, slow → lively (what the mode switcher shows)
1. **Meridian** — a single crisp ring, drifting over a whole song (most minimal)
2. **Hearth** — fireplace warmth over minutes
3. **Embers** — sparks on darkness
4. **Strata** — the spectrum read in the rings *(flagship)*
5. **Tide** — a slow breath, center to rim
6. **Lattice** — a six-fold star breathing between soft and defined
7. **Procession** — brass arms, one slow turn per minute
8. **Bloom** — an 8-petal flower opening with the bass
9. **Spiral** — arms turning at a watchable middle speed (most active)

## 5. Presets — what "active" means in a gallery
Calm is the piece's true self. Active means it *listens more closely*, not faster: deepen modulation ~1.5×, shorten releases toward (never below) 2s, raise Embers ignition ~2×, let Tide crest more fully. Active may NOT touch rotation/traversal speed, lower the attack floor, add per-beat triggering, or exceed the brightness ceiling. Ceiling test: at most active, reads as a fire fed another log — never a light show switched on. If a guest calls active mode "reactive," we overshot.

## 6. What this fixes
- **Not diverse enough:** six effects each own a distinct axis-row — spectrum architecture, fireplace, sparks on darkness, single machined rim, brass clockwork, breathing tide. Three palette zones, two dark/sparse looks, one crisp, four clocks. Bloom/Ripple duplicate gone.
- **Too fast:** Spiral → 60–90s revolutions; Ripple → Tide's 10–15s swell; the deeper cause (four effects on 60ms bass attack) structurally eliminated (only Strata keeps a seconds-clock, slewed). Rules 1–4 make it permanent.
- **Gallery framing:** the mandala can now be *mostly dark*, which makes the moments of gold precious.
