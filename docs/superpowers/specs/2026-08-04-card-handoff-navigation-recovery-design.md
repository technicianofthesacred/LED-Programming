# Card Handoff Navigation Recovery Design

## Problem

During Wi-Fi commissioning, Studio retargets its already-authorized named card
tab from the card AP to the exact station IP. If the browser is not yet back on
gallery Wi-Fi, it can retain a blank network-error document at the station URL.
Studio currently retries that exact navigation only on a fixed timer sequence
whose total duration is about 130 seconds, while firmware keeps the correlated
handoff recoverable for five minutes. Background timer throttling can further
reduce the effective retry opportunities.

The observed incident reached the correct station IP and correct signed
firmware, but the firmware entered `handoff-abandoned` without receiving the
station-origin acknowledgement. A new direct navigation rendered the complete
card page immediately. This isolates recovery to Studio's cross-network
navigation lifecycle rather than firmware packaging or HTTP serving.

## Chosen Design

Studio will keep the existing exact card-tab navigation recovery active for the
full five-minute firmware handoff window. The recovery remains bound to the
same `cardId`, firmware version, build ID, boot ID, handoff generation, station
host, flow ID, named `WindowProxy`, and Studio lifecycle that authorized the
original retarget.

In addition to bounded scheduled retries, Studio will retry immediately when
the browser reports `online`, when the Studio window regains focus, and when
the document becomes visible. These signals do not grant authority or send a
card command; they only repeat navigation of the already-authorized target to
the already-validated local station URL.

The verified card-page ready handshake cancels all scheduled and event-driven
recovery. Recovery also cancels when the target closes, the owner window or
flow changes, or any correlation field changes. The existing exact-origin
allowlists, fresh status reads, two-envelope identity verification, and
fail-closed mutation gates remain unchanged.

## Scope

- Modify `lightweaver/src/lib/cardBridge.js` to own a five-minute navigation
  deadline, lifecycle event listeners, and unified retry/cancellation cleanup.
- Extend `lightweaver/tests/card-bridge-handoff.mjs` with deterministic contract
  tests for the full recovery window, immediate online/focus/visibility retry,
  successful-handshake cancellation, stale-correlation cancellation, and the
  absence of configuration or acknowledgement requests before verification.
- Do not change firmware, Wi-Fi credentials, project state, card identity,
  origin allowlists, bridge protocol messages, or command authorization.
- Do not add cloud transport, OTA, discovery scanning, or a new UI flow.

## Error Handling and Safety

Navigation assignment failures remain non-fatal and recoverable until the
deadline. Every retry rechecks the exact owner, target, host, flow, and complete
handoff correlation before navigation. When the deadline expires, Studio stops
retrying and leaves the existing connection state machine to present recovery;
it never acknowledges, configures, resets, or flashes the card automatically.

## Verification

The regression test must fail on the current 130-second timer-only behavior
before implementation. After the change, focused bridge, link, connection, and
readiness tests must pass, followed by the relevant Lightweaver test suite and
production build. Hardware validation still requires commissioning a physical
card while deliberately delaying the gallery-Wi-Fi switch and while
backgrounding Studio, then proving the same card boot reaches verified station
state without manually refreshing the card tab.
