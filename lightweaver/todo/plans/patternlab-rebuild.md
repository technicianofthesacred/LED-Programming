# Pattern Lab rebuild — from spec machine to instrument

_Plan for the artist-facing rebuild of the Pattern Lab. Written 2026-08-20 from three
combined audits (fake controls, broken loops, lossy handoff, cognitive overload), all
findings verified against source and a live browser session._

---

## 1. The diagnosis

**Pattern Lab was built spec-first instead of feedback-first: it grew a rich recipe
language and a compatibility calculus before the loop from finger → light was ever made
to work, so most of what Adrian touches changes a document, not the light.**

Everything else in the audits is a symptom of that one inversion. Two of six headline
sliders are placebos; the palette reaches 2 of 130 patterns; 7 of 11 macros are computed
and consumed by nothing; the seed is never randomized and the renderer ignores it; the
preview force-pauses to black at exactly the moment of choice; and the payoff button is
six gestures deep inside a diagnostics accordion. A tool for play must close the loop
touch → see → feel → keep in under a second, every time, honestly. This one never closes
it once.

## 2. The design principle

**No control ships unless it is wired end-to-end and its effect is visible within one
frame of touching it.** Concretely: a slider may appear on screen only if moving it
provably changes the pixels in the mapped preview, and the mapped preview is provably
the same engine that streams to the card and bakes recordings — so seeing it *is* the
truth. Anything that cannot meet that bar is deleted, not explained. The corollary is a
hard budget: the first screen shows **one preview, one pattern browser, three sliders,
and one keep button** — everything else is progressive disclosure, and every disclosed
control obeys the same wiring rule. Honesty is enforced structurally, not by
documentation: the card badge on each pattern is derived from the same descriptor the
handoff uses, so the UI cannot promise what the piece won't play.

## 3. Repair or rebuild? **Rebuild the surface. Keep the engine.**

Gut-and-rebuild the artist-facing screen on top of the parts that verifiably work. Not
a hedge — the split is clean in the code:

**The engine is good and stays** (verified in source this session):

- `lib/patterns-library.js` — 130 built-in patterns as JS snippets, and critically they
  carry **real `@param` annotations** (`// @param scale float 3.0 1.0 10.0` on fire,
  `dotSize` on chase, etc.). This is an honest, per-pattern control surface that already
  reaches the renderer and is currently *unused by the Lab UI*. It is the replacement
  for the fake macro sliders.
- The worker renderer + mapped-preview canvas (renders on real strip geometry, glow
  bloom on mobile) — keep, but fix its lifecycle (§7 Phase 1).
- "Preview on Lights" live streaming at 18 fps to a connected card — keep; it becomes
  the *primary* honesty mechanism, promoted from buried feature to headline button.
- Draft persistence (`patternLabStorage` + backup) — keep, add names/delete/undo.
- The LWSEQ bake (`lwseqBake.js`) — keep as the "recording" path, reframed (§6).
- The handoff/compatibility libraries (`patternLabHandoff.js`,
  `patternLabCompatibility.js`) — keep as plumbing; their *outputs* get translated to
  plain language and their *inputs* get simplified because the recipe shrinks.
- The card's native scalar contract — verified in firmware
  (`LightweaverPatterns.cpp`): patternId + brightness + speed + hueShift + customHue +
  customSaturation, over the ~30-pattern `cardPatternBank`. This is the real native
  surface and the new UI is shaped around it instead of hiding it.

**The surface is unsalvageable as a repair target.** `PatternLabScreen.jsx` is 1,202
lines orchestrating six numbered sections (with no 05), ~55 controls of which the
majority are inert, a state model where changing the base pattern silently wipes
everything, and a force-pause on every selection. Repairing in place means preserving
the information architecture that *is* the problem. The new screen
(`PatternPlayScreen`) is small precisely because most of what the old one renders is
being deleted.

## 4. What gets deleted

Delete, not hide, not flag off:

1. **Shape and Texture sliders** — placebos; they touch only preview dot size/glow.
2. **The macro readout panel** — 7 of 11 computed macro values are consumed by nothing.
   The 4 real ones survive as internal plumbing only.
3. **Seed + "variations" UI** (`PatternLabVariants.jsx`) — seed defaults to 1, is never
   randomized, and the stateless renderer explicitly ignores it; the four variant
   thumbnails differ only by evolution phase and each spawns its own churning worker.
4. **`PatternLabExperimental.jsx` + `lib/patternLabExperimental.js` + its 581-line
   test** — imported by nothing. Dead code, ~1,100 lines.
5. **The layers UI** (`PatternLabLayers.jsx`) — the card supports only 'normal' blend,
   so adding a layer with the default 'screen' blend silently disqualifies the design
   from native playback in one click. Layering returns only if/when it can be honest
   (Phase 4 decision point, likely never for native).
6. **The 6-swatch palette editor** — reaches 2 of 130 patterns; the 5 generators
   discard it for a hardcoded rainbow. Color control becomes the honest native pair
   (hue + saturation, which firmware actually applies to every pattern) plus real
   `@param` knobs where a pattern declares them.
7. **The numbered 01/02/03/04/06 section chrome**, the icon-only 4-button toolbar
   (whose 4th step focuses a disabled button), and the collapsed "Card compatibility &
   diagnostics" `<details>` as the home of the payoff action.
8. **The flat 140-option `<select>`** with its five duplicate labels (Lava Lamp,
   Neon Sign, Digital Rain, Meteor Shower, Watercolor Wash — dedupe the registry).
9. **Engine jargon from the artist column**: "Operations / frame", "State memory",
   "Framebuffer", "LWSEQ", "Diffusion U", "Kill", "Cell rule", "Studio only",
   "Baked sequence". The diagnostics panel keeps them — behind a "Nerd stats" toggle —
   because it is accurate and occasionally needed.
10. **The evolution editor as a primary section** — it survives only as the single
    "Drift" toggle (Phase 3), because picking any evolution today silently forces
    bake-only.

Estimated net deletion: ~2,500–3,000 lines of surface + dead code before the new screen
is counted.

## 5. The new experience — one screen, phone-first

Working name: **Pattern Play** (route replaces the Lab in nav; old screen remains
reachable at its hash for one release behind a "classic" link, then dies).

### First open

The screen opens **already playing**. No empty state, no choose-first: the project's
current pattern (or `aurora` if none) is live on the full-height mapped preview of the
actual piece geometry the moment the screen mounts. The preview **never pauses itself**
— not on pattern choice, not on draft open, ever. Play/pause is a user control only.

### Layout (phone portrait)

```
┌─────────────────────────────┐
│                             │
│   MAPPED PREVIEW            │  ← the artwork, always live, always lit,
│   (fills the screen,        │    top ~55% of viewport. Tap toggles
│    real strip geometry)     │    play/pause. Never inert.
│                             │
├─────────────────────────────┤
│ ● Aurora      [♥ Keep] [⋯]  │  ← current pattern name (tappable → browser),
├─────────────────────────────┤    Keep = save named draft, ⋯ = more
│  Speed     ─────●────       │
│  Bright    ───●──────       │  ← the three honest sliders. Live on
│  Color     ──────●───       │    every frame. This peek strip is
├─────────────────────────────┤    ~35% tall; preview stays visible
│  ▶ PLAY ON LIGHTS           │    and touchable behind nothing.
└─────────────────────────────┘
```

The controls live in a **bottom sheet with three detents** (peek / half / full), not
the current fixed-82% drawer that sets the preview `inert`. At peek and half, the
preview above remains visible and live — you watch the art while you drag the slider.
That single change is the mobile fix. (Also in this pass: kill the 36 px horizontal
overflow inside the scroll container, the overlapping status-bar text, the unstyled
checkbox, and the black thumbnails — all cosmetic once the sheet exists.)

### The pattern browser

Swiping the sheet to full (or tapping the pattern name) reveals the browser: a
**scrolling grid of tiles**, each with its existing CSS-gradient preview (already in
the library data — free, instant, no worker), the pattern's name, and a **badge**:

- **⚡ "Plays on the piece"** — the ~30 patterns in the card's native bank.
- **📱 "Streams from Studio"** — everything else (plays live while your phone/browser
  is connected, or via a recording).

A search field at the top (the screen's first-ever text input) filters by name. Two
shelf rows above the grid: **"On the piece"** (the native 30, first) and **"Recent"**.
Tapping a tile switches the live preview *immediately, while still playing* — browsing
is playing. Long-press a tile → full-screen live audition. Custom/AI patterns appear as
their own shelf and are **selectable without crashing** (the current uncaught
RangeError on custom-pattern selection is fixed by routing them through the same
adapter path as built-ins, with a graceful "this one can't render" tile state instead
of a screen crash).

### The three sliders — and why exactly these

**Speed**, **Brightness**, **Color** (hue wheel thumb; saturation as a sub-control on
tap). These are precisely the card's native modifier set, verified in firmware. They
are honest three ways at once: they visibly change the preview every frame, they are
what "Play on Lights" streams, and they are what the piece plays natively after
handoff — zero translation loss for any native pattern. The fake generality of
Movement/Shape/Texture is replaced by real specificity:

### Per-pattern knobs (Phase 2)

When the selected pattern's source declares `@param` lines, they render as **up to
three extra sliders with the pattern's own names** ("Flame height", "Dot size",
"Density" — labels from a small curation pass over the annotations). These genuinely
reach the JS engine today; the Lab just never exposed them. A pattern with no params
shows none — the control panel is as honest about absence as presence. Any non-default
knob value moves the design from ⚡ to 📱 (shown live on the badge, with the plain
sentence "custom settings stream from Studio or a recording — reset to play natively").

### Keep, name, undo

- **Keep** saves a draft and — first text input, second use — lets you name it. Saves
  no longer silently overwrite by id; "Keep" on a changed draft offers "Save as new /
  Replace '<name>'". Drafts list gets swipe-to-delete (storage already supports
  delete; it just has no UI).
- **Undo**: switching patterns no longer wipes settings silently. A single-level
  snapshot before every pattern switch and draft open powers an "Undo" toast
  ("Switched to Plasma — Undo"). Not a history stack; one level is enough to make
  exploration safe.
- **Export** gets a completion toast ("Saved pattern-aurora.json to Downloads") and a
  failure message; currently silent both ways.

### What "play" feels like

Open screen → art is already alive → thumb the Speed slider and watch the piece
respond → flick through tiles like a paint-chip wall, each one taking over the live
preview mid-motion → hit "Play on Lights" and the actual wall piece follows your
thumb in real time → "Keep" it with a name. Ten seconds to the first felt result,
zero concepts to learn before the first one.

## 6. The honesty contract

The problem: the card natively accepts 6 scalars over 30 patterns; the lossless path
is a 30–90-minute bake; today the gap is papered over with silent downgrades and
"unknown → Studio only" walls. The rebuilt contract:

**1. One badge, always visible, never a wall.** Every design is in exactly one of
three states, shown as a plain sentence next to the Keep button, computed live from
the same compatibility library the handoff uses (so the UI cannot drift from reality):

- **"Plays on the piece as-is."** Native pattern, native scalars only. Handoff is
  lossless *by construction* because the UI only offered native controls.
- **"Streams live from Studio."** Anything beyond the native set. Truthfully: it plays
  right now via Play on Lights, and keeps playing while a browser is connected.
- **"Can be recorded to the piece (~N min)."** The bake, renamed **"Record to
  piece"** — framed as what it is: rendering a video of light for the card to replay.
  Real estimated minutes from the existing estimator, never "unknown": when a metric
  can't be proven the sentence says "recording is the sure path" instead of a
  Studio-only verdict. Recording runs with a visible progress bar and a "keep this tab
  open" notice; it is a deliberate act like an export, not a compatibility punishment.

**2. No silent disqualification.** Any interaction that would change the badge changes
it *visibly at the moment of the interaction* (the badge animates), with one tap to
see why and one tap to revert. The current failure — one click quietly making a design
bake-only — becomes structurally impossible because the badge is the state.

**3. WYSIWYG by shared engine.** Preview frames, streamed frames, and baked frames all
come from the same worker renderer. There is no second "card approximation" render
path to drift. For native patterns the preview applies exactly the six scalars the
firmware applies — the preview adapter is constrained to the firmware's modifier
semantics (hue shift, saturation scale, speed time-scale) so the phone shows what the
C++ will do.

**4. Errors tell the truth.** The three failure causes currently collapsed into an
eternal "Preparing accurate preview…" (no geometry / watchdog timeout / worker error)
each get their own one-line message and a Retry button; the real error string moves
from a DOM attribute to the screen.

## 7. Phases

### Phase 1 — Make it alive (1 day, shippable alone)

The day's goal: the existing screen stops lying and stops going black, before any new
screen exists. Every item is independently verifiable in a browser.

1. **Never pause**: remove all three `setPlaying(false)` calls (choose-pattern,
   open-draft, pick-variant). Selection keeps playing.
2. **One persistent worker**: stop terminate-and-respawn on overlapping renders; keep
   the worker alive, queue/coalesce render requests, raise the watchdog so a slow
   frame degrades instead of executing the worker. Kill the four variant-thumbnail
   workers by deleting the variants panel (item 4). Verifiable: worker script fetched
   once per session, not 100+ times in 6 minutes; the generators stop being reset (they
   won't fully "live" until Phase 4's step-cap fix, but they stop being murdered).
3. **Delete the placebos and the dead**: Shape + Texture sliders, macro readout, seed
   variants panel, Experimental screen + lib + test, palette editor, layers section.
4. **Honest failure states**: three distinct error messages + Retry replace the
   eternal "Preparing accurate preview…"; custom-pattern selection stops crashing the
   screen (guard + graceful tile state).
5. **Tile browser v1**: replace the 140-option `<select>` with the searchable badge
   tile grid using the existing CSS previews; dedupe the five duplicate registry
   labels. "On the piece" shelf first.
6. **Surface the payoff**: "Use in Project" moves out of the diagnostics accordion to
   a primary button next to Keep, with the three-sentence badge (v1: computed from the
   existing classifier, reworded; "unknown" rewritten to "recording is the sure path").
7. **Export feedback** toast (success + failure).

Outcome: same route, radically smaller screen, nothing on it is fake, nothing goes
black, choosing patterns feels like flipping through a lightbox. This alone answers
"I can't play."

### Phase 2 — Make it an instrument (~2 days)

- New **Pattern Play** layout proper: full-bleed live preview + three-detent bottom
  sheet (preview never `inert`); fix the container overflow, status-bar overlap,
  checkbox, thumbnails.
- **Per-pattern knobs** from `@param` annotations, with a label curation pass over the
  library; live badge transitions on knob touch.
- **Naming, save-as-new vs replace, draft delete UI, one-level undo** with toast.
- **Play on Lights** promoted to the headline button with connected-card state.

Outcome: the tool has real, honest depth per pattern, and exploring is safe
(undo) and keepable (names). "Tangible designs" now exist as named things.

### Phase 3 — Make the handoff honest end-to-end (~2 days)

- **Record to piece** flow: renamed, real minutes up front, progress bar, done/failed
  states, resulting recording visible in the project with its size.
- Handoff hardening: the recipe shrinks to what the UI can actually set (native
  scalars + per-pattern params + pattern id), so the "collapse to 6 scalars" loss
  class disappears — native designs round-trip exactly; parameterized designs are
  recorded or streamed, stated plainly.
- **Drift toggle** (the one evolution survivor): a single "slowly drift colors" switch
  that maps to the firmware's native drift modifier where possible (honest ⚡) and
  otherwise moves the badge to recording — visibly.
- Diagnostics panel behind "Nerd stats"; keep the good "Why is this dark?" explainer
  one tap from the brightness slider.

Outcome: what leaves the screen is exactly what the piece plays, and Adrian can read
which of the three truths applies without decoding a budget table.

### Phase 4 — Living patterns (~3 days, optional, do only if Phases 1–3 land well)

- Fix generator state lifetime (persistent worker from Phase 1 makes this possible)
  and remove the 64-step sim clamp so cellular-field and gray-scott actually evolve
  past 8 seconds; ship the 5 generators as a "Living" shelf, honestly badged
  📱/record-only.
- Decide layers' fate for real: either a two-layer mode that is *only* offered when it
  can record (never pretending native), or formally drop layering from the product.

Outcome: the "living simulations" live, or are honestly buried.

## 8. Deliberately not doing

- **Not extending the firmware's native parameter set** (e.g. teaching the card
  per-pattern params or extra blend modes). That's a firmware release lane with its
  own risk; the streaming + recording paths make it unnecessary for the tool to feel
  honest. Revisit only if recorded patterns start dominating and card storage becomes
  the pinch.
- **Not building a Web Worker security sandbox** for pattern eval — explicitly parked
  in THINKING 2026-06-16; the synchronous per-pixel API makes it a rewrite, and the
  existing hardening stands.
- **Not keeping the seed/variations system in any form.** A variations feature is only
  worth rebuilding on top of a renderer that actually consumes a seed; that's engine
  work with no current pull.
- **Not making the bake faster** (WASM/OffscreenCanvas parallelism). Real work, real
  win, but the reframing ("Record to piece", honest minutes, progress) removes the
  pain of surprise; speed can come later if recording becomes the dominant path.
- **Not customer-facing pattern authoring** — THINKING 2026-05-28 already rejected it;
  this tool is the artist's instrument.
- **Not multi-preset "scene" management or cloud pattern catalog** — same THINKING
  entry; the sale shape hasn't changed.
- **Not preserving old recipes' full fidelity on migration.** Existing drafts load
  with their pattern + native scalars + any `@param`-expressible values; layered/
  evolved drafts open with a one-time "this draft used features that were removed —
  here's the closest honest version" notice. Carrying the dead schema forward would
  re-import the complexity this plan exists to delete.

---

_Verification bar for every phase: the fast UI loop from memory — browser first,
grepped Playwright second, full gate once — plus one new spec per phase asserting the
honesty contract (no `setPlaying(false)` on selection; worker fetched once; badge
changes on knob touch; overflow check run **inside** the scroll container, since the
document-level check provably misses it)._
