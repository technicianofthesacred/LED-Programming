# Unified Card Workspace Design

**Status:** Implemented; amended 2026-07-18
**Date:** 2026-07-17
**Surface:** Public Lightweaver Studio at `led.mandalacodes.com`

> **Current amendment:** The original consolidation proved that Card should be
> immediate and visible, but it grouped two different jobs. Normal artwork
> setup now follows Connect → Layout → Looks → Playlist → Install/verify →
> Save/export. **Batch production** is a separate manufacturing mode, with the
> existing production route and safety contracts preserved. Layout/Wire is the
> only physical-layout and output-routing editor; Card presents its summary and
> an **Edit in Layout** link. Project persistence is one consolidated area, and
> install handoffs reuse the one required local-card/Bridge tab. See the
> [release-first roadmap](../../roadmap.md#phase-1-finish-the-product-already-on-main--required-now)
> for execution order.
>
> **2026-07-18 evidence addendum:** the audited scope of the amendment is
> recorded in
> [the release-coherence findings](../plans/2026-07-18-release-coherence-findings.md).
> Concretely: the "workshop" section leaves the visible section bar (its route
> stays valid); the section-bar labels become Card, Install or update, Card
> settings, Advanced & Support, Preferences; Batch production is reachable via
> `#screen=production`, `#screen=card&section=workshop`, an Advanced & Support
> tile, and a low-emphasis overview link; Card settings replaces its layout and
> output-routing editors with a read-only summary and **Edit in Layout**; the
> canonical export extension is `.lw.json`; "Save to card" is the single verb
> for the acknowledged config write; the overview connect action opens the
> guided Connection Center. The Web Serial secure-installer escape remains a
> browser-security requirement, with its window target named and its reason
> visible.

## Problem

Studio currently presents four overlapping destinations: Flash, Installer, Production Setup, and Settings. Their labels expose implementation history instead of the user's job, and the ordinary setup path is hidden behind extra navigation and disclosures. Playlist rows also expose Up, Down, Make first, and Remove even though drag ordering and compact controls are already available.

## Outcome

The rail has one **Card** destination in place of Flash, Installer, Production Setup, and Settings. Selecting Card opens the complete card workspace immediately. The primary action map is visible on the page, not in a dropdown or disclosure.

The workspace keeps the existing signed-firmware, card-identity, Web Serial, local-network, project-write, and production-record safety contracts. This change consolidates their presentation; it does not weaken them or introduce a new hardware path.

## Information Architecture

The Card workspace has a persistent, visible section bar:

1. **Card**: status-aware overview and the next recommended action.
2. **Install or update**: the existing verified automatic installer.
3. **Card settings**: connection, hardware, output routing, dial, and project-to-card controls.
4. **Workshop setup**: the existing identity-bound production workflow and pass records.
5. **Advanced & Support**: technician firmware controls, logs, GPIO reference, raw JSON, and recovery guidance.

These are sections of one destination, not separate rail items. The section bar remains visible while moving among sections. Primary setup choices are never placed in a dropdown.

## Status-Aware Overview

The Card overview leads with what Studio detects and what happens next:

- **No card detected:** show the connection state and the ordered path Connect, Install, WiFi, Load project, Test. The first actionable step is primary.
- **Existing card detected:** show its identity and connection status, then offer Update, Load changes, and Verify without forcing a reinstall.
- **Ready:** show a compact ready summary with direct actions for card settings, loading changes, testing, and support.
- **Failure or recovery:** state what was detected, what was left unchanged, and one safe next action. Existing bounded recovery components remain authoritative.

The overview may reuse the existing card-link and production state machines. It must not infer that a card is safe to mutate from browser connectivity alone.

## Preferences and Project Files

Non-card preferences and project-file actions remain available from the top bar. A top-bar **Preferences** control opens the Preferences section inside the Card workspace. Existing New project, Load project, Download file, and Save project actions remain in the top bar.

Theme, rendering, project defaults, palette, and browser project-library controls are not presented as card setup steps. Card hardware, connection, output routing, dial, and card JSON remain in Card settings or Advanced & Support.

## Legacy Links

Existing links remain valid aliases and land on the matching Card section:

| Legacy route | Card section |
| --- | --- |
| `#screen=flash&mode=install` | Install or update |
| `#screen=flash` | Advanced & Support, technician firmware |
| `#screen=installer` | Advanced & Support, install guide and GPIO reference |
| `#screen=production` | Workshop setup |
| `#screen=settings` | Preferences |

The public secure-installer URL and job deep links are compatibility contracts. They may retain their legacy address while rendering the unified workspace. New in-product navigation emits `#screen=card&section=...` links. An active firmware install remains navigation-locked exactly as it is today.

## Playlist Row Controls

Each playlist row exposes only:

- a drag handle;
- **Live**;
- **Copy**;
- **×**.

Up, Down, Make first, and Remove text buttons are removed. Dragging the handle reorders rows. When the handle has keyboard focus, Arrow Up and Arrow Down move the row one position; Home and End move it to the first or last position. A polite live region announces the new position.

The × control removes the row immediately because looks can be added again from the source list. It has an item-specific accessible name such as `Remove Ocean`, a matching title, and a minimum usable hit target. The visible label is only `×`.

## Accessibility and Responsive Behavior

- Card sections use ordinary buttons or links with `aria-current`; they do not use menu semantics.
- Focus moves to the selected section heading after section navigation.
- Existing installer and production live regions, progress semantics, and recovery focus behavior remain intact.
- Playlist drag state is not the only indication of order; numeric positions and keyboard announcements remain visible or audible.
- At narrow widths, the Card section bar wraps or scrolls horizontally without hiding actions, and playlist controls remain operable without horizontal page overflow.
- Reduced-motion behavior remains unchanged.

## Verification

Automated coverage must prove the single rail destination, visible Card section bar, status-aware overview, legacy route aliases, install navigation lock, unchanged production safety flow, top-bar Preferences access, playlist pointer and keyboard reordering, and item-specific × label.

The finished work must also be inspected in the actual browser at desktop and narrow widths in both disconnected and ready-style states. Full source, production, build, staging, and page-artifact verification must pass before release.
