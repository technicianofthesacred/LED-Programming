# Wiring & Sizing UI Redesign — Plan

**Status:** Proposal (mockup: `docs/mockups/wiring-redesign-mockup.html`)
**Scope:** `lightweaver/` Studio — Wire mode (`WireModePanel.jsx` + `wire/` sub-components) and Size mode (`SizeModePanel.jsx`), plus the orphaned power calculator in `src-v3/components/DevicesPanel.jsx`.

## Why

The current commissioning stepper works (the underlying state machines — `stepStates` in `WireModePanel.jsx` and `wiringChaseReducer` in `wiringChase.js` — are solid), but the presentation fights the user:

- Five always-visible accordion steps compete for attention; the eye has no single place to land.
- Status is encoded in mono uppercase pills (`COMPLETE`, `NEXT`, `WAITING`, `OPTIONAL`) that read like machine states, not guidance.
- Step 4's "visible from here" checkbox renders as an unexplained white square; the gate it controls ("Start physical LED check" disabled) isn't visually connected to it.
- "LED color order · GRB / Check colors" assumes the user knows what a color order is.
- Sizing is split across two surfaces: strip counts/density in Size mode, power math in a legacy `src-v3` panel nobody can reach from the current UI.

**Design target (per Adrian):** the Claude app aesthetic — warm dark ground, rounded stat tiles, hairline borders, muted uppercase labels, one accent, generous spacing. Glanceable summary first, detail on demand.

## The 20 changes

### A. Design language (1–5)

1. **Stat-tile summary row.** A four-tile row above everything: *Data wires · Outputs · Pixels · Est. draw*. Values in large type, labels muted above — exactly the Claude usage-dashboard tile grammar. The tiles replace the summary strings currently buried in each step header, so the whole installation reads in one glance.
2. **Progress rail instead of five open accordions.** A slim horizontal rail (5 segments, filled = done, accent = current) with only the *current* step's card expanded below it. Tapping a rail segment jumps to that step. One decision on screen at a time.
3. **Retire the status-pill jargon.** `COMPLETE/NEXT/WAITING/OPTIONAL` pills become: a checkmark glyph on done steps, an accent ring on the current step, and plain sentences elsewhere ("Done", "Up next", "Optional — skip if wired by hand"). Mono uppercase is reserved for section eyebrows only.
4. **One card system.** Every interactive block becomes the same rounded card (12–16px radius, 1px hairline border, elevated background token). Kill the mixed `<details>` expanders, bordered sub-boxes, and inline-styled one-offs so the panel reads as one product.
5. **Typography hierarchy pass.** One panel title, one sentence of context, then cards. Delete the current triple stack (kicker + bold subtitle + two body paragraphs) that pushes the first control below the fold on a phone.

### B. Wiring flow UX (6–14)

6. **Plain-language step names.** "Choose data wires" → *"How many wires leave the card?"* · "Map LED outputs" → *"Match wires to strips"* · "Check the real LEDs" → *"Light them up and check"* · "Review and install" → *"Lock it in"*. Titles become the question the user answers.
7. **Persistent mini wiring diagram.** A small always-visible card→wire→strip schematic at the top that redraws as choices are made (wire count, mapping, verified state turning runs green). The picture *is* the state; pills become redundant.
8. **Wire-count chooser as visual cards.** Replace the 1–4 number buttons with four small cards, each showing a card glyph with N wires fanning out and a caption ("1 wire — one continuous run"). Selection updates the mini diagram instantly.
9. **Bench check becomes a guided wizard.** "Start physical LED check" opens a takeover flow: one big question per screen — *"Is the FIRST LED lit blue?"* — with two large buttons (Yes / Something's wrong), progress "3 of 6", and an illustration of blue-first/red-last. Same `wiringChaseReducer` underneath; only the shell changes.
10. **Fix the "visible from here" moment.** The checkbox-in-a-card becomes the wizard's first screen: *"Stand where you can see the LED strips"* with one button, *"I can see them"*. No checkbox, no disabled-button mystery.
11. **Color order as a quiz, not a spec.** Instead of "LED color order · GRB · Check colors": the card shows a swatch and asks *"The strip just lit up. What color do you see?"* — tap Red / Green / Blue. Two taps derive the order via `normalizeUsbLedColorOrder`; the user never sees "GRB" unless they open details.
12. **Inline recovery on every "No".** Each wizard failure branch offers the fix in place: "The last lit LED isn't at the end? Drag to set the real strip length" — surfacing the existing `planAdjacentStripBoundary` / `planStripPixelCountAdjustment` logic as a visible slider instead of hidden expert controls.
13. **A single "what's blocking install" banner.** Step 5's gate copy ("Physical LED check required · WAITING") becomes one amber banner with the blocker in a sentence and the action as a button: *"You haven't run the physical check yet → Run it now"* (jumps to step 4).
14. **Promote Auto Wire.** Step 3's `<details>`-buried Auto Wire becomes a suggestion card: *"Let Lightweaver route the wires for you"* with Preview → Apply/Undo, and the proposal drawn on the artwork before committing.

### C. Sizing (15–19)

15. **One "Size & Power" panel.** Merge Size mode (strip counts, density) with the power calculator (`estimatePowerBudget` — already duplicated into `src/lib/controllerProfiles.js`, just never rendered). Pixel counts drive a live power readout in the same view. Retire the unreachable `src-v3` Power Safety section.
16. **Power stat tiles + meter.** *Max draw · Supply · Headroom* tiles with a slim meter bar (accent fill, red past the 80% `safeAmps` line). The `ok/over` status becomes color, not text.
17. **Density picker with visual previews.** The 30/60/144 LED-per-meter segmented control renders actual dot spacing rows in each option, so density is seen, not decoded.
18. **Direct-manipulation strip sizing.** Drag the strip's end handle on the artwork to set pixel count; the `BufferedStripCountInput` stays as fine adjust. Show length in cm/in and LEDs side by side per strip.
19. **Computed power guidance.** When over budget, replace silence (and the src-v3 free-text "Notes" field) with derived advice: "Lower the brightness cap to 60%" / "Add a power injection point mid-run" — straight from the headroom math.

### D. Foundations (20)

20. **Token + a11y/responsive consolidation.** One tokens file (today: `src-v3/main.css` and `src/v3/v3-styles.css` both define them), container-query phone layout, 44px touch targets (this runs on a phone at the install site), visible focus rings, `prefers-reduced-motion` on all step transitions.

## Integration plan

Nothing below touches the state machines or the firmware API. This is a presentational re-skin over existing logic — which is what makes it safe to do incrementally.

**Phase 1 — primitives (new files, no behavior change)**
- `src/components/ui/StatTile.jsx`, `StepRail.jsx`, `Card.jsx`, `MeterBar.jsx`
- `src/styles/lw-tokens.css` — single token source; `v3-layout-modes.css` migrates to it
- Keep `data-testid="commissioning-step"` and step region names so `tests/wiring-workspace.spec.ts` helpers keep passing during migration

**Phase 2 — WireModePanel restructure**
- `WireModePanel.jsx`: keep `stepStates` (`:611-627`), auto-expand effect, and all handlers; swap `CommissioningStep` accordion rendering for `StepRail` + single expanded card; add the stat-tile row fed from `compiledWiring` + `estimatePowerBudget`
- New `WiringMiniDiagram.jsx` (change 7) reading `wiring` from `useProject()`

**Phase 3 — bench-check wizard**
- `WiringBenchTest.jsx`: same `useReducer(wiringChaseReducer)`, new full-panel wizard shell (changes 9–12); `StripColorOrderCheck.jsx` becomes the quiz (change 11)
- Update `tests/wiring-workspace.spec.ts` / `layout-hardening.spec.ts` selectors in the same PR as each shell swap

**Phase 4 — Size & Power merge**
- `SizeModePanel.jsx` gains the power section using the already-present `src/lib/controllerProfiles.js`; density preview + drag sizing (changes 15–18)
- Mark `src-v3/components/DevicesPanel.jsx` Power Safety section as superseded (leave `src-v3` untouched otherwise — it's the preserved legacy surface)

**Phase 5 — polish + gate**
- Changes 13, 14, 19, 20; then `npm run launch:check` from `lightweaver/` and the on-hardware smoke test in `docs/deployment-checklist.md` (the bench wizard must be validated against a real card before this ships — it's the safety-critical path).

## Test impact

- `tests/wiring-workspace.spec.ts` — `openCommissioningStep`/`gotoWire` helpers key off region names + toggle labels; each phase that renames copy updates these in the same commit.
- `src/lib/*.test.js` unit tests (wiringChase, cardWiringSafety, controllerProfiles) are untouched — no logic changes.
- Add one new spec: power tiles render `over` state when `estimatePowerBudget` reports it.
