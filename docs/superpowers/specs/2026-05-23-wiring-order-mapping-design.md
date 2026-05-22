# Lightweaver Wiring Order Mapping Design

## Goal

Lightweaver should let an artist map the real physical LED order independently from the imported SVG or artwork layer order. A layer imported as the tenth artwork layer may be the first wired section in the physical strip, and export should reflect that real wiring order.

The feature should also support partial ranges, reversed ranges, stacked ranges, jumps between visible areas, and inactive spans that reserve physical LED addresses without showing as active artwork LEDs.

## Problem

The current mapper samples each strip from its SVG path and assigns global indexes from the section list order. It can reverse an entire section, but it does not clearly model the physical route of a real strip that jumps between artwork areas, enters a section from either side, skips visible output for cut or hidden LEDs, or reuses the same artwork path for stacked LEDs.

That creates a mismatch between the mental model an installer uses and the data Lightweaver exports. The installer thinks in wiring order; the app currently thinks mostly in imported section order.

## Core Model

Add a saved **Wiring Order** model to the project. The wiring order is the source of truth for export and physical LED indexing. Artwork layers and strips remain visual sources; wiring rows decide how those sources become physical LEDs.

The basic unit is a **span**:

```js
{
  type: "span",
  stripId: "layer-10",
  startLed: 2,
  endLed: 10,
  output: "normal"
}
```

`startLed` and `endLed` are sampled LED indexes on the source strip. Direction is inferred from the order:

- `startLed: 2, endLed: 10` runs forward.
- `startLed: 10, endLed: 2` runs backward.

This keeps the model simple enough to explain: each row says where the physical chain enters and where it leaves.

## Wiring Order Rows

The first implementation should support these row types:

- `span`: maps a source strip range into the physical chain.
- `off`: reserves a number of physical LED addresses that should not appear as active artwork LEDs.
- `jump`: documents a physical jump between areas without consuming LED addresses.

Examples:

```text
1. Layer 10   0 -> 42    normal
2. Layer 3    31 -> 0    normal
3. Layer 7    2 -> 10    normal
4. Layer 7    11 -> 20   normal
5. Off block  12 LEDs    off
```

Layer 10 can become physical LED 0 even if it imported as the tenth layer. Layer 7 can appear more than once as separate spans. Reversing is per row.

## Stacking

Stacking should be allowed deliberately. Multiple spans may reference the same strip range or the same coordinates. Export should keep duplicate coordinates because they represent different physical LED addresses.

To prevent mistakes, Wiring Order Edit Mode should show stacked LEDs with a small `x2`, `x3`, or similar badge, and the warning panel should distinguish intentional stacking from accidental overlap.

## Inactive Or Cut-Off LEDs

An `off` row reserves physical LED addresses but does not render those LEDs as active artwork dots. In Lightweaver preview and direct live output, those addresses should be black.

Important caveat: WLED `ledmap.json` primarily stores coordinates, not a full "always off" behavior. For WLED-native effects, inactive rows may need follow-up segment or preset support to force those addresses off. The first implementation should make the project model and Lightweaver preview/live output correct, then clearly label the limitation in export UI.

If LEDs are physically removed and no longer exist in the address chain, the user should delete the off row instead of reserving it.

## Interaction Design

Add a **Wiring Order** panel, separate from the imported layers list.

Default workflow:

1. Import artwork layers as today.
2. Open Wiring Order.
3. Drag imported layers or sections into the real physical order.
4. Use each row as a whole section by default.
5. Expand a row only when needed to set `startLed`, `endLed`, output mode, or duplicate/stack behavior.

Canvas behavior in Wiring Order Edit Mode:

- Selecting a wiring row highlights its source strip/span.
- Start and end handles appear on actual sampled LED points.
- Dragging a handle snaps to the nearest sampled LED index, so spans stay tied to real LED count.
- Reversing is done by swapping start and end, or by a reverse button that performs the same swap.
- Stacked spans remain selectable through the side panel even if their dots overlap on canvas.

## Export Flow

Export walks the Wiring Order rows from top to bottom and assigns global indexes in that order.

For `span` rows, the sampled pixel list is sliced inclusively from `startLed` to `endLed`. If `startLed > endLed`, the slice is reversed.

For `jump` rows, no LED indexes are consumed.

For `off` rows, indexes are consumed and marked inactive in project data. Lightweaver live output should emit black for these indexes. Coordinate export should include deterministic coordinate entries for those addresses so total LED count and physical indexing remain stable. The export UI must explain that WLED-native effects may still light those addresses unless a future segment or preset export also disables them.

If no Wiring Order exists, preserve the current behavior by generating one default span per visible strip in current section order.

## Persistence

Project save/load and local autosave should include `wiringOrder`.

Suggested shape:

```js
{
  version: 4,
  wiringOrder: {
    chains: [
      {
        id: "main",
        name: "Main physical strip",
        rows: [
          { type: "span", stripId: "layer-10", startLed: 0, endLed: 42, output: "normal" },
          { type: "jump", label: "wire behind artwork" },
          { type: "span", stripId: "layer-3", startLed: 31, endLed: 0, output: "normal" },
          { type: "off", ledCount: 12, label: "cut-off / hidden LEDs" }
        ]
      }
    ]
  }
}
```

The first implementation exposes one main physical strip. The `chains` array leaves room for multi-chain support later, but the UI creates and edits only the main chain.

## Validation And Warnings

Show non-blocking warnings for:

- missing source strip references
- `startLed` or `endLed` outside the strip's current LED count
- overlapping spans on the same strip
- duplicate spans that create stacked coordinates
- off rows that reserve LED addresses
- an empty wiring order

Warnings should explain consequence, not just state an error. Example: "Layer 7 LED 2-10 is used twice, so those coordinates will be stacked in export."

## Error Handling

If a strip LED count changes, clamp saved span endpoints to the new valid range and show a warning. Do not silently delete rows.

If a source strip is deleted, keep the wiring row in a broken state until the user removes or remaps it. This preserves recoverability after accidental edits.

If all rows are invalid, export should fail with a clear message instead of producing a misleading map.

## Testing

Add unit tests for wiring order expansion:

- imported Layer 10 first becomes global LED 0.
- forward span `2 -> 10` emits nine physical LEDs in ascending source order.
- reverse span `10 -> 2` emits nine physical LEDs in descending source order.
- adjacent spans `2 -> 10` and `11 -> 20` preserve physical continuity.
- duplicate spans produce duplicate coordinates with unique global indexes.
- jump rows consume no indexes.
- off rows consume indexes and mark pixels inactive.
- default wiring order matches current export behavior when no saved order exists.

Add UI or integration coverage for:

- project save/load preserves wiring order.
- autosave restores wiring order.
- dragging start/end handles snaps to actual LED indexes.
- warnings appear for overlap, stacking, broken references, and off rows.

Manual verification:

- Import an SVG with at least ten layers and make Layer 10 first in Wiring Order.
- Export and confirm Layer 10's first sampled LED is global index 0.
- Reverse one row and confirm the canvas arrow, preview, and export agree.
- Add an off row and confirm those addresses are hidden in preview and black in live output.
- Stack two spans over the same range and confirm both physical addresses are exported.

## Out Of Scope

The first implementation should not try to solve every WLED-native off/segment behavior. It should make the Lightweaver project model, preview, live output, and coordinate export truthful, then expose any WLED-native limitations clearly.

Automatic physical-wire-length calculation between jumped areas is also out of scope. Jumps are intentional wiring-order documentation unless the user adds explicit off rows.
