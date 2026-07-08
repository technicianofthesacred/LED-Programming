# Diagnosis: Why the current 7 mandala effects fall short

*Analyst: Opus. Grounded in the built simulator (`led-art-mapper/mandala-sim/index.html`) + the mapping spec + the ember-breath recipe. Owner's two complaints: "not diverse enough" and "some spin too fast." Both true for concrete reasons. This is the input to the new-direction design.*

## 1. Diversity — the effects are more alike than the table claims
- **Visual grammar collapses to ~2.5 ideas.** Of 7: EQ/Bloom/Ripple are the radial-bullseye grammar; Spiral/Interference are rotating-angular; Temperature is still; Journey is a remix of the others (zero new geometry). Bloom ≡ Ripple at the kernel level — both are `clamp(1 − |rf − R|/w)` around a moving radius. It feels like ~2.5 things, not 7.
- **One palette = a hard diversity ceiling.** All 675 pixels in all 7 effects use one coal→amber→gold ramp. `temp[]` is only a ±small nudge on the *same* ramp. Effects can differ only in *how brightness moves*, never in color. Every effect is amber.
- **Most effects are secretly bass-driven.** Bloom, Ripple, and Interference all fire their visible event on bass/kick. On a drum track three effects light up in sync with each other and the beat — switching effects doesn't switch what the piece responds to.
- **Angular structure is `sin(k·ang + phase)` in every case, only k changes** (k ∈ 3,6,8,9,12). The entire shape vocabulary is one sinusoid at different petal counts. Petal-6 vs petal-8 is far subtler than the promised "spectrum vs flower vs wavefront vs star."

## 2. Speed — only two effects are actually too fast (with numbers)
- **Spiral is the primary offender.** `theta += dt*(0.4 + 2.6*midEnv)`. At mid=0.5 → 1.7 rad/s = a revolution every 3.7s; with 3 arms an arm sweeps a fixed point every **1.2s**. At mid=1.0 → every **0.7s**. That's 10–25× faster than the piece's own stated rest rotation (recipe budgets 45–60s periods). Unclamped 2.6 rad/s of headroom.
- **Ripple sweep is fast.** `r += dt*0.9` → center-to-rim in **1.1s**, up to 3 concurrent fronts on a 120BPM track. Busy pulsing, not meditative bloom.
- **Interference doesn't spin too fast, it snaps too hard.** `C = 0.3 + 0.7*bassEnv` on a 60ms attack — violates the recipe's "nothing ever snaps" north-star.
- **Everything else is calm** — EQ scallop (2.1s, low depth), Temperature drift (26s, subliminal), Bloom rotation (15.7s), Journey clock (90s). Fix surface is small: Spiral speed + Ripple sweep.
- **Root:** the audio-mapping spec threw out the recipe's rotation budget and let audio drive rotation from ~0 to multiple rev/s with no meditative ceiling.

## 3. Deeper root cause — collapsed degrees of freedom
The system is "one palette + one geometry (concentric rings) + motion variations." A mandala can differ on ~6 axes; the design meaningfully varies **one**:

| Axis | Used? |
|---|---|
| Symmetry order (k-fold) | Partially — but always the same `sin(k·ang)` form |
| Motion type (radial / angular / pulse-in-place / still) | Collapsed to radial + angular + still |
| Color temperature zones | **Unused** — one ramp, all amber |
| Density / sparseness | **Unused** — every effect lights ~all 675 px every frame |
| Edge quality (sharp vs soft) | **Collapsed to soft** — renderer halos everything in `lighter` blend |
| Rhythmic time-scale | **Collapsed** — mostly bass transients (~60ms); only Temperature differs |

Five of six knobs are glued. Genuine "different instruments" comes from moving the collapsed axes: an effect that's **sparse** where others are full; **crisp-edged** where others glow; **cooler/deeper** in the ramp where others are gold; responds to **sustained energy over 2s** where others snap on 60ms. Petal-count is the weakest differentiator and the only one in use.

## 4. What to keep
- **Keep as-is:** Concentric EQ (the only true multi-band effect — the spectrum IS the mandala; a flagship) and Temperature Field (the correctly-meditative one, honors the recipe).
- **Keep, fix speed:** Orbiting Spiral — good idea, only needs its `0.4 + 2.6*midEnv` speed law clamped.
- **Keep one of Bloom/Ripple:** they're the same kernel. Keep **Bloom** (embodies "bass opens a flower"); cut or repurpose **Ripple**'s slot for a collapsed-axis effect.
- **Reconsider Interference:** soften the snap and/or move its trigger off bass so it stops firing in unison with Bloom.
- **Journey:** keep as a *mode*, not counted toward diversity — it's only as diverse as the effects it blends.

**One line:** varies only petal-count while gluing color/density/edge/rhythm, so EQ/Bloom/Ripple/Interference are 3.5 restatements of "warm bullseye pulses on the beat"; spins too fast in exactly two places (Spiral, Ripple). Keep EQ + Temperature, slow Spiral, keep one of Bloom/Ripple, spend freed slots on the collapsed axes.
