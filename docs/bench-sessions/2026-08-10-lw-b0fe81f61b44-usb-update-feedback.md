# Lightweaver Bench session

## Session

- Date/time and timezone: `2026-08-10 18:24:37 WITA`
- Operator: `Adrian Rasmussen`
- Behavior under test: `Visible phase acknowledgement after a preserving one-time USB firmware write reaches the full signed application byte count`
- Outcome: `pending human observation`

## Exact identity

- Card ID: `lw-b0fe81f61b44`
- Firmware version: `1.1.5` (initial screenshot showed `1.1.3`)
- Firmware build: `1239` (initial screenshot showed `1223`)
- Boot ID: `boot-eef03a35-b0fe81f61b44`
- Card route used: `USB preserving update in public Studio; read-only HTTP confirmation at 192.168.18.70`
- Project ID: `blank`
- Project revision: `0`
- Project fingerprint: `empty`

## Wiring and limits

| Output | GPIO | Pixel count | Chipset | Color order | Current limit | Expected direction |
| --- | ---: | ---: | --- | --- | --- | --- |
| `unknown` | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` |

## Machine evidence

| Time | Surface | Action or query | Expected | Actual evidence | Result |
| --- | --- | --- | --- | --- | --- |
| `2026-08-10 18:24 WITA` | `browser` | `Inspect screenshot after the preserving USB writer acknowledged 2,087,248 of 2,087,248 application bytes` | `Studio advances from sending to an explicit verification/restart phase` | `Panel remains on “Sending signed update” with the complete byte count and no new acknowledgement` | `fail` |
| `2026-08-10 18:24 WITA` | `source trace` | `Trace USB progress through PreservingUpdatePanel and runPreservingUsbBootstrap` | `A phase event marks readback verification after write completion` | `Write progress reaches 100%, then the full application is read back and hashed without emitting a new progress phase; the panel therefore continues to render Sending at the full byte count` | `fail` |
| `2026-08-10 18:25 WITA` | `API` | `GET /api/firmware-info and /api/status at 192.168.18.70` | `Exact card restarted on target firmware with preserved station Wi-Fi` | `Card lw-b0fe81f61b44 reports firmware 1.1.5 Build 1239, boot boot-eef03a35-b0fe81f61b44, station Wi-Fi configured at 192.168.18.70, update phase idle; card project remains blank at revision 0` | `pass` |

## Human observations

| Time | Known commanded state | One question asked | Adrian's observation | Expected | Result |
| --- | --- | --- | --- | --- | --- |
| `2026-08-10 18:24 WITA` | `Card lw-b0fe81f61b44, preserving USB update from firmware 1.1.3 Build 1223 toward 1.1.5 Build 1239, full application byte count acknowledged` | `Reported without an additional prompt` | `“When this reaches here there's no change in anything, there's no acknowledgement in what's happening.”` | `A visible verifying or restarting acknowledgement` | `fail` |

## Failure / Sprint handoff

- Observed versus expected: `The write reaches its exact signed byte count, but the UI remains in Sending while the updater performs full flash readback and SHA-256 verification. Independent API readback proves the card itself completed and restarted on the target build.`
- Reproduction: `Start the preserving one-time USB update and wait until the acknowledged byte count equals the application size.`
- Evidence links: `Owner screenshot plus the machine/source rows above.`
- Suspected ownership boundary: `lightweaver/src/lib/preservingUsbBootstrap.js progress contract and lightweaver/src/v3/lw-flash.jsx phase rendering.`
- Focused acceptance check: `Hold USB readback open after write completion and prove the visible panel changes to “Upload complete · checking the saved update” before readback resolves.`
- Workboard issue: `UPDATE-002`

## Single next step

`Ship UPDATE-002 through the normal release workflow so the next step can become one real-card observation.`
