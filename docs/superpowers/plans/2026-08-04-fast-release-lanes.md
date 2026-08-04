# Fast Release Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicate nineteen-minute release gates with one focused, exact-revision fast gate while preserving signing, artifact verification, deployment staging, and strict live proof.

**Architecture:** A repository-owned changed-path classifier selects focused CI lanes. Tests owns the single aggregate source gate; the signer consumes its exact successful main revision; deploy consumes either the tested UI revision or exact signer revision and runs only artifact/build/live checks.

**Tech Stack:** GitHub Actions, Node.js 22, npm scripts, Playwright, PlatformIO, Cloudflare Pages.

---

### Task 1: Changed-lane classifier

**Files:**
- Create: `scripts/ci-changed-lanes.mjs`
- Create: `scripts/ci-changed-lanes.test.mjs`

- [ ] **Step 1: Write failing table tests** for UI-only, `lightweaver/src/lib/**`, firmware-only, signer-artifact-only, workflow/config, and zero-before-SHA inputs. Assert booleans for `source`, `browser`, `cloud`, `production`, `firmware`, and `artifact`.
- [ ] **Step 2: Run** `node --test scripts/ci-changed-lanes.test.mjs` and confirm the missing module/test failures.
- [ ] **Step 3: Implement** a dependency-free Node classifier that reads explicit path arguments or GitHub base/head environment, uses conservative prefix sets, and emits JSON plus GitHub outputs when `GITHUB_OUTPUT` is present.
- [ ] **Step 4: Run** `node --test scripts/ci-changed-lanes.test.mjs` and confirm all cases pass.
- [ ] **Step 5: Commit** `scripts/ci-changed-lanes.mjs` and its test.

### Task 2: Focused npm contracts

**Files:**
- Modify: `lightweaver/package.json`
- Modify: `scripts/production-job-consistency.test.mjs`

- [ ] **Step 1: Add failing workflow-contract assertions** that generated artifacts do not select firmware signing, every selected lane feeds an aggregate gate, and exact signer revisions are required by deployment.
- [ ] **Step 2: Run** `node --test scripts/production-job-consistency.test.mjs` and confirm the new assertions fail against current workflows.
- [ ] **Step 3: Add scripts** `ci:source-build`, `ci:browser-smoke`, `ci:cloud`, `ci:production`, `ci:firmware-sensitive`, and `ci:artifact` by composing existing test/build commands; leave `launch:source` and `launch:check` unchanged.
- [ ] **Step 4: Run each new script** and record success independently.
- [ ] **Step 5: Commit** package and contract-test changes.

### Task 3: Single source gate and fast deploy graph

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/build-firmware.yml`
- Modify: `.github/workflows/deploy-site.yml`
- Test: `scripts/production-job-consistency.test.mjs`

- [ ] **Step 1: Refactor Tests** to trigger on pull requests, merge groups, and main only; run classifier first; execute selected focused lanes in parallel; finish with an `if: always()` aggregate `gate` job.
- [ ] **Step 2: Refactor signer** to consume a successful Tests `workflow_run`, check out `workflow_run.head_sha`, no-op unless firmware-sensitive, retain protected signing/stale-input refusal, and dispatch deploy with the exact signer commit SHA.
- [ ] **Step 3: Refactor deploy** to remove the reusable full Tests job and raw racing push behavior; accept exact tested/signer revisions, reject stale main, run `ci:artifact`, then preserve migrations, build/stage/upload, and strict production proof.
- [ ] **Step 4: Add a scheduled/manual exhaustive workflow** that runs unchanged `launch:check` without blocking the fast deploy.
- [ ] **Step 5: Run** classifier tests, workflow contracts, every focused npm script, and YAML syntax validation.
- [ ] **Step 6: Commit** the workflow graph.

### Task 4: Repository enforcement and release proof

**Files:**
- Modify: `docs/deployment-checklist.md`

- [ ] **Step 1: Document** `Tests / gate` as the required check, up-to-date merge requirement, signer exception, expected timings, and async exhaustive-run response.
- [ ] **Step 2: Push the branch and verify** a pull request runs one focused gate rather than duplicate push/PR monoliths.
- [ ] **Step 3: Enable branch protection** requiring `Tests / gate`, dismissing stale approvals/up-to-date enforcement as supported, and blocking ordinary direct pushes.
- [ ] **Step 4: Merge only after the fast gate passes**, follow signer/deploy exact revisions, and prove the live no-store release marker and staged graph.

