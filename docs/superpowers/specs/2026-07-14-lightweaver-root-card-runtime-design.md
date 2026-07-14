# Lightweaver Root Studio and Reliable Card Save Design

**Date:** 2026-07-14  
**Status:** Approved for implementation planning

## Outcome

Lightweaver Studio is served directly at `https://led.mandalacodes.com/`. The obsolete `/design` mount is removed rather than maintained as a second public route. A normal playlist, including the reported 19-look project, saves to the current ESP32 card without deleting looks or exceeding the firmware's 3,968-byte NVS string limit. Clicking a pattern establishes the local card bridge automatically when browser security requires one and then performs the requested preview.

## Confirmed root causes

### Oversized card configuration

The reported card error was reproducible from the Studio runtime builder. A one-strip project with 19 standard playlist entries produced 4,568 bytes, effectively matching the card's reported 4,562-byte payload. The firmware correctly rejected it because one ESP-IDF NVS string is limited to 3,968 bytes.

The payload duplicated the same runtime choices in `patterns` and `looks`. It also serialized fields whose values equal firmware defaults, including FPS, loop, fades, and brightness. The Studio project itself is valid; the transport representation is unnecessarily verbose.

### `/design` deployment mount

Production currently runs `vite build --base=/design/`, stages the bundle under `.pages/lightweaver/design`, and redirects `/` to `/design/`. The route is therefore intentional deployment behavior rather than a browser defect.

### Manual bridge warning

The hosted Studio is HTTPS while the card is a private-network HTTP origin. Browsers do not permit the public page to silently fetch or frame arbitrary local HTTP resources. The repository already has a secure opener/parent `postMessage` bridge, but Patterns surfaces a manual instruction when that bridge is missing or has not completed its handshake. The existing pattern click is a user gesture and can legally initiate the one required local card window.

## Design

### 1. Root-domain Studio

- Build the production Studio with base `/` and stage the Vite output at the Pages artifact root.
- Route `/*` to the root `index.html` so hash-based Studio screens work at the canonical domain.
- Remove `/design`, `/design/`, and `/design/*` deployment routes. They are not a supported compatibility surface.
- Serve the visitor page and factory firmware from root-relative paths.
- Update deployment tests, production-freshness checks, runbooks, firmware links, fallback links, and workflow comments so `/` is the only source of truth.

Success means entering `https://led.mandalacodes.com/` loads Studio directly and all generated Lightweaver links target root-domain query parameters and hashes without inserting `/design`.

### 2. Compact card-storage payload

Add one pure serializer for card persistence. Studio's rich in-memory project and runtime package remain unchanged; only the payload sent to the firmware is compacted.

The serializer will:

- retain every enabled look and preserve playlist order;
- retain piece identity, LED outputs, GPIO assignments, controls, zones, and startup look;
- omit `patterns` whenever `looks` is present because firmware reads `looks` first and only uses `patterns` as a legacy fallback;
- omit fields whose absence produces the same firmware default;
- retain non-default values and all combo-zone values;
- measure the UTF-8 byte length of the exact compact JSON;
- reject before opening the installer or sending a request when the compact payload still exceeds 3,968 bytes, with an exact size and actionable explanation;
- never silently delete, truncate, or reorder looks or zones.

The same serializer must be used by direct HTTP save, card-bridge save, encoded installer handoff, downloadable card configuration, and any size preflight. This prevents one path from succeeding while another sends the older verbose representation.

For the reported 19-look standard playlist, compaction must fit below the card limit on existing firmware. No card reflash is required for this fix because the firmware already supplies the omitted defaults while parsing.

### 3. Automatic card bridge from Patterns

Patterns will treat bridge establishment as part of the requested pattern click:

1. If Studio already has a verified parent or opener bridge, use it immediately.
2. If local-card preview is enabled but no bridge exists, synchronously open the named local card bridge window from the pattern click's user gesture.
3. Wait for the bridge-ready handshake, return focus to Studio when the browser permits, then replay the originally selected pattern once.
4. Coalesce concurrent clicks so only the newest selected pattern is replayed and only one bridge window is opened.
5. Reuse the verified bridge for later previews and saves.

The manual warning is shown only when the popup was blocked, the card did not answer before timeout, the card URL is not a trusted local origin, or the bridge window was closed. The warning must describe that concrete condition and provide one recovery action.

This automation does not weaken origin validation. Privileged messages still target only the normalized local card origin and require the existing verified bridge protocol.

### 4. Error behavior

- A rejected card save leaves the last working card configuration untouched.
- A failed bridge handshake does not mark a preview as delivered.
- A superseded preview does not replay after a newer pattern selection.
- A compact-payload overflow reports exact bytes before navigation or network transfer.
- If an old card firmware lacks the required bridge protocol, Studio directs the user to Flash rather than repeatedly opening windows.

## Test design

### Card payload

- Reproduce a 19-look, one-strip configuration that exceeds 3,968 bytes before compaction.
- Prove its compact payload is below 3,968 bytes.
- Round-trip the compact payload through firmware-default semantics and verify look order, pattern IDs, output layout, controls, and startup look.
- Verify non-default fades, brightness, FPS, loop values, and combo-zone fields survive.
- Verify a genuinely oversized compact combo configuration fails before direct, bridge, and handoff transmission.

### Bridge

- Parent/opener bridge previews without a manual warning.
- First standalone pattern click opens one named bridge window and automatically retries the selected preview after readiness.
- Popup blocking and handshake timeout produce distinct recovery messages.
- Rapid pattern changes replay only the newest selection.
- Privileged origin checks remain enforced.

### Deployment

- Production build assets use `/` as their base.
- Pages staging places `index.html`, assets, firmware, headers, and redirects at the artifact root.
- `/` loads Studio, `/design` is absent from staged routing and generated links, and firmware downloads from the root path.
- Desktop and phone smoke tests cover Layout, Patterns, Flash, and the card bridge entry point.

## Release and verification

1. Run focused unit and browser tests, then `npm run launch:check`.
2. Rebuild and commit factory firmware only if firmware source changes. This design is expected to require Studio changes only.
3. Deploy a Pages preview and validate the root-only URL, absence of `/design` in generated links, compact 19-look handoff, and automatic bridge.
4. Merge through `main` and wait for the production deployment gate.
5. Verify the live domain in a fresh browser session and compare the public firmware hash with the committed binary.
6. Perform one real-card save and pattern-preview check. Confirm the card accepts the 19-look configuration, restarts when required, and responds to subsequent pattern clicks without the manual bridge instruction.

## Non-goals

- Migrating card configuration from NVS to LittleFS or chunked storage.
- Increasing the firmware's 32-look or 10-zone runtime limits.
- Silently limiting playlists.
- Removing private-origin validation or bypassing browser security controls.
