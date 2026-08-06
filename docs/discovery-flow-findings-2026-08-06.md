# Find My Strips — walkthrough findings, 2026-08-06

Observed by driving the real Studio (localhost:9999) against the real card
(`lw-b0fe81f61b44`, 192.168.18.70, firmware 1.0.0 build 1081) end to end, with
Adrian watching the physical strip.

Findings are ordered by how badly they hurt a first-time commissioning.

---

## 1. Quitting discovery halfway strands the card on a fake project (worst)

**What happened.** Discovery was started, then the browser session went away
before the flow finished. The card rebooted and came back running
`lightweaver-bench-discovery-v1` — 1024 pixels across GPIO 15/16/17/18 at
256 each — and lit the whole strip. It is still in that state on the next boot.

**Evidence.** `/api/status` → `runtimePhase: ready`, `outputReady: true`,
`projectId: "lightweaver-bench-discovery-v1"`; uptime reset confirms the reboot.

**Why it matters.** The discovery screen promises *"This writes one temporary
setup to the card so it can light LEDs at all. Your own project replaces it at
the end."* That promise only holds if the user reaches the end. Abandon it —
close the tab, phone sleeps, walk away to look at the strip and get distracted —
and the card is permanently running scaffolding the user never chose, driving
1024 pixels regardless of the real strip length.

**Suggested fix.** Treat the bench project as provisional on the card, not
committed: keep the previous project as known-good and only promote the
discovery result on completion. Failing that, mark it clearly on the card so any
later boot can say "unfinished setup" rather than silently playing it.

---

## 2. The "look at your strip" question is not stable while you look

**What happened.** The question *"GPIO 15 — how far do the lights go? Studio lit
the first 8 LEDs on this port. Look at the strip."* was on screen. Adrian looked:
nothing lit. Between his looking and his answering, the card rebooted and the
**whole strip** lit. The answer he was about to give no longer described reality.

**Why it matters.** This is the single question the whole flow depends on, and
it assumes the light holds steady while the user walks to the piece, looks, and
comes back. Nothing on that screen re-lights, holds, or tells the user the light
state has changed underneath them.

**Suggested fix.** Add a "light it again" control next to the three answers, and
show a live indicator of what the card is currently driving. If the card reboots
or the stream drops while the question is up, say so instead of accepting a stale
answer.

---

## 3. The copy says 8 LEDs; the hardware lights the whole strip

The screen says the card lights *"8 LEDs on that port"* and *"stays dim and
short"*. What actually gets written is 256 pixels per port across four ports.
While the guided step is running, only 8 are lit — but any reboot lands on the
full 1024-pixel bench project and the whole strip comes on.

**Suggested fix.** Say what gets written, not just what is displayed: "this sets
the card up for 256 LEDs per port while we look."

---

## 4. Before you pair, Studio shows no sign of the stranded card

With the card actively driving 1024 pixels on a bench project, an unpaired
Studio shows *"Lightweaver found — tap Connect to pair"* with all five steps
unticked, as if it were a fresh card. The card advertises `projectId` on
`/api/status`; Studio just does not surface it until after pairing.

**Suggested fix.** Read and show the card's project identity in the pre-pair
detected-state line.

---

## 5. Once paired, the bench project looks like a legitimate project

Studio reports *"Lightweaver Bench Discovery is connected and ready for light
check"* and lists it with pixel count and outputs exactly like a real project.
Nothing flags it as leftover setup scaffolding. A user would reasonably believe
their card is commissioned.

**Suggested fix.** Name it as temporary in the UI and offer a one-tap "clear this
and start over".

---

## 5b. "Recover lights" does not recover you out of this

Pressing **Recover lights** on a card stranded in bench discovery reports
*"Recovery command was acknowledged with ready-state readback"* and lights the
strip warm white — but the card is still running `lightweaver-bench-discovery-v1`
across all 1024 pixels afterwards. It recovers the *lights*, not the *setup*, and
the wording does not make that distinction.

Verified: after recovery, `/api/status` still returns
`projectId: "lightweaver-bench-discovery-v1"`.

There is currently no non-destructive way out of the bench project from Studio.
Turning output off stops the strip now but the bench project returns on the next
boot. Factory reset clears it but also wipes WiFi.

**Suggested fix.** Add "clear temporary setup" as an explicit action wherever the
card reports a bench/discovery project.

---

## 6. The 4-port limit only appears after you break it

Setting all 11 ports to "Look for a strip" — the natural move when you do not
know where the strip is — **disables** the Start button and prints seven
near-identical lines: *"GPIO 38 will not be lit — this card can drive only 4
strip outputs at once."* The limit is never stated before you hit it.

**Suggested fix.** State "pick up to 4" in the instructions, stop the 5th
selection at the point of selection, and show one summary line rather than one
per port.

---

## 7. Find My Strips is hard to reach

After pairing a blank card, step 4 offers "Install current project" and "Start a
new project". For a blank card with unknown wiring neither is correct — the right
action is discovery, and it lives inside the connection popover behind the status
chip. Reaching it directly required deep-linking `#screen=discovery`.

**Suggested fix.** Put "Find my strips" on the step-4 panel whenever the card
reports no project.

---

## 8. The discovery screen looks unfinished

- Native white `<select>` dropdowns against the dark theme — the only place in
  the app that breaks the visual language.
- Port rows are ragged: the "Light it" buttons and dropdowns do not share a
  column edge.
- `GPIO 4In use by the controls` — missing separator between number and label.
- The question step leaves roughly 700px of empty space below three buttons.

---

## Not a finding

Pairing persistence was suspected but disproved: pairing survives a reload
correctly (`lw_chip_card_host`, `lw_card_identity_v1` in local storage). Earlier
apparent losses were an artifact of the test harness creating a fresh browser
context each run.

---

## Current card state

Left running `lightweaver-bench-discovery-v1`, 1024 pixels, output on. It needs
either a real project installed or a reset to stop driving the full strip.
