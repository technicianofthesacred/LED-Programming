# Printable worker job card

Print one card per artwork batch and keep it beside the powered bench fixture.
It is the only thing a worker needs besides the fixture, one USB data cable,
and a workshop computer. Print this page (or copy the block into any label
template); write the job code in by hand or pre-fill it before printing.

The QR code is optional but recommended: generate one for the full link below
with any QR tool and paste it onto the card — scanning it lands the worker
directly on the verified job with nothing to type.

---

## ── Lightweaver · Workshop card ─────────────────────────

**1. On the workshop computer, open Chrome or Edge**
(phones, Safari, and Firefox cannot flash cards — the page
will tell you to move to the computer if you try)

**2. Type this address:**

> ## `led.mandalacodes.com`

**3. Click "Workshop" at the bottom-left of the page**
(or go straight to
`led.mandalacodes.com/#screen=production&job=<JOB CODE>`)

**4. Enter the job code and press Find job:**

> ## Job code: `________________________`
>
> Bench rehearsal code: `bench-fixture-44`

**5. Follow the six steps on screen.**
The website checks everything before it asks you to plug in
the card. It will never let you skip a light check. If
anything looks wrong, press nothing and ask — the card
rolls back on its own within 90 seconds.

**6. When the lights pass, press Record, then Next artwork.**
Export the pass records (JSON and CSV) at the end of the
batch and hand them in.

**If you get stuck:** the screen always shows one safe next
action and a support code. Read the support code to whoever
you call — do not improvise with cables or power.

## ─────────────────────────────────────────────────────────

---

Operational notes (not printed):

- The rehearsal job `bench-fixture-44` targets the standard 44-LED bench strip
  on GPIO 16 (WS2815, GRB, conservative brightness). Add an artwork by copying
  `release/job-generators/bench-fixture-44.mjs` to a new generator with the
  artwork's layout, then run `node scripts/rebuild-production-jobs.mjs` and
  commit. Jobs pin the exact signed firmware buildId, so the protected
  firmware-release workflow reruns the same rebuild automatically whenever it
  signs a new release — published jobs can never drift from the live firmware.
- Same-origin jobs need no detached signature; add `--signing-key` (see
  [release/production-job-signing.md](../release/production-job-signing.md))
  only when the offline `.lwjob.json` file lane must import the job.
- The worker procedure in full: [worker-flash-runbook.md](worker-flash-runbook.md).
- The release acceptance gate that must be completed once before workers use
  this card unsupervised: [deployment-checklist.md](deployment-checklist.md)
  ("Workshop Production Setup acceptance").
