# Layout Screen Redesign — Implementation Plan

**Date:** 2026-07-10 · **Status:** Phase 1 complete · Phase 2 complete (steps 0–14, including CSS cleanup + the final test-plan audit) · Phase 3 (Send to card + Export ledmap.json) folded into Phase 2 step 9 and complete. All testids from step 14 exist; the named Playwright suites (`workflow`, `patch-board`, `screen-smoke`, `layout-mode-switch`, `layout-size-mode`, `layout-send-to-card`) are green: 36 passed / 1 skip.
**Scope:** `lightweaver/src/components/LayoutScreen.jsx` (3,909 lines) + `PatchBoardScreen.jsx` (452 lines) and the state underneath them.

## Diagnosis (why, in three sentences)

The Layout screen does three jobs at once — turning artwork into strips (creative), making numbers match reality (arithmetic), and matching the physical wiring (bench work) — and because they share one panel, drag means three things, four grouping concepts coexist, and wire order lives in **two competing models** that can silently disagree. Worse, **three orderings** exist in code: the `strips[]` array (what the list shows), `patchBoard.chains[0].rowIds` (what `expandPatchBoard` exports), and the offset math in `patchBoardToZones`/`deriveSectionTargets` (which uses `strips[]` order while iterating patches). Meanwhile the screen's finish line — Push to card and Export ledmap — exists in code with no button.

## Target design (decided)

One canvas + a **Draw | Size | Wire** mode switch + one context panel that swaps per mode. Selection-driven inspector inside each mode. Always-visible chrome: Import SVG, zoom, undo/redo, Save/Load, light-preview toggles. Wire mode ends with **Send to card** and **Export ledmap.json**.

- **Draw** — artwork layers, one "make strips" action (one strip / separate / grouped), ONE Group concept, strip inspector (name, reverse, emit+angle via Compass only, color, brightness), freehand draw.
- **Size** — top-to-bottom derivation chain: artwork size → density (only place it appears) → per-strip counts with override badges; "Set real count" → "Calibrate from this strip" with honest rescales-everything copy.
- **Wire** — strip list IS the chain (drag = chain mutation); Split/Gap/Link tools live here only; Send to card + Export ledmap at the bottom.

## Phase boundaries and the contract between them

Phase 1 is invisible (behavior-parity refactor); Phases 2–3 are the visible redesign. Phase 1 must deliver, and Phase 2 consumes:

| Contract item | Phase 1 delivers | Phase 2 consumes as |
|---|---|---|
| Wire-order truth | `patchBoard.chains[0].rowIds`; `strips[]` becomes unordered entity store | Wire-mode list order via `orderedStripIdsFromChain` |
| Reorder API | `reorderStripRows(draggedIds, targetId)` → `moveStripRowsInChain` | Wire-mode row drag (replaces `reorderStrips`) |
| Selection | one `selection = {kind: 'none'\|'strip'\|'layer'\|'path', ids, entries?, name}` in the reducer | all panels + canvas highlights. Group rows select their member strips (`kind:'strip'`, multiple ids) — no separate `'group'` kind |
| Undo | single stack in ProjectContext: `undoLayout/redoLayout/layoutHistLen/layoutFutLen`; patch-board edits join the stack | Chrome undo/redo buttons + ⌘Z (these are the canonical names — Phase 2 draft said `undo()/canUndo`; use Phase 1's) |
| Strip ids | own namespace `strip-<n>` + `sourceLayerId`/`sourcePathId` fields; load-time migration | Draw-mode `existingStrip` lookup by `sourceLayerId`, not id coincidence |
| Per-strip count overrides | add `stripCountOverrides` to the layout slice (Phase 2 step 8 needs it; put the field in the Phase 1 reducer so it's in snapshots/autosave from day one) | Size-mode override badges; `recountStrips` skips overridden strips |

---

# Phase 1 — State consolidation (no visual change)

**Key design calls (decided):**
- **Wire-order authority = the chain.** `strips[]` stays an array but its order is never read again.
- **Migration rule: `strips[]` order WINS at load.** The flashed artifact's pixel addresses come from `strips[]` order today (`patchBoardToZones`, `cardRuntimeContract.js:69`), so the load migration reorders `chain.rowIds` to match `strips[]` (off rows preserved), THEN the offset math flips to accumulate along the chain. Existing projects export byte-identical addresses; divergence becomes impossible going forward.
- **Undo = snapshot-based** (matches the working `makeSnapshot` model; action-based risks parity across ~30 mutators). Snapshots exclude strip `pixels` (rebuilt on apply) and all ephemeral view state (zoom/pan, drawMode/waypoints, wireOverlayMode, hover/expand, dragOver…). Persisted+undoable: `strips, layers, layerGroups, layerOrder, editCounts, stripCountOverrides, hidden, svgText, viewBox, density, pxPerMm, patchBoard, selection, nextStripSeq`.

**Steps (each independently commitable):**

1. **[M] Chain-order primitives in `src/lib/patchBoard.js`** (pure, no consumers): `chainPixelOffsets(board, strips)`, `orderedStripIdsFromChain`, `moveStripRowsInChain` (moves a strip's patches as a contiguous block, splits preserved, off rows keep position; built on `applyPatchRouteOrder` slot logic), `migrateChainToStripOrder`. Tests in `src/lib/patchBoard.test.js`.
2. **[M] Wire migration into load path** — `migrateProject` (`src/lib/projectModel.js:163`) / `applyProject` (`ProjectContext.jsx:367`) call `migrateChainToStripOrder` after `normalizePatchBoard`. New `tests/layout-migration.mjs` with a divergent-order fixture.
3. **[M] Flip offset math to chain order** — `patchBoardToZones` (`cardRuntimeContract.js:69`) and `deriveSectionTargets` (`sectionLookModel.js:12`) use `chainPixelOffsets`; signatures unchanged. Parity test: divergent fixture yields identical zone `start/count` old-code-pre-migration vs new-code-post-migration. Guards: `tests/card-runtime-contract.mjs`, `sectionLookModel.test.js`, `tests/card-section-sync.mjs`, `tests/playlist-live-preview.mjs`.
4. **[L] Strip id namespace** — `nextStripId()` → `strip-<n>`; add `sourceLayerId`/`sourcePathId` at all creation sites (`makeStrip` :935, `addSubPathStrip` :1125, `addSelectedPathsAsStrips` :1154, `confirmDraw` :1820, `duplicateStrip` :1509, `mergeSelectedStrips` :1534); repoint artwork-highlight :1850, `deleteLayer` :1403, `deleteSelectedVectorPaths` :1431. `migrateStripIdNamespace` rewrites patch ids, `source.stripId`, `rowIds`, group members, `editCounts`/`hidden` keys atomically from one old→new map.
5. **[L] `src/state/layoutReducer.js`** — pure reducer + `makeLayoutSnapshot`/`applyLayoutSnapshot` (drop/rebuild pixels) + history helper (past/future, MAX 50). `tests/layout-reducer.mjs`: snapshot round-trip, undo restores selection, memory bound, interleaved strip+patch-board edits.
6. **[L] Wire reducer into ProjectContext** — replace the layout `useState`s (:116–127) with `useReducer`; expose the SAME context keys as thin dispatch adapters so all screens keep compiling; add `pushLayoutHistory/undoLayout/redoLayout/layoutHistLen/layoutFutLen/selection`.
7. **[L] LayoutScreen consumes context** — delete its `historyRef/futureRef` (:668), `makeSnapshot` (:771), `lsSave`/`LS_KEY` (:795/:414), `applySnapshot` (:1936), `doUndo/doRedo`, the 11 mirroring effects (:741–751) and the `projectRevision` re-hydrate (:829–843). All mutators dispatch through the reducer; `updatePatchBoard` (:1679) and PatchBoardScreen's `updateBoard` (:90) route through `pushLayoutHistory` — patch-board edits join undo for the first time.
8. **[M] Chain-based reorder** — replace `reorderStrips` (:1043) with `reorderStripRows`; strip list (:3750) renders `orderedStripIdsFromChain`; row badge = chain index.
9. **[M] Selection consolidation** — replace `selLayerId/selStripId/selectedStripIds/pathSel/stripSelectionName/pathSelName` with reducer `selection`; rewrite `selectLayer/selectStrip/toggleStripSelection/togglePathSelection` (:1275–1301, :1029), `isSel`/`isBatchSel` reads, Escape handler (:1992).
10. **[S] Note dead code** (`SCALE_OPTIONS`, `pushToCard`, `toWLEDLedmap`) — do NOT delete; Phase 3 surfaces the latter two.

**Risk register:** (1) firmware addressing shifts where strip order ≠ chain order → step 2 aligns before step 3 flips, parity test proves it; (2) id-remap corrupts patchBoard/groups/editCounts → atomic map + round-trip test + `normalizePatchBoard` orphan pruning; (3) Patterns/Playlist/Settings read stale targets → signatures unchanged + existing suites; (4) legacy `lw-layout-autosave` restore breaks → the key stays READ-only in `resolveStartupProject` (:429), only the writer dies; (5) undo regressions from merged stacks → strict ephemeral/persisted split + interleave test; (6) split strips lose rows on reorder → block-move semantics + dedicated tests.

**Parity checklist (gate for steps 7–9):** import SVG; add strip / add-all / draw / sub-path strip / paths→merged/separate/grouped; reverse/duplicate/delete; canvas drag-move + arrow nudge; rename everywhere; density change (wipes editCounts); scale change; calibrate-from-strip; group/merge/layer-group; chop/link/nudge-cut/delete-cut/off-patch; row-drag reorder; interleaved undo/redo; autosave restore; old-format project load. Each: identical visuals + identical `expandPatchBoard`/`patchBoardToZones` output vs `main`.

---

# Phases 2–3 — Mode shell + surfacing the finish line

**⚠️ Step 0 (do first, can run during Phase 1): repair the stale Playwright specs.** `lightweaver/tests/{workflow,patch-board,screen-smoke}.spec.ts` navigate to the current app but their locators (`.lw-strip-row`, `.lw-layer-row`, `.lw-rail-btn`, `.lw-patch-details`, `.lw-wire-map`) only exist in the frozen `src-v3/` interface (`?v=3`). Zero occurrences under `src/`. They are almost certainly red today and are NOT a safety net until rewritten against the real DOM. Run them, confirm, repair before the panel surgery.

**Component decomposition** (target ≈4,830 lines across files vs 4,361 in two monoliths today — growth is the genuinely new Size/Wire UI):

```
src/components/LayoutScreen.jsx            thin composition, ~70 lines: ({connected, go}) → useLayoutState() → <LayoutModeShell/>
src/components/layout/
  LayoutModeShell.jsx      mode↔hash sync, cancelActiveTool-on-switch, error banner, empty state
  LayoutChrome.jsx         mode switch, Import SVG, +All, undo/redo, zoom, Save/Load, Light/LEDs/Heat
  canvas/LayoutCanvas.jsx  verbatim lift of the <svg> subtree (:2658–3128), handlers parameterized by mode
  modes/DrawModePanel.jsx  SizeModePanel.jsx  WireModePanel.jsx
  shared/ModeSwitch.jsx  InspectorPrimitives.jsx (EmitCompass, InlineRename, icons)  CardPushControl.jsx
  hooks/useLayoutState.js (composer) + useLayoutImport/Artwork/Strips/Size/Wire/CanvasInteraction.js
src/lib/layoutGeometry.js  pure functions (sampleStripPixels, measureLayers, getPxPerMm, recountStrips, …)
PatchBoardScreen.jsx       DELETED once WireModePanel absorbs it
```

**Canvas behavior matrix (resolves the drag overload):** canvas strip-drag = positional move, **Draw mode only** (disabled in Size/Wire); side-panel row drag = wire reorder, **Wire mode only**; lasso = Draw only; chop/link overlays hit-testable in Wire only; arrow-nudge Draw only; `1/2/3` switch modes globally (`d/s/w` rejected — collides with Draw's tool keys); `g/m/h/a` gated to Draw; `f`, Escape, ⌘Z global. Switching modes calls `cancelActiveTool()` (clears waypoints/drawMode/wireOverlayMode/linkRouteIds) so no tool runs invisibly.

**Capability coverage:** all ~46 current capabilities land in Chrome/Draw/Size/Wire per the matrix; the ONLY cuts are provable duplicates — the toolbar Density copy (inspector copy also dies; Density lives in Size mode only) and the Emit mini-seg (folded into `EmitCompass`: clicking the hub toggles Omni⇄Directed). Nothing else is lost.

**"ONE Group" decision:** `createLayerGroupFromEntries`, `createStripGroupFromIds`, and the `'grouped'` branch are all non-destructive folders differing only in timing → one **Group** action inferring its target from selection kind. `mergeSelectedStrips` stays separate as **"Combine into one strip"** — it's destructive (resamples, kills independent wiring) and hiding it behind Group would be a safety regression.

**Mode switch placement:** segmented control (same `.seg` visual as today's Density) first in the Layout toolbar — NOT the global TopBar (mode is meaningless on other screens). Deep link: `#screen=layout&mode=wire` — `app.jsx`'s `viewFromHash` already parses `URLSearchParams` (:36–38), so it's free; `LayoutModeShell` merges `mode=` via `history.replaceState`.

**Phase 3 — Send to card + Export:**
- `CardPushControl` (extracted from `PatchBoardScreen.pushToCard` + `pushHost/pushStatus/pushKind/pushFallbackJson`): ambient dot from the `connected` prop that `app.jsx:255` already passes and LayoutScreen currently drops; button NOT disabled when disconnected (`pushConfigToCard` has its own discovery/fallback); states = idle / pushing (disabled, "Pushing to {host}…") / success (green, auto-clear 4s) / fail (red + message) / mixed-content fail (red + read-only JSON textarea, verbatim from PatchBoardScreen :217–236).
- **Export ledmap.json** next to it: `toWLEDLedmap(pixelsFromPatchBoard(patchBoard, strips))` → `download(...)`, all already in `src/lib/export.js` with zero call sites today.
- Delete dead `SCALE_OPTIONS`/`SCALE_BASE_PX_PER_MM`/`LED_COUNT_PRESETS` (:405–412) and LayoutScreen's local `download` (:391–396, use export.js's).

**Ordered steps (strangler — screen works after every commit):**

1. **[S]** Extract pure geometry → `src/lib/layoutGeometry.js` (code motion only).
2. **[S]** Extract `InspectorPrimitives.jsx`.
3. **[M]** Extract `CardPushControl.jsx` (PatchBoardScreen keeps calling it; no UX change yet).
4. **[L]** Build the `useLayout*` hooks + `useLayoutState` composer; LayoutScreen still renders its original JSX. Highest-risk pure refactor — isolated from any UI change.
5. **[L]** Extract `LayoutCanvas.jsx` verbatim.
6. **[M]** Introduce `mode` + `ModeSwitch` + `LayoutModeShell` + hash sync + `cancelActiveTool`; Size/Wire are stubs. New spec: `1/2/3` update the hash; switching cancels an in-progress draw.
7. **[L]** `DrawModePanel.jsx` — pure move of layers list + path panel + inspector (dupes intact; trimming is step 10).
8. **[L]** `SizeModePanel.jsx` — new UI + the `stripCountOverrides` behavior fix (today `recountStrips` silently discards manual per-strip counts on any density/scale change). Spec: override badge appears, survives density change, clears on reset.
9. **[L]** `WireModePanel.jsx` — absorb PatchBoardScreen (drop `embedded` branching; always expanded, no `<details>`), plug in CardPushControl + Export ledmap. If Phase 1's reorder API isn't merged, shim with `reorderStrips` + `// TODO(phase1)`.
10. **[M]** Trim Draw mode to spec: kill duplicate Density/Emit controls, unify Group, relabel Combine. Delete `PatchBoardScreen.jsx` (grep importers first — currently only LayoutScreen).
11. **[S]** Canvas behavior finalization per the matrix (prop wiring at this point).
12. **[S]** Cleanup: dead constants, one `download`, thread `connected/go`.
13. **[M]** CSS: keep `.la` shell/`.toolbar`/`.inspector`/`.la-compass*`/wire-overlay classes; delete `.la-wire-editor` disclosure styles + `.lw-wire-head*`; new `src/styles/v3-layout-modes.css` (`.la-mode-switch`, `.la-size-chain`, `.la-count-badge`, `.la-card-push` matching StatusBar's dot language) imported after `v3-layout-extra.css`.
14. **[M]** Tests: repaired specs green + new `layout-mode-switch`, `layout-size-mode`, `layout-send-to-card` (reuse `workflow.spec.ts`'s `mockLocalCard` route pattern for all four push states) specs; re-point the existing ledmap-download assertion at `layout-export-ledmap`. New testids: `layout-mode-switch`, `layout-mode-{draw,size,wire}`, `layout-size-strip-row`, `layout-size-count-override-badge`, `layout-wire-chain-row`, `layout-send-to-card`, `layout-export-ledmap`. Preserve `data-testid="default-circle-layout-panel"`.

---

## Build order across phases

Phase 1 steps 1–3 (chain migration) are the foundation — land them first and alone; they're the only steps that touch firmware addressing. Phase 2 step 0 (spec repair) can run in parallel. Then Phase 1 4–9, then Phase 2 1–14. Every step is a separate commit; `npm run launch:check` (from `lightweaver/`) plus the named suites gate each one.
