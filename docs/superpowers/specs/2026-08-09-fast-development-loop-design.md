# Fast development loop design

## Problem

Lightweaver already has focused CI lanes, yet interactive development remains
slow because small browser defects repeatedly trigger release-scale activity:
wide suites, redundant reviews, signing, deployment, and destructive hardware
flashes. This makes exploration expensive without adding proportional safety.

## Decision

Adopt three explicit verification tiers: glitch, checkpoint, and release. The
glitch tier is the default and proves one observed defect with one focused red/
green regression plus inspection of the actual screen. Checkpoint verifies a
coherent batch with unit tests, a production build, and only the relevant browser
or firmware suite. Release retains the complete existing CI, signer, deploy, live
proof, and changed-boundary hardware gates.

The policy is repository-owned in `AGENTS.md` and a durable workflow document.
A thin repository CLI provides a stable preview and unambiguous focused,
checkpoint, and release entry points without making a process-only change look
firmware-sensitive. Existing path-selected GitHub Actions remain unchanged
because they already solve the remote-CI half of the problem.

## Alternatives considered

Documentation alone is insufficient: future sessions can ignore it and return
to exhaustive per-glitch testing. A fully automatic changed-test selector would
be complex and unreliable because behavioral dependencies are not equivalent to
file paths. The selected approach uses enforceable names and contracts while
leaving the engineer responsible for choosing the one focused regression that
actually reproduces the defect.

## Safety boundaries

Browser-only iteration cannot bump firmware, sign, deploy, or flash. Firmware
work escalates when its wire contract changes, but the semantic version advances
once per release rather than once per edit. The production factory image is
explicitly classified as destructive to saved Wi-Fi and project state; a
configured card requires a recorded recovery path before flashing.

## Success criteria

- A stable preview has one canonical local URL and rejects duplicate servers.
- One browser regression can be invoked without the full browser suite.
- A checkpoint command runs unit coverage and a production build.
- A release command preserves the existing exhaustive launch gate.
- Future agents are required to implement when Adrian says build, retain visual
  feedback as a non-blocking list, and keep release work out of the glitch loop.
