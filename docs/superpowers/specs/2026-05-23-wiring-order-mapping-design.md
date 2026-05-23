# Lightweaver Patch Board Mapping Design

## Goal

Lightweaver should let an artist build an honest physical LED map, then play with the installation through reorderable patches and groups.

The core workflow is:

1. Map reality: each physical LED address points to its actual coordinate.
2. Split that physical map into patches such as `Layer 7 LEDs 2-10`.
3. Arrange patches into the real wiring order.
4. Group patches into artist zones such as Outer, Inner, Halo, or Center.
5. Apply playback controls at the global, group, or patch level.

The product should support partial ranges, reversed ranges, stacked ranges, jumps, cut-off or inactive LEDs, per-patch playback controls, verification against real hardware, and a simpler performance view for running the piece.

## Critical Principle

Map reality first. Choreograph behavior second.

If physical LED 0 is wired into the "wrong" artwork area, the map must still record LED 0 at that real coordinate. Lightweaver can then group, reorder, reverse, hide, or animate that LED creatively. The app should not lie about where the physical LED actually is.

This prevents spatial effects, gradients, previews, WLED exports, and Madrix/Art-Net workflows from drifting away from the real installation.

## Problem

The current mapper samples each strip from its SVG path and assigns global indexes from section order. It can reverse an entire section, but it does not model how real installations are built:

- a later SVG layer may be the first physical LED run
- one artwork layer may be split into several controllable pieces
- patches may need to be reordered to match physical wiring
- a patch may need to run backward
- physical LEDs may be hidden, cut off, or intentionally forced black
- the same coordinates may be stacked with multiple LED addresses
- an outer layer may contain several patches controlled as one group
- patches inside a group may still need individual effect overrides

The installer thinks in physical addresses, patches, and zones. The app currently thinks mostly in imported sections.

## Conceptual Model

Lightweaver should expose four concepts with clear jobs.

### Physical Map

The physical map is the truth layer: LED address to coordinate.

It answers: "Where is each real LED?"

This layer should be verified, then locked. Once locked, normal creative editing should not accidentally move coordinates or change address order.

### Layers

Layers are imported SVG or artwork geometry. They are source material.

They answer: "Where did this shape/path come from?"

Layers should not be the main creative control surface. They remain useful for selecting source geometry and creating patches.

### Groups

Groups are artist-defined zones, such as Outer, Inner, Ring, Center, or Halo.

They answer: "What part of the artwork should behave together?"

The first implementation should support one group level:

```text
Group
  Patch
  Patch
  Patch
```

Do not support infinite nested groups in the first version. A single group level gives enough power while keeping the tool readable.

### Patches

A patch is a controllable slice of LEDs.

It answers: "Which physical LEDs are these, and how should they behave?"

Examples:

```text
Patch A   Layer 7    LEDs 2-10    forward   on    speed 1.00x
Patch B   Layer 7    LEDs 11-20   forward   on    speed 0.50x
Patch C   Layer 10   LEDs 40-31   reverse   on    speed 1.25x
Cutoff    12 LEDs    off block    off
```

The same layer can produce many patches. A group can contain one patch or many patches. A group can apply one effect across all its patches, while individual patches can override that effect when needed.

## Patch Data Model

Project save/load and autosave should persist a `patchBoard` object.

Suggested shape:

```js
{
  version: 4,
  patchBoard: {
    physicalLocked: false,
    chains: [
      {
        id: "main",
        name: "Main physical strip",
        rowIds: ["patch-a", "patch-b", "off-1", "patch-c"]
      }
    ],
    groups: [
      {
        id: "outer",
        name: "Outer",
        patchIds: ["patch-a", "patch-b"],
        playback: {
          patternId: "aurora",
          speed: 1,
          brightness: 1,
          hueShift: 0,
          enabled: true
        }
      }
    ],
    patches: [
      {
        id: "patch-a",
        name: "Outer A",
        groupId: "outer",
        source: {
          type: "strip",
          stripId: "layer-7",
          startLed: 2,
          endLed: 10
        },
        output: {
          mode: "normal"
        },
        playback: {
          patternId: null,
          speed: null,
          brightness: null,
          hueShift: null,
          enabled: null
        }
      },
      {
        id: "off-1",
        name: "Cutoff",
        groupId: null,
        source: {
          type: "off",
          ledCount: 12
        },
        output: {
          mode: "off"
        },
        playback: {}
      }
    ]
  }
}
```

`null` playback values inherit from the group, then from the global scene. Explicit values override inheritance.

Direction is inferred from the source range:

- `startLed: 2, endLed: 10` runs forward.
- `startLed: 10, endLed: 2` runs reverse.

The first implementation exposes one main physical chain. The model leaves room for more chains later, but the UI should create and edit only the main chain.

## Physical Order And Creative Order

The UI must distinguish physical order from creative grouping.

Physical order determines LED addresses and export. It should live in setup-oriented Patch Board controls and become lockable.

Creative grouping determines how the user performs and animates the piece. Groups can contain patches in a readable zone order, but moving a patch between groups should not silently change its physical LED address order.

Recommended behavior:

- In **Setup** mode, dragging patch rows in the physical chain changes physical address order.
- After **Lock Physical Map**, dragging between groups changes creative organization only, not physical address order.
- Unlocking the physical map should be possible, but treated as a deliberate setup edit.

## Interaction Design

Add a **Patch Board** panel, separate from the imported Layers panel.

Default setup workflow:

1. Import artwork layers.
2. Create patches from full layers by default.
3. Split patches into ranges such as `2-10` and `11-20`.
4. Drag patches into real physical chain order.
5. Add off blocks for hidden or cut-off LEDs that still reserve addresses.
6. Run Verification Mode against hardware.
7. Lock Physical Map.
8. Organize patches into groups and assign playback controls.

Canvas behavior in Patch Edit Mode:

- Selecting a patch highlights its source geometry and physical LED range.
- Start and end handles appear on actual sampled LED points.
- Dragging a handle snaps to the nearest sampled LED index.
- Reversing swaps start and end.
- Stacked coordinates show a small `x2`, `x3`, or similar badge.
- Hidden/off physical addresses are shown in setup mode but not as active artwork dots in performance mode.

Patch Board row controls:

- drag handle
- patch name
- source layer/range
- forward/reverse
- output mode: normal or off
- group assignment
- speed
- brightness
- hue shift
- pattern override

To keep rows scannable, physical controls should be always visible, while playback controls can sit in an expanded details row or inspector.

## Groups And Effect Inheritance

Playback controls should resolve in this order:

```text
Global scene
  -> Group playback
    -> Patch override
```

A group can have one effect that applies to all its patches. A patch can override pattern, speed, brightness, hue shift, or enabled/off state.

Examples:

```text
Outer group: Aurora, 0.75x, brightness 80%
  Patch A: inherit
  Patch B: speed 0.50x
  Patch C: pattern override Fire

Inner group: Solid warm, 1.00x
  Patch D: inherit
  Patch E: off
```

This supports the user's mental model: an outer layer can be split into patches and controlled as a group, while each patch remains individually playable.

## Verification Mode

Add a hardware verification workflow before export or performance use.

Verification Mode should:

- flash physical LED addresses one at a time
- highlight the expected canvas dot at the same time
- support stepping forward/backward through addresses
- support playing a slow address chase across the whole chain
- show current address, patch, group, source layer, and coordinate
- provide quick actions: split here, reverse patch, mark off, jump to patch, select source

This catches the real failure modes: wrong first pixel, reversed patch, skipped LEDs, bad split, swapped patches, and hidden LEDs accidentally still active.

## Lock Physical Map

Once verification passes, the user should be able to lock the physical map.

Locked behavior:

- coordinates cannot be moved accidentally
- physical chain order cannot be changed by casual drag operations
- patch source ranges cannot be edited without unlocking
- group membership, effects, speed, brightness, hue, pattern override, and on/off can still change

This makes the tool safer for installation operation. The operator can play without damaging the setup.

## Inactive Or Cut-Off LEDs

An off block reserves physical LED addresses but does not render those LEDs as active artwork dots. In Lightweaver preview and direct live output, those addresses should be black.

If LEDs are physically removed and no longer exist in the address chain, the user should delete the off block instead of reserving it.

Important WLED caveat: `ledmap.json` primarily stores coordinates, not a guaranteed "always off" behavior. For WLED-native effects, inactive rows may need follow-up segment or preset support to force those addresses off. The first implementation should make the project model and Lightweaver preview/live output correct, then clearly label this limitation in export UI.

## Stacking

Stacking should be allowed deliberately. Multiple patches may reference the same coordinates or source range. Export should keep duplicate coordinates because they represent different physical LED addresses.

The UI should make stacking visible:

- show badges on stacked LEDs
- include stacking in the preflight panel
- allow explicit "duplicate as stacked patch" actions
- avoid treating every duplicate as an error

## Preflight And Warnings

Add a Patch Board preflight panel before export and before hardware verification.

Show warnings for:

- missing source layer or strip references
- patch endpoints outside the current LED count
- overlapping source ranges
- duplicate or stacked coordinates
- unmapped physical LEDs
- off blocks that reserve addresses
- reversed patches
- jumps between distant coordinates
- physical map unlocked
- groups with mixed pattern overrides
- estimated power over configured budget

Warnings should explain consequence. Example: "Layer 7 LEDs 2-10 is used twice, so those coordinates will be stacked in export."

Warnings should not block export unless the map is broken enough to produce misleading output, such as missing source data for all rows.

## Performance Mode

Mapping and performance are different jobs. Add a simplified **Performance** or **Live Control** mode after the Patch Board exists.

Performance Mode should show groups as the primary controls:

- group on/off
- brightness
- speed
- effect/pattern
- color/hue
- selected patch overrides

It should hide setup-heavy controls like source endpoints unless the user explicitly enters edit mode.

This gives the installation operator a clean surface during a show or gallery run while preserving the full mapping power in setup.

## Power Budget

Add a basic power estimate per project, group, and patch.

Inputs:

- LED type
- voltage
- estimated current per LED at full white
- configured power supply amperage
- brightness limits

Outputs:

- max theoretical current
- current estimate by group
- warnings when a scene could exceed the configured budget

This does not need to be perfect. A rough warning is valuable because LED installations fail physically when power planning is wrong.

## Patch Presets

Patch creation should include fast presets for common structures:

- split into equal chunks
- split every N LEDs
- split at selected LED
- alternating/every-other LEDs
- mirrored halves
- radial rings or layer groups from imported artwork
- duplicate as stacked patch
- add off block
- reverse every other patch for serpentine wiring

Presets should create ordinary patches, not a separate magic system. Users can edit the result after creation.

## Export Flow

Export expands the physical chain row by row.

For strip patches, the sampled pixel list is sliced inclusively from `startLed` to `endLed`. If `startLed > endLed`, the emitted source order is reversed.

For off patches, physical indexes are consumed and marked inactive. Lightweaver live output emits black for those indexes. Coordinate export includes deterministic coordinate entries for those addresses so total LED count and physical indexing stay stable. The export UI must explain WLED-native limitations.

If no Patch Board exists, preserve current behavior by generating one default patch per visible strip in current section order.

## Persistence

Project save/load and local autosave should include `patchBoard`.

Scenes should store group and patch playback state, but they should not rewrite the verified physical map unless the user is in setup mode.

## Error Handling

If a strip LED count changes, clamp saved patch endpoints to the new valid range and show a warning. Do not silently delete patches.

If a source layer or strip is deleted, keep affected patches in a broken state until the user removes or remaps them. This preserves recoverability after accidental edits.

If all physical rows are invalid, export should fail with a clear message instead of producing a misleading map.

If the physical map is locked and an action would change physical addressing, block it and explain that the user must unlock setup mode first.

## Testing

Add unit tests for Patch Board expansion:

- Layer 10 first in physical chain becomes global LED 0.
- forward patch `2 -> 10` emits nine physical LEDs in ascending source order.
- reverse patch `10 -> 2` emits nine physical LEDs in descending source order.
- adjacent patches `2 -> 10` and `11 -> 20` preserve physical continuity.
- duplicate patches produce duplicate coordinates with unique global indexes.
- off patches consume indexes and mark pixels inactive.
- default Patch Board matches current export behavior when no saved board exists.
- group playback inherits from global scene.
- patch playback overrides group playback.

Add UI or integration coverage for:

- project save/load preserves Patch Board data.
- autosave restores Patch Board data.
- dragging start/end handles snaps to actual LED indexes.
- physical lock blocks address-changing edits.
- group edits still work while physical map is locked.
- preflight warnings appear for overlap, stacking, broken references, off blocks, and unlocked physical map.
- Verification Mode can step through addresses and highlight matching canvas dots.

Manual verification:

- Import an SVG with at least ten layers and make Layer 10 first in the physical chain.
- Export and confirm Layer 10's first sampled LED is global index 0.
- Split one layer into `2-10` and `11-20`, then reorder the patches.
- Reverse one patch and confirm canvas arrow, preview, and export agree.
- Add an off block and confirm those addresses are hidden in preview and black in live output.
- Stack two patches over the same range and confirm both physical addresses are exported.
- Lock the physical map and confirm performance controls remain editable.
- Run a hardware address chase and confirm the lit LED matches the highlighted canvas dot.

## Out Of Scope

The first implementation should not support unlimited nested groups. Use one group level plus patch overrides.

The first implementation should not try to solve every WLED-native off/segment behavior. It should make the Lightweaver project model, preview, live output, and coordinate export truthful, then expose WLED-native limitations clearly.

Automatic physical-wire-length calculation between jumped areas is out of scope. Jumps are intentional mapping documentation unless the user adds explicit off blocks.

Automatic camera-based LED calibration is out of scope. Verification Mode is manual and address-driven.
