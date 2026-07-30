# Compact Captive Wi-Fi Setup Design

**Date:** 2026-07-31

**Status:** Approved for implementation planning

**Scope:** The ESP32 card's first-time captive Wi-Fi setup only

## Purpose

Make repeated card provisioning fit inside the Apple captive-login window and
small phone screens without shrinking readable text or useful touch targets.
The normal card control surface, Studio, Wi-Fi handoff protocol, and stored
configuration contract remain unchanged.

## Current problem

The setup page uses the same spacious shell as the full card interface:

- a 28px outer top inset and 28px header gap;
- duplicate `Lightweaver` text when the default piece name is shown;
- a heading plus explanatory paragraph before the first field;
- a full-width Rescan button on its own row;
- always-visible hidden-network and hostname fields;
- 14px to 20px vertical spacing repeated throughout the form.

The controls themselves are appropriately legible, but the surrounding chrome
makes the common Network, Password, Join task taller than the captive viewport.
The user must scroll while provisioning cards repeatedly.

## Approved direction: essential first

The initial setup surface contains, in order:

1. One `Lightweaver` heading.
2. A compact `Join Wi-Fi` section label.
3. Network selector and a compact Rescan button on one row.
4. Password field.
5. A collapsed `More options` disclosure.
6. `Save and join Wi-Fi` as the single primary action.
7. The existing live status or error message region.

`More options` contains:

- Hidden network name (optional).
- Hostname, defaulting to `lightweaver` as it does today.

The disclosure opens automatically when a completed scan returns no networks,
so a hidden network remains discoverable without requiring the user to infer
where recovery controls went. It may also be opened manually at any time.

## Layout and sizing

- Remove the right-side piece-name label in setup mode only. The live control
  surface retains its existing heading and piece identity.
- Replace `Set up` and its introductory paragraph with the shorter `Join Wi-Fi`
  label. The captive window title already says that the device is joining the
  named Lightweaver access point.
- Reduce setup-only outer, header, card, and field spacing. Do not globally
  increase the density of the live card interface.
- Keep form text at 16px to avoid automatic iOS focus zoom.
- Keep every interactive target at least 44 CSS pixels high.
- Allow the Network selector to consume the available row width; keep Rescan a
  compact, clearly labeled 44px-high secondary action.
- At narrow widths where the row cannot preserve usable controls, stack Rescan
  beneath Network without changing the rest of the compact layout.
- Respect `env(safe-area-inset-*)` while avoiding unnecessary bottom padding in
  setup mode.

The unopened common path must fit without document scrolling at the target
captive-window size shown in the supplied screenshot and at a 320x568 phone
viewport. Opening More options or displaying long post-submit diagnostics may
extend the document and scroll normally.

## Behavior and data flow

No API or persistence behavior changes.

- Network scanning still begins automatically and uses the existing bounded
  polling loop.
- Rescan restarts that loop.
- Manual SSID continues to override the selected scanned SSID when non-empty.
- Password and hostname are submitted through the existing `/api/wifi` request.
- The existing handoff-generation, boot identity, retry, and verification
  polling contracts remain intact.
- Existing status copy remains visible below the primary action. Long recovery
  messages are not truncated to force a fixed-height page.

The disclosure is presentation state only. It is open when the user opens it or
when a completed scan has zero results. A successful later scan may leave it
open rather than moving controls while the user is typing.

## Accessibility

- Use a native `details` and `summary` disclosure, or an equivalent button with
  correct `aria-expanded` and keyboard behavior.
- Keep explicit labels associated with Network, Password, Hidden network, and
  Hostname controls.
- Preserve visible keyboard focus for all controls.
- Announce scan and join results through the existing status region.
- Do not depend on color, placeholder text, or hover to explain a field.

## Verification

Automated checks must prove:

- setup mode emits one visible Lightweaver identity, the compact field order,
  and a More options disclosure;
- Hidden network and Hostname remain present and submitted through the existing
  contract;
- the zero-network path opens the disclosure;
- 16px input text and 44px minimum interactive heights are preserved;
- setup-specific compact styles do not alter the normal card surface;
- existing Wi-Fi handoff, project-preservation, web, and firmware source tests
  still pass;
- the ESP32-S3 firmware compiles and the production firmware artifact pipeline
  remains valid.

Visual verification covers the supplied Apple captive-login proportions,
320x568 phone portrait, a typical 390px phone, and desktop. Final hardware
acceptance is a first-time setup run on the card currently beside the user.

## Explicitly out of scope

- Changing the normal card control interface.
- Changing Wi-Fi credentials, retry timing, or transition semantics.
- Removing hidden-network or hostname support.
- Adding credential storage in the browser.
- Changing Studio or the public website.
- OTA delivery work. The current signed firmware installation path remains the
  way this captive-page change reaches a card.
