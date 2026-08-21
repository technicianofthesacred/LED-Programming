# Lightweaver music-responsive system — build plan

*The executable plan. Direction and rejected alternatives live in [music-reactive-plan.md](music-reactive-plan.md). Four planning passes over the real source: workflow/UI, layout+symmetry, vector import, rendering+audio. Every file path below was read, not assumed.*

**Recommended build ≈ 94 hours**, then iterate the controls in front of a real piece. The remaining ~50 hours of authoring polish is listed at the end as what comes after, and is deliberately not committed to up front.

---

## 0. What we are actually building, and what we are not

**The owner has already made multi-area sound-adjacent mandala effects in Madrix that people liked.** He liked Madrix's authoring model. Two things were wrong with it: it is a separate program that must be running on a computer in the room, and **he never got into its audio response at all.**

That aims this whole plan:

- **Do not innovate on region authoring.** Madrix's mental model — map the physical piece once, then give each named area its own effect — already works for him. Our named groups are the same idea. Borrow, don't reinvent.
- **But fix Madrix's real failure: it never shows you your piece.** His words: *"Not actually knowing what pieces are where. It just being a grid of LED dots and not relating to what I'm actually building at all."* Studio already draws over the real artwork, and that is the single largest advantage this system has. **Every screen in this plan must show his mandala, never an abstract grid.** Where a design choice trades artwork fidelity for convenience, artwork wins.
- **Spend the design budget on the audio response.** This is genuinely new territory for him, and it is the source of *"I have no idea how to get it working."* Madrix hides its audio behind a few sliders on a black box; that is the part worth beating.
- **In-house is the pitch.** No second program, no laptop in the room, runs off the card on the wall.

Three places we beat Madrix outright: **you see your actual piece** rather than a grid of dots; **declaring six-fold once** instead of hand-mapping every region; and **one dial staggering the six copies** instead of offsetting each by hand. Madrix cannot do the last at all without dropping into its scripting language.

---

## 1. The model, in one paragraph

The piece declares one base symmetry — a kaleidoscope of N sides, with a centre and a rotation. Inside one wedge the owner names **motifs**: lotus flower, bee, sun ray, circle spots. The symmetry gives each motif N copies. Each motif carries its own **fold**, dividing N, setting how many independent instances those copies form — the lotus at 6 ripples copy to copy, the outer spot ring at 1 breathes as one body, on the same piece at the same moment. Each motif becomes a **voice**: a character, a band it listens to, a depth, and for multi-instance motifs a spread and direction. Under it all sits the **ground**, a dim coal field keeping the piece one organism. A saved arrangement is a **Program**.

---

## 2. A bug found while planning — independent of everything else

**SVG artwork import ignores `transform` attributes, and silently drops `<use>` elements.**

`measureLayers` in `lightweaver/src/lib/layoutGeometry.js` (~:300) calls `shapeToD(el)`, which reads raw geometry attributes only. Any `<g transform="rotate(60)">` — *the normal way a vector editor builds a six-fold mandala* — imports at wrong coordinates. And `querySelectorAll('path, rect, …')` never matches `<use>`, so a mandala drawn as one wedge plus five `<use>` clones imports as **one sixth of the artwork, five wedges missing, no warning.**

Any artwork already imported is probably wrong. Fix regardless of which plan version proceeds.

Related, lower urgency: raw unsanitized `svgText` is stored in state and written into every `.lw.json` (`ProjectContext.jsx:882`) while used only as a truthiness flag — untrusted markup persisted for no rendering benefit.

---

## 3. The rule that decides whether this is fun

Everything below is held to one rule, and it is the rule that kills tedium in tools like this:

> **Nothing opens a dialog. Nothing needs saving before you see it. Every control changes the wall while the music is still playing. Hold a chip and it plays; let go and it's chosen.**

Where a design choice conflicts with that rule, the rule wins.

---

## 4. The recommended build

### Phase A — Import hardening · ~13h · independent, do regardless
Fixes §2. New `lightweaver/src/lib/svgFlatten.js`: transform composition, `<use>` expansion with a cycle guard, primitives→path, rigid-matrix arc handling with bézier subdivision as fallback. Port the finished sanitizer from `led-art-mapper/app/src/project-format.js:482-545` into `svgSanitize.js` — **do not write a new one, do not add DOMPurify**. Rework `measureLayers` to preserve element ids and `data-name`, so an Illustrator shape called "lotus" arrives called Lotus and re-import can rebind by name. Stop persisting raw `svgText`.

### Phase B — Shared audio source · ~2h · own PR, first
`setAudioBands` (`ProjectContext.jsx:587`) is never called, so `bass`/`mid`/`hi` in the pattern editor always evaluate to 0. Extract the audio source out of Show (`lw-show.jsx:510-633`) into `showAudioSource.js` so Show and Pattern Lab share one instance. Do this **before** the engine work — it touches the same file heavily and would otherwise conflict.

### Phase C — Engine de-risking · ~10h · no visible change
Lift shared math from `mandalaEngine.js` into `mandalaMath.js`. Range-refactor the nine existing effect functions from whole-piece loops to `(ctx, area, from, to, out)`. Then the safety net: **a parity test asserting all nine modes render byte-identical frames before and after.** Gate — must be green before Phase D.

### Phase D — The ensemble engine · ~26h · the part with no substitute
- `showAreaBinding.js` — precomputed pixel masks, **sorted by instance so phase is computed once per run, not per pixel**; mirroring baked into the geometry so no character function contains a mirror branch.
- `showEnsemble.js` — ground pass, voice loop, instance phase, soft clip with a knee at 0.75 so the authored look below it is untouched.
- `showCharacters.js` — Swell, Twinkle, Ripple, Glow, Trace. Each **derived from existing tuned math** (Tide, the Sparkle spec, Radial Ripple, Hearth, Procession respectively), not invented.
- `showComposition.js` — schema, resolve, graceful degradation.

**Build the full data shape here, even though Phase E's interface is minimal.** The record carries piece-level symmetry, per-motif fold, instance order and mirror from day one. The shape is cheap; the screens are expensive. This is what makes the later phases additive rather than a migration.

**Critically: symmetry is stored at piece level, never on the group.** Four motifs share one six-fold. Storing fold on the group would force migrating every saved project later.

### Phase E — The kaleidoscope screen · ~18h
Draw gains a **Symmetry** mode. Artwork and strips recede to 40%; three controls appear: a **centre handle** (on phone riding 60px above the fingertip on a stem, so the finger never hides it), a **fold stepper** (1·2·3·4·5·6·8·12), and a **rotation ring**.

**Ghost echoes are the whole idea.** Whatever fold is selected, his *real drawn strips* from one wedge render rotated into every other wedge as faint amber. Right fold: ghosts land on his actual strips and the canvas snaps — doubled lines collapse into single bright ones. Wrong fold: the canvas shimmers with misaligned doubles, like a badly focused lens. **He focuses a kaleidoscope until the image resolves, rather than reading a number.**

Plus **"Test it"** — one soft pulse travels once around the piece, wedge to wedge, on screen and on the wall. Six wedges, six distinct footfalls. A limping or skipping pulse means the fold is wrong. Ten seconds, no reading.

### Phase F — Symmetry detection from the vector · ~9h
`artworkSymmetry.js`: shape signatures, area-weighted centre with grid refinement, per-fold rotational scoring on centroid distance, radius, path length and area — length-weighted so large shapes count more than dust. **Prefers the largest fold within 0.02 of the best score**, because six-fold art also scores well at two and three; without this it reports 2.

Because the vector is mathematically exact where hand-drawn strips carry tremor, this is reliable in a way strip-matching never is. It presents one card — *"This artwork repeats 6 times around a centre here"* — with ghosts already aligned. **Even a confident detection is a proposal; the confirm tap is always his.** Non-symmetric artwork returns ranked near-misses and never silently picks.

Pure and unit-testable with an injected sampler.

### Phase G — Minimal control surface · ~10h · then iterate weekly
Voice cards over the existing lasso-and-G groups: character chips, band chips (**each carrying its own live meter, so choosing a band means watching four small flames and picking the one dancing right**), a fat depth slider, a spread dial with direction, and a fold number typed by hand. Hold-to-audition on every chip. Solo dims others to 20% rather than muting, so the soloed motif is judged in context.

**Then stop planning and start using it.** The interface is where the remaining risk lives, and it gets resolved by a week of real use, not another document.

### Phase H — Tests · ~6h
Unit specs carry the load-bearing assertions — they are auto-collected by `test:unit`, which **is** in CI. The most valuable single test: run every character with the band pinned at 0, then at 1, and assert the authored clock advances identically. **That is the locked aesthetic enforced by machine rather than by discipline.** The Playwright analyser fixture also needs upgrading from its current uniform ramp, which makes bass, mid and high read identically and so cannot test per-band behaviour at all.

---

## 5. What comes after, once a week of real use says which hurts most

Listed, costed, **not committed**. The order should be decided by what actually annoys him.

- **Motif tagging with the confirmation sweep** (~22h) — one wedge lit, five dimmed; lasso, name, and the five copies light in sequence around the piece so a wrong guess is where his eye already is. Fix by dragging the wrong glow onto the right strips. No dialogs.
- **Motifs from artwork** (~18h) — clicking the actual lotus in his own vector to define a motif, rather than lassoing the strips behind it. This is the deepest expression of *"relate to what I'm actually building"*, and clicking artwork shapes already half works today. Motifs defined by artwork shapes with strip membership derived, since re-drawing a strip must not destroy a motif.
- **The sentence paragraph** (~10h) — the return-after-months surface, where each bold word is the control. **Deliberately last.** It reads beautifully in a document and may be fussy in the hand; it earns its place only if returning to old Programs actually proves confusing.
- **A default starting arrangement** (~2h) — three voices sorted by distance from centre, so compose opens with something to edit rather than a blank page. Optional, and it partly duplicates the nine existing modes, which already provide a zero-setup path.

---

## 6. Constraints that shape all of it

**No firmware changes in any phase above.** Frame count, cadence (18fps), the 4096-byte chunk cap and the 850ms keepalive are unchanged; the ensemble alters pixel values only. The composition record is deliberately shaped so it can later compile down to card zones.

**The 12-area × 6-stretch ceiling.** A ×6 motif consumes exactly 6 — right at the limit. If any single copy spans two separate wired runs it overflows. **The budget check already runs on every edit today and is thrown away**; surfacing it costs little. Warn at authoring time in piece language, never `ERR: AREA_LIMIT`.

**Two different centres.** Symmetry centre is in artwork coordinates; the render pipeline renormalizes to a strip bounding-box centre. On an asymmetric piece these differ, and wedges will visibly disagree between Draw and Show unless converted explicitly. Highest-risk shared surface in the plan.

**Sub-strip spans are deferred.** Splitting a strip in two already works and rewires the chain correctly, so "half this strip belongs to the bee" is served today with one extra strip row and no new concepts.

**Derive phases from the layout, never the render template** — the template skips hidden strips, so hiding one arm would renumber all six.

**One `mode` voice per composition.** The nine existing effects own module-scoped mutable state; two simultaneous mode voices would need that state moved per-voice. Enforce the restriction, don't do the refactor.

---

## 7. Deliberately not built

A timeline or keyframe sequencer — the piece responds, it does not perform a script. A node graph or patch-cord view — worst return-after-a-month comprehension of any tool studied. A sixth character — five is the palette; adding one requires deleting one. Colour controls of any kind — the moment a hue wheel appears, every Program becomes a colour decision and the aesthetic dies. Per-pixel editing in the music workflow. BPM detection or beat grids. Numeric readouts on musical controls — halos, motion and adverbs, because numbers invite optimizing the number instead of the wall. Program folders, tags and search. Drag-to-snap strips onto artwork paths — "add this path as a strip" already exists and does the same job.

---

**The build in one breath:** fix the import bug so his vector lands true, prove the nine modes still render identically, build the engine that lets each named area listen to its own sound and stagger its own copies, give him a kaleidoscope screen he focuses like a lens on his own artwork — then put a rough panel on it and change that panel every week until it is fun.
