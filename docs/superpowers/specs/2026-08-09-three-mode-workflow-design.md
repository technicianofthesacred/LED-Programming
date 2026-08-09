# Three-mode Lightweaver workflow design

## Goal

Adrian should be able to describe work naturally without remembering command
names. The primary agent infers one of three operating modes, persists state in
the repository, and uses proportionate agents and verification.

## Modes

### Sprint

Sprint is the default for glitches, feature lists, interface improvements, and
requests to keep working independently. The primary agent groups the request by
non-overlapping ownership boundaries and may dispatch at most three useful
sub-agents while remaining the sole integrator. Each stream owns a complete
red/green deliverable. The batch receives one integrated checkpoint; it never
silently deploys, signs firmware, flashes hardware, or starts exhaustive proof.

### Bench

Bench begins when Adrian is physically observing a card, strip, wiring, colors,
pixel counts, power cycles, or USB behavior. The agent performs every available
machine action and asks Adrian only for facts requiring eyes or hands, one at a
time. Every session records exact card/build/boot/project/wiring evidence and a
single next resumable step. Bench failures enter the workboard as Sprint issues.

### Prove

Prove is the exhaustive confidence run. It never starts through inference alone,
as part of Sprint, as part of Bench, or merely because Adrian says ship. The
exact phrase “Prove Lightweaver” is sufficient authorization. Less explicit
requests such as “check everything” require the agent to name the expected long
duration and obtain confirmation before starting. Prove freezes development,
runs complete automated and live release evidence, and separates machine proof
from unperformed visual hardware gates.

## Persistent state

`LIGHTWEAVER_WORKBOARD.md` is the compact source of truth for queued Sprint
issues, active ownership, visual feedback, Bench work, and Prove readiness. Only
the primary agent edits it; sub-agents return evidence to the primary. Bench and
Prove session templates live under `docs/bench-sessions/` and
`docs/prove-sessions/` so interrupted work resumes without repeating passed
steps.

## Inference and ambiguity

Ordinary defect and feature language selects Sprint. Immediate physical
observation language selects Bench. Exhaustive language creates a Prove
candidate but cannot authorize the run. “Ship” retains its existing release
meaning and does not imply exhaustive Prove. When Sprint and Bench are both
plausible, default to Sprint until an immediate physical observation is truly
required.

## Alternatives rejected

Requiring memorized slash commands is fast only after training and fails the
stated usability goal. A standalone orchestration service would duplicate Codex
coordination and introduce another state store. Pure conversational convention
would disappear across sessions. Repository instructions plus a primary-owned
workboard and session templates provide durable behavior with minimal machinery.

## Success criteria

- Natural language deterministically selects Sprint or Bench.
- Prove cannot start without explicit authorization.
- Parallel Sprint streams never overlap ownership.
- Human-only checks never block independent automated work.
- Bench and Prove work can resume from one recorded next step.
- Shipping does not silently invoke Prove.
