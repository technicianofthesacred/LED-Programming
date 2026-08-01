# Kaleidoscope Compact Footer Design

## Goal

Reduce the Kaleidoscope calibration footer to one normal line while making the completion action explicit.

## Approved interface

The normal footer is one compact row:

`Preview off    Connect    Save & close`

When physical calibration is reaching the card:

`Preview live              Save & close`

A small status dot accompanies the preview label. The footer uses the existing subdued status, secondary button, and accent action styles.

## Content changes

- Remove the standalone **Custom spacing** label. The per-point LED values already show calibrated spacing.
- Remove the standalone red-marker instruction. The fine-tune controls and visible canvas markers already communicate the interaction.
- Shorten the calibration delivery message to **Preview off** or **Preview live**.
- Show **Connect** only when physical preview is unavailable. Its accessible name and title remain **Connect card for live preview**.
- Keep validation, reset, and connection errors outside the compact row. Exceptional messages may use a second line rather than being hidden.

## Save and close behavior

**Save & close** does not create a persistent lock flag. Kaleidoscope edits already save into project state as they are made.

Pressing **Save & close**:

1. Ends the Kaleidoscope editing session.
2. Stops the red physical calibration preview.
3. Removes the calibration markers from the canvas.
4. Collapses the Kaleidoscope panel.
5. Preserves all point-count, starting-point, and fine-tuning values.

The user can reopen the Kaleidoscope button later to edit the saved mapping.

## Responsive behavior

The footer remains one row in the normal Layout inspector. The status consumes flexible space, while **Connect** and **Save & close** keep compact touch targets. If the inspector becomes exceptionally narrow, the row may wrap to two lines, with **Save & close** remaining fully visible.

## Accessibility

- The preview text remains a polite live status.
- Status is not communicated by color alone.
- The connect action has an explicit accessible name describing the card and live preview.
- **Save & close** is keyboard reachable and names both effects.
- Focus and disabled states reuse existing Lightweaver controls.

## Verification

- Browser coverage proves the normal footer has no Custom spacing or red-marker instruction.
- Browser coverage proves unavailable and live preview states render the correct compact actions.
- Browser coverage proves **Save & close** hides the editor and its canvas markers while preserving mapping data after reopening.
- The footer is visually checked in the actual Layout inspector and at the narrow breakpoint.
