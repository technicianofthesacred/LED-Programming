# Lightweaver Card Control Drawer — Design

**Date:** 2026-08-09  
**Status:** Approved in conversation

## Goal

Keep Lightweaver Studio visually and navigationally stable while a connected card is being controlled. Customers must be able to tune the installed artwork without seeing installation, wiring, firmware, or destructive maintenance controls. The standalone page served by the ESP32 remains a customer-facing control surface and must clearly identify itself as running on the physical card.

## Chosen interaction

The connected-card control in Studio opens a native right-side drawer. Studio remains visible behind it; no new browser tab, window, or full-screen card page is introduced for routine control.

The drawer is implemented in Studio and communicates through the existing verified local-card bridge. It does not embed `lightweaver.local` in an iframe. An HTTPS Studio cannot reliably embed an HTTP private-network page across browsers, and an iframe would duplicate navigation and origin identity inside Studio.

## Customer-safe drawer scope

The drawer exposes only controls that change the current look without changing hardware or installation identity:

- current pattern/look and pattern selection;
- previous and next pattern;
- brightness;
- speed;
- hue shift;
- blackout and restore;
- basic creative tuning supported by the selected look: color, palette, breathe, and drift;
- an **Advanced editing** action that opens the appropriate full Studio pattern editor in the same Studio tab.

The drawer never exposes:

- GPIO, strip count, chipset, color order, current limit, or wiring order;
- Wi-Fi credentials or hostname changes;
- firmware installation or downgrade controls;
- project installation, activation, rollback, factory reset, reboot, or storage operations;
- Pattern Lab code or other technician-only authoring tools.

Unsupported tuning controls are omitted for a pattern rather than rendered as ineffective controls.

## Surface identity

Both ESP32-served card pages show a prominent **On this Lightweaver card** badge immediately below the Lightweaver/piece heading. This distinguishes local card controls from the public Studio.

Studio’s drawer identifies the exact connected card by name and connection state. It does not pretend that card-served content is part of the public site; it labels all live controls as acting on that card.

## Navigation and handoff

Routine control starts and ends inside Studio’s drawer.

When a card page was opened by a verified Studio bridge tab, **Edit in Studio** and **Open Lightweaver Studio** navigate that exact opener to the bounded canonical Studio route and then focus it. Bounded `editPattern` or `editLook` intent is preserved. The card page must not merely call `focus()` and discard the requested route.

When a customer opened the card page directly, the canonical Studio fallback may open one Studio tab because the card page must remain available as the local bridge. The card page gives visible feedback if that tab is blocked. It never accepts an arbitrary callback origin or URL.

**Advanced editing** inside the Studio drawer uses Studio’s internal router and therefore never opens another tab.

## Data and command flow

1. Studio accepts only an already verified card-link authority.
2. Opening the drawer requests the current read-only zones/status snapshot through the verified direct or bridge transport.
3. The UI renders the last confirmed card state.
4. A customer action sends the existing bounded local control command.
5. The drawer accepts success only when the card returns authoritative applied-state evidence.
6. Failure rolls the UI back to the last confirmed value and offers a retry; it does not leave optimistic state visible.
7. Link loss disables mutations, preserves the last confirmed display, and offers reconnect through the existing Connection Center.

The drawer does not add a cloud command path. Commands remain browser-to-card on the LAN.

## Layout and accessibility

- Desktop: right-side drawer, sized to keep enough Studio context visible.
- Phone: full-height bottom sheet using the same content hierarchy; it remains visibly part of Studio through its header and close action.
- Drawer title names the card and includes a live connection indicator.
- Every slider has a visible label and value.
- Pattern and blackout controls expose pressed/current state.
- Focus moves into the drawer when opened, remains trapped while open, returns to the invoking control when closed, and Escape closes it.
- Live errors are announced without moving focus.

## Verification

Automated coverage must prove:

- the footer/card action opens one drawer and no popup;
- safe controls use the verified card transport and authoritative acknowledgements;
- failed commands roll back and retry safely;
- link loss disables mutations and reconnects through the existing flow;
- advanced editing changes the current Studio route without opening a tab;
- no wiring, Wi-Fi, firmware, install, reset, or reboot controls appear in the drawer;
- desktop and phone layouts do not overflow and meet keyboard/focus behavior;
- both card-served pages include the physical-card identity badge;
- a verified card-page opener is navigated to the safe requested Studio route with bounded edit intent;
- direct card-page fallback remains pinned to `https://led.mandalacodes.com`.

Real-card verification must confirm the controls visibly change the attached strip and the card page is unmistakably identified as local. The hardware gate remains human-observed and is never inferred from automated tests.

## Out of scope

- Embedding the HTTP card page in Studio.
- Replacing the standalone customer card page.
- Cloud commands, Raspberry Pi runtime work, OTA updates, or remote access.
- Redesigning Studio’s full pattern editor or Card installation workflow.
