# Color order: two taps, no cycling

**Goal.** Replace the color-order check with a deterministic 2-question solver.
Today the screen shows 9 interactive controls and asks the owner to cycle a
6-way order until the strip happens to look right. Two answers fully determine
the order, so the cycling is unnecessary and so is most of the UI.

**Owner:** lightweaver-app agent (`lightweaver/src/**`).
**Files:** `lightweaver/src/components/layout/wire/StripColorOrderCheck.jsx`,
`lightweaver/src/lib/usbLedColorOrder.js`,
`lightweaver/tests/wiring-workspace.spec.ts`, `lightweaver/tests/patterns-v3.spec.ts`.
**Estimate:** ~1.5 hours including test updates.

---

## The math (why two taps is enough)

Let `C` be the configured order (what Studio has saved) and `T` the strip's real
hardware order. Firmware writes the wire bytes in `C`'s sequence; the strip
lights channel `T[i]` with whatever arrived at wire position `i`.

So when Studio sends a pure logical channel `X`:

```
observed = T[C.indexOf(X)]
```

- Send logical **red** → the answer pins one position of `T`. 6 candidates → 2.
- Send logical **green** → pins a second position. 2 → 1. Third is forced.
- Save `C := T`. Done.

Two properties that make the UI simple:

1. **`C` never changes between the two questions.** No re-push to the card
   mid-flow, no "try next order", no flicker. One order is applied, two colors
   are shown under it.
2. **The second question always has exactly 2 possible answers** — never 3, never
   1. So step 2 renders 2 buttons, and it is always exactly 2 taps, every time,
   for every strip.

---

## Pure solver (add to `usbLedColorOrder.js`)

Keep this out of the component so it is unit-testable without hardware.

```js
// What the eye reports when logical channel `logical` is sent under configured
// order `configured` on a strip whose real order is `trueOrder`.
export function observedChannel(configured, trueOrder, logical) {
  return trueOrder[configured.indexOf(logical)];
}

// Every order still consistent with the answers so far.
// observations: { R: 'B' } or { R: 'B', G: 'R' } — values are observed channels.
export function colorOrderCandidates(configured, observations) {
  return COLOR_ORDERS.filter(trueOrder =>
    Object.entries(observations).every(
      ([logical, seen]) => observedChannel(configured, trueOrder, logical) === seen,
    ));
}

// The answer buttons to offer for logical channel `logical`, given prior answers.
export function colorOrderAnswers(configured, observations, logical) {
  return [...new Set(
    colorOrderCandidates(configured, observations)
      .map(trueOrder => observedChannel(configured, trueOrder, logical)),
  )];
}
```

Then the component is: ask for `'R'` (3 answers), ask for `'G'`
(`colorOrderAnswers` returns 2), and
`colorOrderCandidates(C, { R: o1, G: o2 })[0]` is the answer. Save it, push it,
mark confirmed.

Unit-test the solver directly: for all 6 true orders × all 6 configured orders,
simulating the two observations must recover the true order. 36 cases, no card.

---

## UI spec

**Closed** — unchanged. Header "Do the colors look right?", detail line
"Colors not checked yet" / "Colors confirmed", `Check colors` button.

**Step 1 of 2** — red swatch, "What color do you see?", 3 buttons: Red, Green,
Blue.

**Step 2 of 2** — green swatch, same question, 2 buttons (from
`colorOrderAnswers`).

**Done** — "Colors confirmed" in the header detail; the order token stays in the
small footnote line, keeping `data-testid="strip-color-order"`.

Add a step marker ("Step 1 of 2") so the owner knows the flow is short and
finite — that is most of what makes it feel simple.

### Delete

- The R / G / B / W mini chip row (`lwb-quiz-minis`).
- `Try next order` (both the ghost button and the quick-mode one).
- `Stop lights` as a button — call `stopCardLights` automatically when the
  solver completes and on unmount instead.
- The standalone "Light test warning: colors will change at a reduced,
  power-limited brightness." paragraph — fold "Brightness is reduced for the
  test." into the hint line.
- The running status line during normal operation. Keep an error-only line: if
  the card cannot be reached, that must still be visible and loud.

### Collapse the quick mode

`quick` currently renders a second, different flow ("Shift colors", `quickStage`
state machine, `acceptQuickRed` / `tryOtherQuickMatch` / `confirmQuickOrder`).
Under the solver there is nothing left for it to do differently: `quick` becomes
"start the same 2-tap solver immediately, skipping the closed header". Delete
`quickStage` and its three handlers, and `tryNextOrder` / `answerColor` with
them. One code path serves both entry points.

Net expectation: the component drops from 288 lines to roughly 150.

**Built 2026-08-20.** Landed at 256 lines rather than ~150: the failure state
(the strip never lit, so there is nothing to answer — only "Try again") is real
UI the estimate did not account for, and it is what stops an unreachable card
from being "confirmed" by an answer to a question it never asked.

---

## Acceptance

1. From any starting configured order, two taps produce the correct saved order
   and `colorOrderConfirmed: true`.
2. Step 2 renders exactly two answer buttons, always.
3. The card receives two `pushLiveHardwareToCard({ colorOrder })` calls at
   most: one at the start to make Studio and the card agree on the order the
   questions are asked under, and one at the end carrying the solved order.
   None between the questions.
4. Test lights are off after the flow completes and after the section unmounts,
   with no "Stop lights" button on screen.
5. A card that cannot be reached still shows a visible error.
6. Solver unit test covers all 36 (true × configured) pairs.

## Tests to update

- `wiring-workspace.spec.ts:464–472` drives `Try next order` and asserts the
  order token flips RGB → GRB. Rewrite as: answer red, answer green, assert the
  solved token.
- `wiring-workspace.spec.ts:1084` and `patterns-v3.spec.ts:708` assert absence
  of `Check colors` / `Try next order` — these should still pass; confirm rather
  than edit.
- `patterns-v3.spec.ts:370` asserts the token text; keep the `data-testid`.

Run with JSON stats and require `unexpected: 0` verbatim:

```
npx playwright test wiring-workspace patterns-v3 --reporter=json
```
