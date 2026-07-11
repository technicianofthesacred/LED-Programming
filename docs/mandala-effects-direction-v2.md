# Lightweaver Mandala — Effect Set Direction v2

*Design direction aligned to the built Show spatial-audio engine. Diagnosis by Opus (`mandala-effects-diagnosis.md`). Governing aesthetic: high-end listening gallery, not festival.*

## 1. North star

A quiet companion to listening, not a performance. Reference: firelight and patina — embers, candle-flame, sun crawling across brass. Music breathes *through* the whole piece; nothing performs at you. Test: could two people hold a conversation in front of it for an hour and still be glad it is on the wall?

Every mode therefore has two simultaneous readings:

- a distinctive foreground gesture — a ring, spark, arm, petal, tide, or spectral structure;
- a gentle whole-piece musical substrate, spatially phased so a beat propagates through the geometry instead of flashing every pixel uniformly.

Sparse and local describe the foreground, never a dead output region. Every ring, strip, and connected-layout region remains faintly alive. In silence the piece settles over seconds to its dim living-coal character; it does not go black or freeze.

## 2. Diversity strategy — vary instruments, not petal counts

Each effect owns a different combination of six axes:

- **Color-temperature zone:** one bronze object under three lights, all inside amber–cream (1800–3200K, no hue ever leaves it). **Hearth** (coal→ember→amber→gold→sun-gold), **Patina** (bronze→aged brass→antique gold→parchment), **Candlelight** (charcoal→smoke-amber→candle-white→ivory).
- **Foreground density:** full fields, broad structures, one-ring gestures, and sparse sparks may coexist in the library. Sparse foregrounds sit over a quiet living field; darkness remains the canvas without making a layer inert.
- **Edge:** one effect can read as a crisp machined-brass rim while the others use deliberately softer edges.
- **Authored motion clock:** the modes range from near-still through minute-scale drift to clearly visible, watchable motion. This clock belongs to the authored effect and is not accelerated by audio.
- **Musical articulation:** stable bass/mid/high energy, broadband energy, centroid, flux, and a beat envelope shape amplitude, position, breadth, probability, and texture. Every mode receives a restrained whole-piece beat substrate.
- **Symmetry and geometry:** perfect radial, low-order arms, and non-symmetric texture remain distinct on the Mandala, while the same fields are evaluated at the actual samples of a connected layout.

## 3. The nine modes

The foreground identities remain deliberately different. “Full-field” below describes the authored foreground; every row also includes the shared whole-piece substrate.

| # | Effect | Zone | Foreground | Authored motion | Musical articulation |
|---|---|---|---|---|---|
| 1 | Meridian | Patina | one crisp ring + quiet echoes | slow positional migration | centroid position, local band amplitude |
| 2 | Hearth | Hearth | full fire field | slow drift | long energy mood + localized bass warmth |
| 3 | Embers | Hearth on dark | sparse sparks + low shimmer | stochastic lifetimes | energy/treble texture set births and intensity |
| 4 | Strata | all three by radius | full spectral field | near-static scallop | continuous bass→mid→high radial interpolation |
| 5 | Tide | Hearth→Candlelight | broad radial swell | visible center→edge travel | bass controls reach and crest |
| 6 | Lattice | Hearth | full six-fold star | 30s precession | energy, bass contrast, and beat-defined nodes |
| 7 | Procession | Patina | broad 2–3 arm field | 60s revolution | mids/broadband shape brightness and breadth |
| 8 | Bloom | Hearth | full eight-petal flower | eased radial opening | bass opens the flower; energy leaves a soft trail |
| 9 | Spiral | Patina→Hearth | broad three-arm field | 15s revolution | mids/broadband amplitude + beat travel along arms |

- **Meridian** is the minimal solo-listening effect: one precise ring selected by spectral centroid, with neighboring echoes and the shared substrate keeping the rest of the piece alive.
- **Hearth** combines a slow energy trend with a localized live bass swell. The beat is felt as warmth moving through a fire, not a flash laid over it.
- **Embers** keeps sparse sparks as the foreground identity while a very low, textured field and the shared substrate preserve whole-piece life.
- **Strata** makes the spectrum architectural. Stable logarithmic RMS bands interpolate continuously from bass at the center through mids to highs at the edge; radial palette zones remain Hearth→Patina→Candlelight.
- **Tide** sends a broad, lobed bass swell across the complete normalized radius, including the outermost samples. The crest warms from Hearth toward Candlelight.
- **Lattice** is the six-fold sacred-pattern mode. Energy sets the whole-star level, bass shapes contrast, and the beat articulates spatial nodes without snapping.
- **Procession** turns broad aged-brass arms at its authored minute-scale rate. Audio changes their brightness and breadth, never their revolution speed.
- **Bloom** opens an eight-petal flower with eased bass articulation and leaves a soft trail through the full radius. It is Tide’s livelier, more locally articulated cousin.
- **Spiral** turns authored arms at a watchable middle speed. Audio strengthens the arms and sends visible texture along them; it does not change the 15-second rotation period.

## 3b. What “livelier” means

The library order runs from minimal to most active, but “livelier” does not mean faster beat flashes. Lattice, Procession, Bloom, and Spiral are the livelier tier because musical articulation is stronger and spatial propagation is easier to see. Their foreground motion may also be more visible, but authored rotation speed remains independent from audio.

At the lively end:

- a beat produces a measurable, non-uniform change across the geometry;
- energy can deepen contrast, widen a path, open a flower, or send texture along an arm;
- propagation remains eased and spatially phased;
- no beat produces a uniform full-piece flash, hard cut, strobe, or palette excursion.

## 4. Spatial-audio contract and restraint rules

1. **Every layer remains alive.** Repeated beats move at least most of the Calm field and reach every Mandala ring; Active reaches still more. Sparse/local geometry is foreground only.
2. **The substrate is shared but not uniform.** Calm adds a restrained beat depth of `0.08`; Active uses `0.14`. Radius, angle, strip index, strip progress, and normalized x/y position phase the response so motion visibly propagates.
3. **Analysis must stay stable.** The Show analyzer uses logarithmic-frequency RMS bands (bass 30–140 Hz, mid 150–1800 Hz, high 2000–9000 Hz), stable adaptive floor/headroom, broadband energy, centroid, positive spectral flux, and a decaying beat envelope. Sustained music must not normalize itself away; silence must not invent beats.
4. **Audio changes expression, not authored rotation speed.** It may modulate amplitude, probability, position, contrast, breadth, and texture. Procession, Lattice, and Spiral keep their authored motion periods.
5. **Use the real layout.** The Mandala evaluates its 675 exported ring samples. Connected mode evaluates the visible connected-layout pixels in stable strip/output order, using aspect-preserving normalized x/y, radius, angle, strip index, and strip progress. Effects must reach the layout’s actual outer radius rather than assuming a flat five-ring frame.
6. **No strobing.** Feature and per-pixel envelopes ease attack and decay; the beat substrate lifts existing light and travels through space instead of replacing a frame with a flash.
7. **Warmth remains absolute.** Hue never leaves the Hearth/Patina/Candlelight amber–cream corridor. The `B ≤ G ≤ R` warmth law, incandescent brightening, and palette ramps remain governed by `mandala-color-system.md`.
8. **Brightness remains bounded.** Calm uses a `0.75` master and Active `0.82`, both below the engine’s hard `0.85` master cap. Greater activity still reads as warmer light gaining articulation, never full-saturation full-brightness festival output.
9. **Silence stays beautiful.** On music stop, presence decays over roughly eight seconds to a dim mode-compatible coal field. Never black, never frozen.

## 5. Presets — Calm and Active

Calm is the piece’s baseline: `1.0×` effect modulation, `0.08` shared beat depth, `0.75` master, standard release scaling, standard ember rate, and standard Tide crest.

Active listens more closely: `1.5×` effect modulation, `0.14` shared beat depth, `0.82` master, `0.7×` release scaling, `2×` ember rate, and `1.35×` Tide crest. It does not change authored rotation speed. Its stronger response must remain spatially propagated and non-strobing.

Ceiling test: at most active, the result reads as a fire fed another log — more articulate and visibly traveling through the object, never a light show switched on.

## 6. The library, slow → lively

1. **Meridian** — one crisp ring with living echoes
2. **Hearth** — fireplace warmth over a long energy mood
3. **Embers** — sparks over a low whole-piece shimmer
4. **Strata** — the spectrum read continuously through radius *(flagship)*
5. **Tide** — a broad breath from center to the actual outer edge
6. **Lattice** — a six-fold star with beat-articulated nodes
7. **Procession** — brass arms, one authored slow turn per minute
8. **Bloom** — an eight-petal flower opening with the bass
9. **Spiral** — authored arms with the strongest visible musical travel

This set preserves distinct foreground instruments while making the whole installation respond as one connected object. The difference between modes now comes from what leads the composition; whole-piece life is a permanent invariant.
