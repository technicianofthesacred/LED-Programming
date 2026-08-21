# Wire the two parked test lanes into CI

**Goal.** Land branch `claude/wire-parked-test-lanes`, which switches on 19 tests
that currently run nowhere. The branch is pushed and complete except for one
thing it deliberately does not contain: a firmware VERSION bump.

**Branch:** `claude/wire-parked-test-lanes`, off `019d5785`, one commit.
**Worktree already set up:** `~/builds/lw-parked-lanes` (has its own node_modules).
**Estimate:** ~10 minutes of work, then ~30 minutes unattended while the signed
release builds.

---

## 2026-08-20 audit deltas — verified, do not re-survey

The previous chat surveyed all of this on 2026-08-20. Take it as given:

1. **The branch changes exactly one file**, `lightweaver/package.json`, in two
   npm script lines. Nothing else.

2. **`test:core` gains two firmware checks** — `ws2815-output-driver.mjs` and
   `factory-beacon-sweep.mjs`. Both test files landed on `main` with PR #160 and
   **nothing has run them since**; they are dead tests in the tree today. Both
   were run directly and pass: exit 0 each, the beacon one reporting
   "14 registered ports, 14 beacon steps, sweep 21000ms, 14 pinnable".

3. **`ci:browser-smoke` grows from 6 spec files to 23**, adding 17 specs no lane
   runs. Previously measured at 110 tests, zero failures, 102s serial — the gate
   goes from roughly 45 tests/50s to about 2.5 minutes, still inside budget.
   It does NOT add `wiring-workspace.spec.ts` or `patterns-v3.spec.ts`.

4. **Why this needs a signed release at all.** `lightweaver/package.json` maps to
   ALL_LANES in `scripts/ci-changed-lanes.mjs:62`, and `firmwareBundleOnly`
   returns `false` for it, so the signer runs. Editing one line of npm scripts
   therefore costs a full signed firmware release whose binary is unchanged.
   This was confirmed by calling the classifier directly, not assumed.

5. **The exact blocker.** Preflight on the branch:

   ```
   PREFLIGHT FAIL: firmware-sensitive change, but firmware/lightweaver-controller/VERSION
   (1.1.27) is not greater than the already-signed 1.1.27.
   ```

6. **The collision risk that stopped the previous chat.** A merge-coordinator
   session warned that another in-flight stream was claiming **1.1.28**. `main`
   was still at 1.1.27 when this branch was pushed, meaning that stream had not
   landed. That coordinator session has since ended, so **nobody is holding the
   number any more — but confirm it is free before taking it.**

7. **Both changes came out of the stash pile**, which is now empty. Their only
   home is this branch. Do not go looking for stashes; there are none.

---

## The task

1. **Confirm which version number is free.**

   ```bash
   cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led" && git fetch origin && cat firmware/lightweaver-controller/VERSION && git log --oneline origin/main -3
   ```

   If `main` is at 1.1.27, take 1.1.28. If another stream has landed 1.1.28 in
   the meantime, take the next free number instead. Do not assume.

2. **Bump the version in both places.** `firmware/lightweaver-controller/VERSION`
   AND its pinned literal in
   `firmware/lightweaver-controller/tests/firmware-version-policy.mjs`. CI checks
   both; bumping only one fails the gate.

3. **Confirm preflight is clean before pushing.**

   ```bash
   cd "/Users/adrianrasmussen/builds/lw-parked-lanes" && node scripts/ci-preflight.mjs
   ```

   Expect "Firmware VERSION ok" and no PREFLIGHT FAIL. This answers in ~2s what
   CI would otherwise tell you twenty minutes into a release.

4. **Open the PR, merge it, and let the signer run.** This is a real signed card
   release: expect roughly 30 minutes unattended. The build number will jump.

5. **Prove it live** — merged is not shipped:

   ```bash
   curl -H 'Cache-Control: no-store' https://led.mandalacodes.com/studio-release.json
   ```

   Report the build number, and confirm the signed firmware manifest carries a
   matching one.

---

## Acceptance

- Preflight reports clean before the push, not after a CI failure.
- CI green, including the firmware lane, with the signer actually publishing
  rather than skipping.
- The live release marker names the merge revision.
- `npm run test:core` runs the two firmware checks (grep the script to confirm
  they are present, and that the run passes).

## Verification status of the 17 added specs

**One alleged failure was checked and is false; the rest are still unmeasured.**

An agent asked to verify these on 2026-08-20 returned `modal-navigation.spec.ts`
as failing "on a stale assertion expecting a Setup rail item". That is wrong on
both counts. The spec asserts a **Card** rail item, and its own comment records
that it was already updated for the card consolidation. Run directly, it passes:
2 expected, 0 unexpected, 6.4s. Its wider verdict ("16 of 17, partly safe") comes
from the same source and should not be relied on.

TODO.md separately records 110 tests, zero failures, 102s serial — real, but
predating the merges that followed.

So: no confirmed failure anywhere, and no fresh full measurement either. Re-run
the added specs before merging — a red spec wired into the
gate blocks every future merge until someone fixes it. Run them one spec file at
a time, and require `"unexpected": 0` from the JSON reporter, never a line-reporter
tail:

```bash
cd "/Users/adrianrasmussen/builds/lw-parked-lanes/lightweaver" && npx playwright test tests/pattern-lab-authoring.spec.ts --workers=1 --reporter=json
```

Playwright cannot launch its browser inside the sandbox, so every such command
needs the sandbox disabled. Same for `git push`.

## Host contention, and what it was hiding (2026-08-20 → 21)

Most of 2026-08-20 this machine ran six sessions at once, and `wiring-workspace`
took **17.6 minutes** for 36 tests against a normal 87 seconds. Under that load it
reported 17 failures, which led three sessions — this one included — to believe
the spec was genuinely red on `main`, and a session was briefed to bisect four
merges hunting the regression.

There was no regression. Once the machine went quiet, on merged `main`:

- `wiring-workspace` — **36 expected, 0 unexpected, 90s**
- `patterns-v3` — **56 expected, 0 unexpected, 73s**

Every one of those failures was host contention. The lesson worth keeping: on a
loaded host, a slow run is not evidence of anything — check the wall-clock against
the known-good figure before believing a red result, and never pass a red verdict
onward without that check.

This also closes the open question on the colour-order change shipped as build
1400: it is verified green on the code that is live.

## Why this is worth the release toll

On 2026-08-20 a Studio change went live without CI ever running either of the two
test files it changed, because neither is in any lane. This branch is the fix for
that class of problem, and it is nearly free whenever someone is already paying
the signed-release cost for a genuine firmware change. If a firmware-sensitive
stream is queued behind this, fold this branch into it instead of paying twice.
