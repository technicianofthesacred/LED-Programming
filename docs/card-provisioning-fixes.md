# Card Provisioning Fixes — Implementation Plan

## Fix 1: Card Silent-Drop Detection

### Problem
After pairing a card and marking it "ready," Studio never re-checks it. If the card loses power, reboots, or the WiFi drops, Studio still claims the card is paired and ready. When the user tries to control it, the command fails silently.

### Solution
Add idle-time keepalive polling to the direct HTTP connection path. Once a card is paired and "connected-direct," poll `/api/status` every 20 seconds. If the card stops answering, demote from "connected-direct" to "reconnecting" and surface the reconnect state to the user.

### Implementation
- Update `createCardLink` to add a direct-transport keepalive timer that mirrors the bridge ping behavior
- On each successful poll while connected-direct, reschedule the timer
- On each missed poll, increment a miss counter; after 2 misses, dispatch 'direct-ping-missed'
- Surface "Card stopped answering" in the footer and offer a one-click reconnect
- Tests in `lightweaver/tests/card-link-state.mjs` verify the keepalive behavior

### Files to change
- `lightweaver/src/lib/cardLink.js` — add direct keepalive loop
- `lightweaver/tests/card-link-state.mjs` — add tests for direct ping behavior

---

## Fix 2: Post-Flash Heartbeat Verification

### Problem
After Web Serial firmware write completes, the installer claims success without checking that the card is actually alive. The card could have died mid-flash or hit a corruption bug.

### Solution
After Web Serial write, wait for the card to respond over HTTP (via the new AP) before claiming success. If the card doesn't answer within 30 seconds, fail the install and ask the user to retry or recover.

### Implementation
- Modify `CardCommissioningPanel` to spin up a background poll after Web Serial write
- Poll `http://192.168.4.1/api/status` (the card's default AP address) with a 30-second timeout
- If card answers with correct identity, mark install as verified
- If timeout, show "Card not responding after install — check USB connection and try again"
- Tests verify the post-flash poll behavior

### Files to change
- `lightweaver/src/components/card/CardCommissioningPanel.jsx` — add post-flash poll
- `lightweaver/tests/card-workspace.spec.ts` — add tests for post-flash verification

---

## Fix 3: Factory Default Light Check on First Boot

### Problem
The card boots to factory firmware with a default GPIO pin (often 0, which the customer hasn't wired to anything). Commands reach the card but light nothing. User thinks the card is dead.

### Solution
On first boot to factory defaults, the card should cycle through all GPIO outputs briefly so the customer can see which one lights their strip. Once the customer identifies the GPIO, they can tell the card via the captive portal.

### Implementation
- Firmware: Add a "test all GPIOs" routine on first boot (detect factory defaults via NVS check)
- Each GPIO gets 500ms at 50% brightness, then moves to the next
- Captive portal shows: "Which GPIO lit your strip? [1] [2] [3]"
- User's selection is stored and used going forward
- Studio queries this GPIO when sending test patterns
- Tests verify GPIO detection works end-to-end

### Files to change
- `firmware/lightweaver-controller/src/LightweaverWeb.cpp` — add first-boot GPIO test
- `firmware/lightweaver-controller/src/main.cpp` — integrate into initialization
- `lightweaver/src/components/card/CardCommissioningPanel.jsx` — parse GPIO detection response

---

## Fix 4: Wiring Readback Verification

### Problem
Studio sends a project (zones, wiring) via `POST /api/config`, but never reads it back to confirm the card persisted it correctly.

### Solution
After `POST /api/config`, immediately call `GET /api/firmware-info` and check that the returned `projectFingerprint` and `projectRevision` match what was sent. If not, the card didn't persist correctly.

### Implementation
- Modify `lightweaver/src/components/card/CardStatusControl.jsx` (or relevant control component)
- After config POST succeeds, add a GET firmware-info call
- Compare fingerprint + revision
- If mismatch, show "Project installation failed — please try again"
- If match, proceed to light-check flow
- Tests in `lightweaver/tests/card-workspace.spec.ts` verify readback

### Files to change
- `lightweaver/src/lib/cardLink.js` — add helper for config + readback verification
- `lightweaver/tests/card-workspace.spec.ts` — add tests

---

## Implementation Order

1. **Card silent-drop detection** — lowest complexity, highest impact
2. **Wiring readback verification** — low complexity, medium impact
3. **Post-flash heartbeat** — medium complexity, high impact
4. **Factory default GPIO test** — medium complexity (requires firmware), high impact

---

## Testing Strategy

All fixes will be tested:
- **Unit tests** (Jest) for pure functions and state machines
- **Integration tests** (Playwright) for end-to-end flows on mocked cards
- **Hardware verification** — flash a real card and drive through the full flow
- **Checklist verification** — print the new checklist and hand it to a non-engineer

