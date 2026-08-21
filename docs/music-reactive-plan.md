# Lightweaver sound-responsiveness — decision memo

*Adrian asked for the model before the build. Four source surveys of the existing system + three web research passes (music-software modulation UX; seven pro visual tools; the LED platform ecosystem). Direction: Fable. This supersedes two earlier drafts — "Ring Voices" and the five-word Place/Repeat/Gesture/Listen/Ripple set. Both are treated below as candidates, and one loses.*

---

## The two findings that reframe everything

**Every serious tool separates "what the music does" from "what the light does", and the best ones connect the two with a single gesture, not a graph.** This held across TouchDesigner, Notch, Resolume, MadMapper, Madrix, VDMX, vvvv, Bitwig, Ableton, VCV and hardware synths. No tool collapses band-selection and response-shaping into one control.

**Nobody has solved returning to a composition a month later.** Not Bitwig, not Ableton, not TouchDesigner. Bitwig's own fan literature concedes "understanding existing modulation is time-consuming". Ableton users report forgotten mappings and mystery-modified parameters. Node graphs test worst of all — TouchDesigner's own forum runs a thread titled *"Less Spaghetti, More Flow"* about wires obscuring logic. Adrian named "durable" as the requirement, so this is genuine white space we have to design deliberately, not inherit.

---

## 1. The fork — three real architectures

### A. The Modulation Desk
*"The music turns the knobs on my existing effects."*

Keep the nine finished whole-piece modes. Add Bitwig-style modulators: tap "Lows", drag the effect's Intensity knob, a coloured ring shows depth and live swing.

Cheap — days, not weeks. Delightful to use, ten minutes to learn. **But one shared field means the centre circles and the outer ring can never do different things.** It is *more* basic than the ring-by-ring model Adrian already rejected. Loses on capability.

### B. The Ensemble  ← **recommended**
*"Each named area of the mandala is a voice, and the voices play the music together."*

Lasso-named groups become first-class in Show. Each area gets a **voice**: a character, one band it listens to, and how deeply it answers. Centre circles are a voice. Outer ring is a voice. A ×6 repeating section is one voice with six instances.

This is MadMapper's "each surface owns its reactive material" and LedFx's "one effect scaled across regions" — both proven — built on grouping machinery that already exists and already compiles to card zones.

Medium cost. The real work is structural: Show currently renders one field from one engine, and must run several small engines masked to areas.

**It says exactly what he said.** And decisively, a voice is a small declarative record — area, character, band, depth, spread — which is the only one of the three that can ever compile down to something the card runs alone.

### C. The Field Stack
*"Layers of light-weather wash over the piece, and areas are masks in the stack."*

TouchDesigner's model. The most expressive by a wide margin — cross-area waves come free.

The cost is not the code, it is the interface: a stack with masks and modulations is a node graph wearing a trench coat, and graphs test worst-in-class on exactly the durability requirement he set. **It fails the three-month test to buy power he'd use rarely.** Suits a VJ who patches weekly, not a maker of wall pieces who returns seasonally.

### Recommendation: **B, with one piece of C grafted on — Voices over a Ground**

The Ensemble, plus a single always-present base layer: the existing dim living-coal field, gently modulated by overall energy, under every voice. **The ground solves the Ensemble's one real weakness** — without it, independent voices drift into looking like a patchwork of gadgets. With it, everything sits on one warm breathing surface and the piece reads as one organism.

And we lift exactly one trick from C — per-instance phase offset (§3) — the only part with proven precedent. We take TouchDesigner's best idea without taking its interface.

**A locked-aesthetic rule, independently confirmed.** Every pro tool distinguishes the envelope follower (reactive) from the LFO (self-clocked), and best practice is the envelope driving the LFO's *amplitude*. The music controls how big the breathing is, never how fast. That is precisely the existing rule in `mandala-effects-direction-v2.md` — discovered independently by the whole industry. It should be **enforced by the model's shape**: there is simply no control that lets a band touch a clock.

---

## 2. Durability — the screen he sees in three months

The research is unambiguous that the authoring gesture and the reviewing surface must be **different things**. Bitwig's gesture is beloved and Bitwig users still cannot read their own patches back.

**Opening a composition shows the mandala and a paragraph.** His drawing, each voiced area softly tinted, and beneath it one plain auto-generated sentence per voice, always current:

> *The centre circles **twinkle** with the **highs**, **brightly**.*
> *The outer ring **swells** with the **lows**, **deeply**, breathing slow.*
> *The six petals **ripple outward** on the **hits**, **gently**.*
> *Underneath, the whole piece glows like coals, rising a little with the music.*

The entire composition, readable in ten seconds, in the language he used when he asked for it. No matrix, no wires, no percentages.

**And the sentence is also the editor.** Each bold word is a control. Tap "highs" and it cycles lows/mids/highs/hits. Tap "twinkle" and a character picker opens. Tap "gently" and you are in the depth drag. Touch a sentence, its area glows on the drawing; touch an area, its sentence highlights. Two views of one fact, never out of sync.

This is supported by HCI work on natural-language forms — UI fields embedded in a sentence match users' mental models better than label-plus-input — and it is essentially unbuilt in any mainstream tool.

For **feel-time** authoring, with music playing, the Bitwig gesture layers on top: hold a source chip, drag the destination control, and a warm ring around *that control* shows both configured depth and live swing. The research verdict is explicit — depth belongs on the destination, never on wires, because N rings draw nothing extra between them while N wires cross everything.

**The test: he could read the paragraph aloud to someone and they would know what the piece does.**

---

## 3. The ×N repeat, resolved

TouchDesigner's index→phase-offset is the only proven precedent found — Madrix, Resolume, MadMapper, WLED, Pixelblaze and LedFx all require manual per-copy duplication and staggering.

**Declaring it.** After naming the first section ("Petal"), he taps each sibling on the drawing and confirms. Studio orders the instances automatically by angle around the centre — it already computes per-pixel angle. The badge reads **Petals ×6**. One declaration, forever.

**Feeling it.** The voice gets one extra control: the **Ripple dial**, 0 to full. At zero all six petals move as one — a bass hit is a unison bloom. Turn it up *while music plays* and the instances' phases fan apart, so the same hit becomes a wave travelling petal to petal around the mandala. While dragging, six small marks on an arc above the dial spread apart so the stagger is visible; the piece itself is the real feedback. A direction toggle — clockwise, counter, or centre-out — completes it.

Underneath this is exactly TouchDesigner's index-times-constant offset into one shared audio-driven envelope. In his hands it is one dial he turns until the wave feels right.

**No consumer LED platform has this. It is the signature feature.**

---

## 4. On-card audio — the verdict changed

**Standalone listening is now realistic. The earlier "probably never" is withdrawn.**

Two facts changed it. The firmware's second core is confirmed idle — no task pinning exists anywhere in the source. And WLED has proven the exact architecture in production: audio sampling and FFT pinned to core 0 as their own FreeRTOS task, rendering and WiFi on core 1, never contending.

The CPU math is a non-issue. A 512-point FFT is hundreds of microseconds; WLED's ~21-23ms cycle is mostly *waiting on the microphone's DMA*, not computing. ~45Hz audio updates comfortably outruns an 18fps stream.

**What it actually takes:** a hardware revision. The S3 has no mic and accepts I2S/PDM digital mics only — so a mic on the card, reserved pins, a board rev — plus a core-0 audio task.

**What is lost, honestly:** MEMS mics are audibly worse than line-level analysis; WLED's stock reactive effects are widely called "blinky"; and mic config is boot-time only, so changing audio settings needs a physical reset. The existing browser analyser — adaptive floor, auto-gain, spectral flux, centroid — is genuinely better than what the card will hear. The card should get a simplified, tasteful version, not a port.

**Alternatives weighed.** Pixelblaze's separate audio-coprocessor PCB is the cleanest architecture found, but it is a second board, second firmware, second supply chain — over-engineering when the S3 can host the task. Parked. WLED's UDP audio-sync, where follower cards disable their own mics and one device analyses for the whole install, is the right answer *the day an installation has multiple cards*. Note it, build nothing.

**The strategic point that decides the sequence.** The endgame for a wall piece in someone's home *is* standalone listening — nobody keeps a phone streaming pixels at 18fps forever. **The Ensemble is what makes that endgame reachable**, because a voice compiles to a record the card can execute: a zone (already produced from his groups), a character, a band index, a depth, a spread. A code-based or stack-based composition never compiles to a few hundred bytes. An ensemble does.

**And there is a graceful middle step needing no hardware:** the card runs the composition and the phone is *just the microphone*, streaming a few bytes of band levels at 45Hz instead of thousands of pixels. The piece survives WiFi hiccups, the browser does the good analysis, the card does the rendering.

**Position in sequence: last.** Prove the model in the browser, where a change ships in ten minutes rather than a signed thirty-minute release.

---

## 5. The minimum lovable version

Before any UI is built, validate the *look* with zero interface.

On one real piece on the bench: wire the existing analyser into Show and hard-code his own quote as two voices plus one ripple — **centre circles twinkle with the highs; outer ring swells with the bass; one ×N group rippling on the hits, spread set by a temporary dial.** Use the existing named groups. Play music at it for an evening.

Small, because the analyser, the geometry and the groups all exist — it is the first multi-engine render in Show plus three fixed behaviours.

**If that evening makes him say "this is it", the Ensemble is validated and everything after is interface.** If it doesn't, we have spent days rather than weeks, and we know *which part* felt wrong — the voices, the characters, or the ripple — before any architecture hardened around it.

---

## 6. Sequence

1. **Bench demo** — hard-coded two voices + ripple dial on a real piece. *Decision gate.*
2. **Voices in Show** — areas from named groups; four or five characters (Swell, Twinkle, Ripple, Glow — deliberately few, each pre-shaped with fast-attack/slow-release smoothing that keeps the locked aesthetic; more verbs only when one is genuinely missed); band choice; hold-and-drag depth with the destination ring.
3. **The sentence screen** — tinted drawing plus editable paragraph, saved compositions. **Ships *with* step 2, not after — durability is a requirement, not polish.**
4. **Repeat groups** — sibling-tagging flow and the Ripple dial as first-class.
5. **Card executes, phone listens** — firmware zones accept a live per-band level; Studio streams band levels instead of pixels. First taste of standalone operation, no hardware change. *(firmware, signed release)*
6. **Card listens** — mic hardware rev, core-0 audio task, simplified on-card analysis. Only after compositions already compile and run on-card. *(hardware + firmware)*

---

## 7. Rejected, with reasons on record

- **Node graphs, cables, or a layer/mask stack as the authoring surface** — worst-in-class durability across every tool studied; fails the three-month test he set as the bar.
- **A modulation matrix as the editing surface** — the research is blunt that matrices only work read-only. The sentence paragraph *is* our read-only summary, and it is better.
- **Free-code audio patterns as the main path** — the per-pixel editor stays as an expert escape hatch, and finally gets real bass/mid/hi fed to it. The AI assistant should learn to emit *voices*, not code. An artist's primary surface is never a text box.
- **BPM / beat tracking** — stays rejected. The onset envelope gives "hits" without the festival look.
- **Fine-grained 16 or 32-band mapping** — lows/mids/highs/hits is the whole vocabulary. More bands is spectrum-analyser thinking, and the piece must never be a spectrum.
- **Audio touching any clock or rotation speed** — enforced by the model's shape, not by discipline.
- **Audio-coprocessor PCB and UDP multi-card sync** — right ideas at a different scale. Parked until multiple cards ship in one installation.
- **Per-pixel region painting** — strip-level tagging matches how the pieces are physically wired.
- **Extending kaleidoscope into the repeat primitive** — it mirrors within one strip and is bound to a single zone; forcing it to span scattered strips fights both its Studio validation and its firmware lookup table.

---

**One line:** the piece is an ensemble — the ground hums, each area he has named is a voice, the music only ever changes how deeply each voice breathes, one dial turns any repeat into a travelling wave, and the whole composition is always readable back as four plain sentences on top of his own drawing.

**Build the bench demo first. It will tell us in one evening whether this is the model worth committing to.**
