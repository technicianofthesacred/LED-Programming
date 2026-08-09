# Three-mode Lightweaver Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist an inferred Sprint, guided Bench, and explicitly authorized Prove workflow inside the Lightweaver repository.

**Architecture:** `AGENTS.md` owns inference and safety rules. A primary-owned workboard persists cross-session state, while focused workflow guides and session templates define execution and resumability without adding another orchestration service.

**Tech Stack:** Markdown repository policy, Node test runner contract tests, existing Codex multi-agent coordination and Lightweaver verification commands.

---

### Task 1: Write the workflow contract

**Files:**
- Create: `scripts/three-mode-workflow.test.mjs`

- [x] Assert natural feature/glitch requests select Sprint and physical observations select Bench.
- [x] Assert exhaustive inference requires confirmation and shipping never implies Prove.
- [x] Assert the workboard is primary-owned and contains Sprint, visual, Bench, and Prove sections.
- [x] Assert Sprint, Bench, Prove, and both resumable session templates contain their mandatory safety fields.
- [x] Run `node --test scripts/three-mode-workflow.test.mjs` and witness the missing-policy failures.

### Task 2: Persist mode inference and ownership

**Files:**
- Modify: `AGENTS.md`
- Create: `LIGHTWEAVER_WORKBOARD.md`

- [x] Add the natural-language inference table and make Sprint the ambiguity default.
- [x] Require exact authorization for Prove and keep ship independent.
- [x] Define primary-only workboard ownership and non-overlapping sub-agent boundaries.
- [x] Add compact workboard tables for queued work, active ownership, visual feedback, Bench, Prove readiness, and completed evidence.

### Task 3: Define each operating mode

**Files:**
- Create: `docs/workflows/sprint.md`
- Create: `docs/workflows/bench.md`
- Create: `docs/workflows/prove.md`
- Modify: `docs/development-workflow.md`

- [x] Define Sprint decomposition, agent selection, evidence return, integration, timing, and single checkpoint.
- [x] Define Bench automation-first behavior, one human observation at a time, failure routing, and resumability.
- [x] Define the Prove authorization gate, development freeze, automated/live/hardware evidence, and truthful incomplete outcome.
- [x] Link the three modes from the existing development guide without weakening its glitch/checkpoint/release tiers.

### Task 4: Make physical and exhaustive work resumable

**Files:**
- Create: `docs/bench-sessions/TEMPLATE.md`
- Create: `docs/prove-sessions/TEMPLATE.md`

- [x] Record exact card, firmware, boot, project, wiring, strip, machine evidence, human observations, and one next step in the Bench template.
- [x] Record source/build identities, automated gates, live proof, hardware matrix, waivers, unresolved risks, and one next step in the Prove template.

### Task 5: Verify and integrate

**Files:**
- Test: `scripts/three-mode-workflow.test.mjs`
- Test: `scripts/development-workflow.test.mjs`

- [x] Run both workflow contracts and `git diff --check`.
- [x] Run `node scripts/lightweaver-dev.mjs checkpoint` once for the coherent batch.
- [ ] Commit and push the branch; stop at PR-ready unless Adrian separately says ship.
