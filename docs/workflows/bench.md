# Bench mode

Bench mode is the guided hardware loop for a Lightweaver card, LED strip,
wiring, USB connection, or physical light behavior. Adrian does not need to
remember or say “Bench.” Infer this mode when he is at the hardware and can
observe lights, colors, pixel counts, direction, power cycles, cables, or USB
behavior. If no immediate physical observation is needed, use Sprint instead.

The agent performs every machine-verifiable action it safely can and reserves
Adrian's attention for facts that require his eyes or hands. A Bench session is
bounded to one card and one behavior under test.

## Start or resume

1. Look in `docs/bench-sessions/` for an unfinished record for the same card and
   behavior. If one exists, verify that its recorded card identity still
   matches, then continue only from its recorded single next step. Do not repeat
   completed actions unless changed identity or contradictory evidence
   invalidates them.
2. Otherwise, copy `docs/bench-sessions/TEMPLATE.md` to a dated session file and
   state the behavior being tested. Record facts as they are obtained; use
   `unknown` rather than guessing.
3. Establish one exact target across USB serial, card-local HTTP, and Studio.
   A hostname or IP address is a route, not identity. Card ID, firmware build,
   and boot ID are the correlation evidence.
4. Keep exactly one actionable next step in the session record. Replace it only
   after that step is completed or becomes invalid.

A resumed session is ready when the identity has been re-correlated and there
is exactly one current next step. If the card ID changed, stop and open a new
session rather than combining evidence from two cards.

## Automation-first sequence

Perform the applicable machine work in this order. A step may be marked not
applicable with a reason; absence of a machine result is never converted into a
pass.

1. **Select the flash path.** Determine whether flashing is actually required.
   For a firmware test, automatically select the signed production image and
   manifest for the intended ESP32-S3 target, validate their build identity and
   integrity, select the correlated USB device, and record the decision before
   mutation. Use the normal Studio installer rather than asking Adrian to pick
   a binary, offset, erase option, or baud rate. A factory image erases Wi-Fi,
   project, and wiring state: proceed only when that destruction is explicitly
   in scope and the session contains a complete recovery record. Otherwise keep
   the installed firmware and continue diagnosis.
2. **Inspect serial.** Detect and select the correlated ESP32 serial device,
   release competing serial owners, capture timestamped boot/runtime logs, and
   extract the chip/card/build/boot evidence available there. Serial output
   from an unidentified device is diagnostic data, not proof for this card.
3. **Probe the API.** At the confirmed card-local route, collect
   `/api/firmware-info` and `/api/status`, then record card ID, firmware build,
   boot ID, project identity, runtime source/readiness, outputs, and wiring.
   Treat timeouts, schema errors, and identity disagreement as failures rather
   than filling fields from an older response.
4. **Drive the browser.** Open the actual Studio or card page needed for the
   test, select the correlated card/project, reproduce the state, and capture
   visible status or a screenshot when useful. Use one browser surface and one
   stable preview; do not ask Adrian to navigate screens the agent can operate.
5. **Exercise and read back.** Send the smallest safe bounded command needed for
   the behavior, capture its response, and independently reread status/config.
   Compare the card's reported project revision/fingerprint, GPIO, pixel count,
   chipset, color order, current limit, runtime state, and boot continuity with
   the expected values. A successful write response without this readback is
   incomplete.
6. **Summarize machine evidence.** Record commands/actions, timestamps,
   endpoints, relevant log extracts or artifact links, expected values, actual
   values, and pass/fail/inconclusive results. Redact Wi-Fi credentials, tokens,
   and unrelated device information.

The machine portion is complete when every applicable action has reproducible
evidence and every mismatch is explicit.

## Human observation protocol

Ask for one physical observation at a time, only after the machine has placed
the hardware in a known state. Each prompt must identify the expected card or
artwork, the exact thing to inspect, and the allowed response shape. Examples:

- “On card `lw-…`, how many pixels are lit: 0, 1–59, or all 60?”
- “Is the chase moving center-to-edge or edge-to-center?”
- “Is the solid test red, green, blue, or another color?”

Wait for Adrian's answer before requesting the next observation. Record his
words, the timestamp, the commanded state, and the expected result. If a cable
change or power cycle is needed, request that single action, automatically
re-establish serial/API/browser identity afterward, and only then ask the next
visual question.

Never mark a hardware check passed without Adrian's explicit observation for
that check. API state, screenshots of the UI, inferred LED behavior, or an
agent's expectation cannot substitute for what the physical lights did. If
Adrian is unavailable, record the check as pending and leave it as the one
resumable next step while independent machine work continues.

## Outcomes and failure routing

A Bench behavior passes only when machine evidence matches the intended
card/build/project/wiring state and Adrian explicitly confirms every required
physical observation. Record a truthful `passed`, `failed`, `inconclusive`, or
`pending human observation` outcome.

On failure, preserve the known-good state where possible and collect the
smallest diagnostic packet that reproduces the mismatch. Create a Sprint issue
containing:

- observed versus expected behavior;
- exact card, firmware build, boot, project, and wiring identity;
- reproduction steps and the failing machine or human evidence;
- the suspected code ownership boundary, if known; and
- a focused acceptance check that would close the issue.

Only the primary agent edits `LIGHTWEAVER_WORKBOARD.md`. A sub-agent returns the
Sprint issue packet to the primary agent, which adds it to the Sprint queue.
Do not respond to “lights wrong” by reflashing unless the evidence specifically
shows firmware corruption and the flash safety preconditions are satisfied.

Before ending or pausing, update the session record so it contains all evidence
already earned and one concrete next step that another agent can execute without
reconstructing the conversation.
