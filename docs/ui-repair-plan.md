# Lightweaver — UI repair plan

**Status: collecting. Do not build the easiness pass yet.**

A running list of everything that made the real setup harder than it should be,
gathered by walking the whole flow on real hardware (card `lw-b0fe81f61b44`)
with Adrian watching the physical strip. Items get added as the walkthrough
continues.

---

## The rule

**Two lists, and they are not worked in parallel.**

- **BROKEN** — stops the setup completing, strands the card, or records a wrong
  answer. These get fixed, and only these, until one full loop runs start to
  finish on real hardware.
- **DEFERRED** — merely slow, repetitive, or ambiguous. Untouched until a
  complete working loop exists and its real steps are written down. That
  captured process is then what gets made easy.

The walkthrough's job is to produce a loop that *works*. Making it pleasant is a
separate pass with a separate starting point: the recorded steps of a run that
actually completed.

---

# BROKEN — fix these to get one loop working

## B-COLOUR — every colour the flow uses as information renders wrong

**What happens.** Discovery communicates through colour: warm amber = lit, green
= every 10th, blue = every 50th, red = every 100th, magenta = the last LED. On
the real strip they come out wrong:

| Studio sends | Hex | Adrian sees |
|---|---|---|
| warm amber (probe) | `281400` | **green** |
| magenta (end marker) | `3C003C` | **blue** |

Both are consistent with a channel-order mismatch — the red channel landing in
the green slot. The bench discovery config picks a colour order without ever
establishing the strip's actual one.

**Why broken.** The whole counting protocol is "read the colours off the strip".
If the colours lie, the instructions lie: the screen says "count the greens"
while every pixel looks green, and "one purple LED" when the owner sees blue.
The one place the flow depends on colour being truthful is the one place it
isn't.

**Consequence observed.** Adrian read the probe as "sixteen lit as green" and the
end marker as blue, and expected a different scheme entirely. Getting the right
count anyway was luck — green-on-green defeats the decade ruler on a longer
strip.

**Direction.** Establish colour order before any colour carries meaning — run the
existing colour-order check first, or make the markers order-independent (differ
by brightness or position, not hue).

---

## B1 — Studio rejects a card after a firmware update, with no way forward

**What happens.** After flashing new firmware, the card is refused with "This
card has a different firmware build." The only offered action is **Update card**
— which reflashes, i.e. undoes the update.

**How we got past it.** Manually deleting `lw_card_identity_v1` from browser
storage. There is no UI path at all.

**Why broken.** The loop cannot continue. Every bench flash strands the owner.

---

## B0 — Discovery on an already-set-up card fails, and blames the wrong thing

**What happens.** Running Find my strips on a card that is *not* blank — e.g. one
already holding the temporary setup from an earlier run — fails with:

> "This card is running older firmware that files a blank card's first setup as
> a staged wiring change instead of applying it, so its LEDs cannot be lit yet.
> Update the card firmware from the Flash screen, then run Find my strips again."

**Why broken.** The diagnosis is wrong, and the instruction is wrong. The card was
running the newest firmware, flashed minutes earlier. The real cause is that the
card already had a project, so the new setup counted as a *wiring change* and was
staged for confirmation rather than applied. Studio sees "staged" and concludes
"old firmware".

**Consequence.** The owner is told to reflash. Reflashing does not help, because
firmware was never the problem. The strip is left fully lit meanwhile. Observed
live, twice.

**Direction.** Distinguish "staged because the card already has a project" from
"staged because the firmware cannot apply a first config". For the former, offer
to clear the existing setup and continue — that is one tap, and it is the actual
fix.

---

## B2 — A reload mid-discovery loses the run and leaves the strip fully lit

**What happens.** If Studio reloads during a discovery run — refresh, phone
reloading a backgrounded tab, or a dev hot reload — the run is lost. The screen
returns to the port picker with no memory of progress, and the card carries on
playing the temporary setup across all 1024 pixels. Observed directly: the strip
went fully white-blue with no user action.

**Why broken.** All progress lost and the card left driving pixels nobody asked
for, with no route back to where you were.

---

## B3 — Rescuing a stranded card requires a typed command

**What happens.** A card stuck on the temporary setup can only be cleared by
hand via its web address. No button exists.

**Why broken.** The owner has no way out of a state the app put them in.

**Status.** Firmware side is done and flashed — clearing the setup now keeps the
WiFi. The Studio button is written up and deliberately not built yet.

---

## B4 — "Recover lights" reports success without recovering

**What happens.** On a card stranded in the temporary setup, **Recover lights**
reports success and lights the strip warm white — but the card is still running
the temporary setup afterwards.

**Why broken.** It tells the owner it worked when the thing they wanted fixed is
not fixed. A false success is worse than no button.

---

## B5 — A stale answer can be accepted after the card restarts

**What happens.** The one question the whole flow depends on — "look at your
strip and tell me what you see" — assumes the lights hold while the owner walks
over and back. If the card restarts in that window, the answer describes a
moment that has passed and is recorded anyway.

**Why broken.** It writes a wrong LED count, silently.

**Status.** Partly addressed — a **Light these again** button exists and Studio
detects the restart. Still missing: discarding the pending answer when a restart
is detected. The restart itself is unavoidable; the light pins are fixed when the
firmware is built.

---

# OUTSTANDING — carried into the next session

## O1 — B2 resume-after-reload is written but does not work

The code is in (`stripDiscoveryStore.js` run store, `StripDiscoveryPanel.jsx`
persistence effect + resume banner) and its two Playwright tests describe the
intended behaviour exactly, but the `discovery-resume` banner never appears
after a reload. Both tests are marked `test.fixme` in
`lightweaver/tests/strip-discovery.spec.ts` so CI is honest rather than green-by-
omission.

Ruled out by reading: the write guard (`RESUMABLE_PHASES` includes `probe`), the
read guard (`version === 1`, ports array), the mount read
(`useState(readDiscoveryRun)`), the banner's placement inside the `phase ===
'idle'` guard, and the `storage()` helper. The fault is between the write and
the read and needs a live browser debugging pass — do not fix it by re-reading
the code.

## O2 — one flaky test

`card-workspace.spec.ts` › "Card overview preserves the stopped responding state
and recovery action" passes in isolation and fails in a full-suite run. Test
interference, most likely leaked `localStorage` from the new blocker specs
(`lw_discovery_run_v1`, `lw_card_identity_v1`). Not a product bug.

## O3 — the loop has still never been walked clean end to end

Every blocker fix so far is verified by tests and, for the firmware, on real
hardware — but nobody has walked the whole setup on the real card with all fixes
in place. That walk is the actual acceptance test, and it is the only way to
learn the true colour order of the strip (see B-COLOUR).

## O4 — the card's colour order is still unknown

The colour-proof quiz now measures it inside discovery, but it has never been
answered on real hardware. Until it is, the recorded evidence is only that warm
amber renders green and magenta renders blue.

## O5 — build identity of a bench-flashed card

The card currently reports `buildId: "dev"` and `buildNumber: 0` because it was
built locally rather than by CI. Harmless now that B1 lets Studio re-learn a
reflashed card, but worth deciding whether bench builds should carry a real
identity.

---

# DEFERRED — the easiness pass, after a loop completes

## The headline problem

**Setting up one card takes eight trips to the strip and back.** Look at port 15,
walk back, click. Then 16, 17, 18. Then 8 lights, 16, 32, and finally the real
count. Every screen is defensible on its own; the sequence is not.

Target for the later pass: **two trips** — one to find the port, one to confirm
the count.

## D0 — The colour code is never explained, and does not match expectation

**What the flow actually uses:** warm amber = "this pixel is lit" (the whole
probe stage), green = every 10th, blue = every 50th, red = every 100th, magenta =
the single last LED. On a 44-LED strip the owner therefore sees warm amber
throughout, four greens, **no blue, no red**, and one magenta right at the end.

**What Adrian expected:** first LED blue, last LED red.

**Where the legend is and isn't.** The counting stage *does* explain it well:
"Every 10th LED is green, every 50th blue, every 100th red. Count the reds, then
the blues after the last red, then the greens after that, then the plain warm
ones on the end." The **probe** stage — the one the owner meets first, and spends
the most trips in — says nothing about colour at all.

**Why it matters.** During the probe the owner has no way to tell which end of
the strip is LED 1, and no reason to expect the later colour code. Adrian spent
the probe stage looking for markers that were never going to be there.

**Direction.** Mark the first pixel distinctly during the probe so the strip's
direction is visible, and say up front that the colour code arrives at the
counting step.

---

## D1 — Hunting the port one at a time
Walks GPIO 15 → 16 → 17 → 18, one look each. No "I don't know — light all four
and I'll tell you which lit". Up to four trips before the real work starts.

## D2 — Counting by doubling
Length search goes 8 → 16 → 32 → …, each step another look. Adrian knew it was
about 44 before we started; the flow never asked.

## D3 — Two different buttons named "Find my strips"
Both on the card overview: one in the main panel, one in the connection popover.
Same words, same screen.

## D4 — "Connect" vs "Use this card instead" is unexplained
No statement of the difference, or of the consequence of picking wrong.

## D5 — The pairing box doesn't say which card
"Studio found a Lightweaver card on this network" — no name or address unless
you expand "Connection details". Fine with one card, wrong card paired with two.

---

## Already fixed in the first pass (context, not pending)

- Blank card offers **Find my strips** first, instead of only "Install project" /
  "Start a new project"
- The 4-output limit is stated **before** you hit it; overflow is one line
  instead of seven near-identical ones
- The screen says what the temporary setup actually writes (256 per port, and
  that it survives a restart) instead of implying 8 lights
- The port list looks like the rest of the app — dark rows, aligned columns,
  proper dropdowns, `GPIO 4` separated from its label
- An unpaired card running the temporary setup is flagged as such before pairing
- A paired card on the temporary setup is no longer described as "ready"
- Firmware: the temporary setup is marked, so an abandoned one no longer lights
  the strip on restart
- Firmware: clearing a card's setup keeps its WiFi

---

_Original findings: `docs/discovery-flow-findings-2026-08-06.md`._
