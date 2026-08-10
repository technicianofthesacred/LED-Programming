# Inline Firmware Update Action

Date: 2026-08-10
Status: approved for implementation

## Outcome

When Connection Center has verified an exact card whose installed firmware is
older than the signed current release, the identity panel shows a quiet,
right-aligned **Update firmware** button on the Current row. The action makes
the safe update path immediately available without competing visually with the
primary **Enable live control** action.

## Interaction

- Keep Card, Installed, and Current as acknowledged facts.
- Right-align the Installed and Current version values in one consistent
  version column.
- Place a compact secondary **Update firmware** button immediately to the right
  of Current.
- On narrow screens, retain right-aligned versions and place the compact button
  at the right edge directly below Current.
- Clicking the button closes Connection Center and opens the existing canonical
  firmware installer for the exact card. It does not enable live control or
  start an update automatically.

## Safety and visibility

The action appears only when strict signed-release classification reports
`update-available`. It stays hidden for current, newer/development, unknown,
unverified, or disconnected firmware. Existing factory recovery and update
confirmation remain unchanged.

## Verification

Add a visible Chromium regression for the direct-connected state shown in the
owner screenshot. It must prove the quiet action is visible for an older exact
card, routes to the canonical installer, stays hidden for non-actionable
firmware states, and remains aligned at desktop and narrow widths. Run the
focused Connection Center test, production build, and a real rendered-screen
inspection.
