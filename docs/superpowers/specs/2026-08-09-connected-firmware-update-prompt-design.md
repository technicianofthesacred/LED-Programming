# Connected firmware update prompt

## Goal

When Studio has verified a connected card whose installed firmware is older than the signed production release, the connection panel must say so plainly and offer the safe update path. The footer must keep the card identity at the far left and group build/update controls at the far right, leaving intentional empty space between them.

## Connected-card prompt

- Show the prompt only when the existing verified firmware classifier reports `update-available` for the connected card.
- Place it below the connected card facts in the connection panel.
- Copy: `Your card firmware is out of date.` followed by `Installed build N; latest build M.`
- Offer `Update firmware` and `Not now`.
- `Update firmware` closes the connection panel and opens the canonical Card > Install section.
- `Not now` closes the panel and leaves the verified card connection unchanged.
- Neither action flashes, configures, restarts, or otherwise mutates the card. Installation begins only through the existing guarded installer workflow.
- Do not show an update action for disconnected, malformed, legacy, development, current, or release-unknown evidence.

## Footer layout

- Desktop and tablet: the compact card connection control is anchored left. Firmware status, the open Studio build, and Test strip form a compact right-hand group. Flexible empty space separates the two groups.
- Preserve DOM and keyboard order: Card, Firmware, Studio, Test strip.
- Phone: retain the existing two-row grid so all build identities stay visible without horizontal overflow; do not force the desktop spacer.
- The card control remains content-sized and truncates safely for unusually long card names.

## Data flow

`App` already owns the verified release identity, connected card identity, firmware classifier result, and canonical install navigation callback. It passes the bounded classifier result and update callback into `CardConnectionCenter`; the panel does not fetch release metadata or reclassify raw identities.

## Verification

- Browser test: outdated verified card shows exact installed/latest builds; update routes to Card > Install with zero hardware-operation events.
- Browser test: `Not now` closes the panel and preserves the connected link.
- Browser test: current, development, release-unknown, and disconnected states do not show the prompt.
- Footer test: at desktop width the card is left-aligned, the three controls are right-aligned, and a material gap separates the groups.
- Footer phone test: no horizontal overflow and all build identities remain visible.
- Existing focused classifier, connection-center, footer, production-retry, and production build gates remain green.
