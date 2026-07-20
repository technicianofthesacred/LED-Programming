# Wire and Test & Install redesign

## Goal

Make the two layout modes describe the real workflow:

1. **Wire** defines the installation.
2. **Test & Install** verifies the physical LEDs and saves the verified configuration to the Lightweaver card.

The current Draw interface becomes the visual and interaction source of truth. Test & Install must look like the same panel, not a separate workflow layered into the inspector.

## Approved direction

The user selected the single-next-action layout shown as option A in the visual companion.

- Rename the visible **Draw** mode to **Wire**.
- Rename the visible **Wire** mode to **Test & Install**.
- Preserve the current first mode's behavior. Internal component names may remain unchanged when renaming them would add risk without changing the user experience.
- Rebuild the second mode around a read-only summary of the plan from Wire and one primary next action.
- Pull all visual cues from the current Draw panel.

## Ownership boundary

### Wire owns the plan

Wire remains the only normal place to define:

- strips, paths, names, lengths, LED counts, and reel density;
- GPIO assignments and output grouping;
- first-to-last strip order on each GPIO;
- drawn path direction and physical data direction;
- the first LED or connector seam;
- adding, duplicating, and removing strips.

Test & Install reads this state. It must not present a second general-purpose editor for it.

### Test & Install owns commissioning

Test & Install is responsible for:

- showing the configuration that will be tested;
- checking the physical output, strip direction, endpoint, and LED count;
- confirming the strip color order;
- recording physical verification and locking the verified configuration;
- saving the verified project to the card;
- safely testing an installed wiring change and rolling it back when necessary;
- exposing exceptional installation and troubleshooting tools without placing them in the main flow.

## Test & Install idle layout

The default panel contains three elements in this order.

### 1. Compact heading

Use the same panel-heading treatment as the current LED strips section in Wire.

- Title: **Test & Install** or a short state-specific label such as **Ready to test**.
- Metadata: strip count, total LED count, and the phrase **from Wire**.
- Avoid stat tiles, step rails, explanatory cards, and repeated headings.

### 2. Read-only wiring summary

Render the same compact structure used by the current Draw strip list:

- one GPIO group header per output;
- GPIO number at the left and **first → last** at the right;
- numbered strip rows with the same dot, name, and LED-count alignment;
- the same background, border, radius, spacing, typography, and muted metadata colors.

The summary is deliberately read-only. It contains no GPIO selectors, LED-count inputs, reorder handles, IN/OUT ports, remove buttons, or direction buttons.

When the plan is incomplete, replace the commissioning action with one clear message and an **Edit in Wire** action that switches back to Wire.

### 3. One next action

Only the next required action is primary:

1. **Start LED check** when the plan is complete but unverified.
2. The active LED-check question while checking.
3. The color-order question immediately after the physical check.
4. **Save to card** after all checks pass.
5. A concise installed confirmation after the save succeeds.

Do not display a full checklist or several disabled future actions. The interface advances by replacing the current action.

## LED-check flow

Reuse the existing physical test behavior while simplifying its presentation.

- Show one question at a time in the same panel width and visual language as Wire.
- Keep the blue-first, green-middle, red-last illustration when it helps answer the question.
- Put correction controls under **Something's wrong**, only after the test reveals a mismatch.
- Direction and LED-count corrections update the canonical Wire plan and invalidate prior verification.
- After physical verification, continue directly into color-order confirmation instead of returning to a menu.
- Completing both checks records verification and makes Save to card the next action.

If the card is unavailable, explain the connection problem beside the action. Do not expose mapping editors as the recovery path.

## Save-to-card flow

Keep the existing installation safety behavior:

- package the current canonical wiring and controller configuration;
- stage wiring changes before committing them;
- run the timed physical confirmation when the card reports a staged change;
- confirm the new wiring only when the expected lights are visible;
- otherwise restore the last working setup;
- preserve the local installer or JSON handoff recovery for browsers that cannot reach the card directly.

The user should experience this as the final part of Test & Install, not as a separate card-shaped subsystem.

## Advanced installation tools

Place one collapsed **Advanced installation tools** disclosure after the primary flow. It is closed by default and visually secondary.

It may contain:

- **Find my LED wire** for identifying an unknown physical GPIO;
- **Assembly map** for viewing or printing the installation reference;
- **Download WLED map** as a secondary export;
- **Custom mapping** for exceptional split runs, cable jumps, reserved LEDs, fixed directions, and custom source ranges;
- **Card hardware** for power-supply assumptions and physical controller-pin assignments until those settings have a dedicated hardware-settings destination.

Custom mapping must not recreate the current general data-wire editor. Normal GPIO, strip order, LED count, data direction, and first LED remain owned by Wire. Advanced controls should appear only for the exceptional object or condition they can change.

## Remove from the normal Test & Install interface

- editable Data wire mapping lanes;
- duplicate LED-output GPIO selectors;
- output and run drag handles;
- IN/OUT connection ports for normal strips;
- normal strip LED-count steppers;
- normal physical DATA IN selectors;
- normal source-range inputs;
- duplicate connector-seam inputs;
- open-by-default Board pins and Expert mapping sections;
- explanatory copy for hardware features that are not active;
- stat-tile summaries and the old Check/Install step rail.

## Visual system

The current Draw panel is the direct reference. Reuse its existing classes or extract narrowly shared primitives where that avoids duplication.

- Match the GPIO group header and compact strip row exactly.
- Match its panel headings, metadata placement, borders, corner radii, row heights, spacing, and monospaced labels.
- Use the existing orange accent only for the active mode and primary action.
- Keep secondary controls dark and quiet.
- Avoid nested cards and large bordered sections.
- Preserve the inspector's current responsive behavior and touch targets.

No new palette, typography scale, or competing component family is introduced.

## State and data flow

The canonical project wiring remains unchanged:

1. Wire mutations update `wiring`, `strips`, and the standalone controller configuration.
2. Test & Install derives its summary from compiled wiring and strip data.
3. Hardware checks may apply explicit corrections to that same canonical state.
4. Verification belongs to the physical wiring state and is invalidated by later physical changes.
5. Save to card serializes the verified canonical state.

There must be no copied Test & Install form state that can drift from Wire.

## Error handling

- Incomplete plans identify the exact missing requirement and link back to Wire.
- Compile errors use plain language and do not reveal internal run identifiers.
- Card connection failures preserve the current project and offer retry or the existing safe handoff.
- A failed staged wiring test restores the prior working configuration.
- Power warnings appear only when the estimate exceeds the configured safe supply capacity.
- Advanced mutation errors remain beside the advanced tool that caused them.

## Verification

Automated coverage must confirm:

- the mode labels read **Wire** and **Test & Install**;
- the first mode retains all current setup behavior;
- Test & Install renders GPIO groups and strip order from canonical wiring;
- the summary has no duplicate normal editing controls;
- incomplete wiring returns the user to Wire;
- the LED check advances into color confirmation and then Save to card;
- verification is invalidated after a physical correction;
- staged card wiring can be confirmed or rolled back;
- advanced tools are closed by default and retain their specialist behavior;
- existing layout-mode, wiring, card-send, and responsive tests pass.

Visual verification must compare both modes on the actual Layout screen at desktop inspector width and the narrow/mobile sheet width. Their spacing, typography, group headers, rows, and control density should visibly belong to one system.

## Out of scope

- Changing the ESP32 runtime contract.
- Adding Raspberry Pi behavior.
- Building a new settings architecture.
- Reworking the visual design of the first mode beyond the visible label change and narrowly shared styling extraction.
- Expanding the custom-mapping feature set.
