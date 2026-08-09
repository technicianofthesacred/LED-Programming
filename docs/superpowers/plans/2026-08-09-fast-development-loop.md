# Fast Development Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fast, focused browser iteration the repository-enforced default while preserving strict checkpoint and release gates.

**Architecture:** Keep the existing path-selected remote CI unchanged. Add a thin repository CLI, a tested repository policy, and a durable operator guide that separates glitch, checkpoint, and release work.

**Tech Stack:** npm scripts, Node test runner, Playwright, Vite, Markdown policy.

---

### Task 1: Contract the workflow

**Files:**
- Create: `scripts/development-workflow.test.mjs`

- [x] Write assertions for the stable preview, focused browser, checkpoint, and release commands.
- [x] Assert that agent policy forbids release work in the glitch loop and defines build as implementation.
- [x] Assert that the operator guide names every tier and the destructive factory-image boundary.
- [x] Run `node --test scripts/development-workflow.test.mjs` and witness the expected failures.

### Task 2: Add the proportional development CLI

**Files:**
- Create: `scripts/lightweaver-dev.mjs`

- [x] Add `preview` with host `127.0.0.1`, port `4173`, and `--strictPort`.
- [x] Add `focused` with Chromium and one worker while preserving appended file and grep arguments.
- [x] Add `checkpoint` as unit tests plus native dependency repair and Vite production build.
- [x] Add `release` as the unchanged exhaustive `launch:check` entry point.

### Task 3: Persist the operating policy

**Files:**
- Modify: `AGENTS.md`
- Create: `docs/development-workflow.md`
- Create: `docs/superpowers/specs/2026-08-09-fast-development-loop-design.md`

- [x] Make the glitch loop the explicit default and define build as implementation, not a planning stop.
- [x] Define checkpoint escalation by product boundary rather than anxiety or inconvenience.
- [x] Preserve the complete PR, signer, deploy, live-build, and hardware rules at release time.
- [x] Document one-server browser discipline, visual-feedback continuation, time limits, and factory-image recovery requirements.

### Task 4: Verify and integrate

**Files:**
- Test: `scripts/development-workflow.test.mjs`
- Test: `scripts/production-job-consistency.test.mjs`

- [x] Run the workflow contract and validate every resolved CLI command.
- [x] Run the existing production-job consistency contract to prove remote release lanes are unchanged.
- [x] Run `node scripts/lightweaver-dev.mjs checkpoint`.
- [ ] Commit, push, obtain `Tests / gate`, merge, deploy, and prove the exact Studio build live.
