# Lightweaver Bench session

Copy this file to `YYYY-MM-DD-<card-or-artwork>-<behavior>.md`. Replace every
placeholder with evidence or `unknown`; never infer a hardware pass.

## Session

- Date/time and timezone: `<timestamp>`
- Operator: `<name>`
- Behavior under test: `<bounded behavior>`
- Outcome: `in progress | passed | failed | inconclusive | pending human observation`

## Exact identity

- Card ID: `<stable card identity>`
- Firmware version: `<semantic version>`
- Firmware build: `<repository build number>`
- Boot ID: `<per-boot identity>`
- Card route used: `<USB identity and/or confirmed local route>`
- Project ID: `<project/piece identity>`
- Project revision: `<revision>`
- Project fingerprint: `<fingerprint>`

## Wiring and limits

| Output | GPIO | Pixel count | Chipset | Color order | Current limit | Expected direction |
| --- | ---: | ---: | --- | --- | --- | --- |
| `<output ID>` | `<pin>` | `<count>` | `<chipset>` | `<order>` | `<mA/A>` | `<direction>` |

## Machine evidence

| Time | Surface | Action or query | Expected | Actual evidence | Result |
| --- | --- | --- | --- | --- | --- |
| `<timestamp>` | `flash | serial | API | browser | readback` | `<action, endpoint, or artifact link>` | `<expected>` | `<response/log/screenshot; secrets redacted>` | `pass | fail | inconclusive` |

## Human observations

Record Adrian's answer verbatim. One row is completed before the next
observation is requested.

| Time | Known commanded state | One question asked | Adrian's observation | Expected | Result |
| --- | --- | --- | --- | --- | --- |
| `<timestamp>` | `<card/output/pattern/state>` | `<single physical question>` | `<verbatim answer or pending>` | `<expected physical result>` | `pass | fail | pending` |

## Failure / Sprint handoff

- Observed versus expected: `<difference or none>`
- Reproduction: `<minimal repeatable sequence>`
- Evidence links: `<session rows, logs, screenshots>`
- Suspected ownership boundary: `<area or unknown>`
- Focused acceptance check: `<check that would close the issue>`
- Workboard issue: `<Sprint issue ID or pending primary-agent entry>`

## Single next step

`<one concrete machine action or one physical observation; replace rather than append>`
