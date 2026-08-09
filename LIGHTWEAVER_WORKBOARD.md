# Lightweaver workboard

This is the compact cross-session source of truth. Only the primary agent edits
this file. Sub-agents return results, tests, commits, and blockers to the primary
agent, which integrates the evidence here. Keep entries short; detailed Bench and
Prove records belong in their session folders.

Status values: `queued`, `active`, `needs-eyes`, `blocked`, `done`.

## Sprint queue

| ID | Outcome | Area / likely ownership | Status | Focused proof |
| --- | --- | --- | --- | --- |
| WINDOWLESS-001 | Public Studio direct-LNA/local-origin transport, offline repository/PWA, and explicit project continuity | Studio source | done | 1,364 unit assertions + focused Chromium cold-offline pass |
| WINDOWLESS-002 | Card HTTP streaming, owner capability, atomic project storage, and embedded local Studio server | Firmware source | done | 4 focused contracts + generated-bundle PlatformIO pass |
| WINDOWLESS-003 | Card/PWA build targets, encrypted staging, release lanes, and integrated browser/artifact contracts | CI / release / browser tests | done | 8 tooling contracts + Pages staging + production/card builds |

## Active ownership

| Owner | IDs | Exact files / boundary | Started | Latest evidence |
| --- | --- | --- | --- | --- |
| — | — | No active parallel ownership; implementation is integrated locally. | — | Final automated checkpoint complete |

The primary assigns at most three sub-agents. Two active owners must never name
the same file or an inseparable behavior boundary.

## Visual-feedback queue

| ID | Screen or hardware state | What Adrian must observe | Build / fixture | Status |
| --- | --- | --- | --- | --- |
| WINDOWLESS-VIS-001 | Direct Chrome/Edge local-network permission and exact-card control | Permission allow/deny/revoke, no auxiliary tab, correct lights and Stop | Real router + configured card | needs-eyes |
| WINDOWLESS-VIS-002 | Safari/iOS same-tab card-local Studio | Full routine flow on AP without internet, no auxiliary tab | iPhone/iPad + configured card | needs-eyes |
| WINDOWLESS-VIS-003 | Card serves embedded Studio while animating | First/repeated asset loads do not visibly stall animation; recovery page survives incompatibility | Real configured card | needs-eyes |

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
| WINDOWLESS-001–003 | Windowless/offline Studio implemented across public PWA, card-local Studio, firmware, project storage, encrypted handoff, and release tooling | Unit 1,364/1,364; tooling 8/8; firmware 4/4; Chromium offline 1/1; Pages staging; Vite/card/PlatformIO builds | Local commit on `codex/windowless-offline-studio` | 2026-08-10 |

## Update rules

1. The primary adds or changes an entry when work is assigned, integrated,
   blocked, visually observed, or proven.
2. Keep exactly one active owner per file boundary.
3. Move detailed logs into a dated session file and link it; do not grow this
   board into a transcript.
4. Every interrupted Bench or Prove session records one and only one next step.
5. Completed entries name behavior and evidence, not agent activity.
