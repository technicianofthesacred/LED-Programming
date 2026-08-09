# Lightweaver workboard

This is the compact cross-session source of truth. Only the primary agent edits
this file. Sub-agents return results, tests, commits, and blockers to the primary
agent, which integrates the evidence here. Keep entries short; detailed Bench and
Prove records belong in their session folders.

Status values: `queued`, `active`, `needs-eyes`, `blocked`, `done`.

## Sprint queue

| ID | Outcome | Area / likely ownership | Status | Focused proof |
| --- | --- | --- | --- | --- |
| — | No queued Sprint issue recorded | — | — | — |

## Active ownership

| Owner | IDs | Exact files / boundary | Started | Latest evidence |
| --- | --- | --- | --- | --- |
| — | No active ownership | — | — | — |

The primary assigns at most three sub-agents. Two active owners must never name
the same file or an inseparable behavior boundary.

## Visual-feedback queue

| ID | Screen or hardware state | What Adrian must observe | Build / fixture | Status |
| --- | --- | --- | --- | --- |
| — | No visual check queued for this workflow-only change | — | — | — |

Visual feedback does not pause independent automated work. The primary returns to
this queue when Adrian is available.

## Bench queue

| ID | Goal | Machine state | Human input still required | Session | Status |
| --- | --- | --- | --- | --- | --- |
| BENCH-001 | Restore and re-verify the 41-pixel GPIO 18 bench card after the destructive factory flash | Firmware 1.1.1 build 1198 booted into factory Setup AP; saved Wi-Fi/project state was erased | Network/project recovery information and final light observation | Not started | blocked |

## Prove readiness

| Scope | Requested explicitly? | Development frozen? | Automated readiness | Hardware readiness | Status |
| --- | --- | --- | --- | --- | --- |
| Full Lightweaver | No | No | Not evaluated | Bench card requires restoration | Not authorized |

“Ship” does not change this table to authorized. Only the explicit Prove gate in
`docs/workflows/prove.md` does.

## Completed evidence

| ID | Outcome | Evidence | Revision / build | Completed |
| --- | --- | --- | --- | --- |
| WORKFLOW-001 | Proportional glitch/checkpoint/release workflow shipped | PR #96; live no-store marker | Studio build 1201; firmware release build 1198 | 2026-08-09 |
| WORKFLOW-002 | Inferred Sprint, guided Bench, and explicit Prove system implemented | Seven mode contracts plus resumable Bench/Prove templates | Branch `codex/three-mode-workflow` | 2026-08-09 |

## Update rules

1. The primary adds or changes an entry when work is assigned, integrated,
   blocked, visually observed, or proven.
2. Keep exactly one active owner per file boundary.
3. Move detailed logs into a dated session file and link it; do not grow this
   board into a transcript.
4. Every interrupted Bench or Prove session records one and only one next step.
5. Completed entries name behavior and evidence, not agent activity.
