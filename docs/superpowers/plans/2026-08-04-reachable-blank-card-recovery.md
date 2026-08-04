# Reachable Blank-Card Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify reachable factory-default cards as blank despite stale WiFi recovery state and adopt safe URL-supplied card IPs immediately.

**Architecture:** Card readiness separates authoritative blank storage evidence from runtime command readiness. Connection bootstrap promotes a validated local `cardHost` hint into discovery without weakening local-host validation; all project-switch and command authorization barriers remain downstream.

**Tech Stack:** React, browser Fetch, Node test runner, Playwright, ESP32 Lightweaver status contract.

---

### Task 1: Reproduce live blank classification

**Files:**
- Modify: `lightweaver/src/lib/cardReadiness.test.js`
- Modify: `lightweaver/src/lib/cardReadiness.js`

- [ ] **Step 1: Add a failing test** using the live shape: stable card identity, provisioning contract 1, `runtimePhase: recovering`, `mode: factory-flash`, `source: defaults`, `knownGoodProject: false`, `commandReady: false`, `outputReady: false`, and empty project identity. Expect `state: blank`, `blank: true`, and `patternAccess: blank`.
- [ ] **Step 2: Run** `node --test src/lib/cardReadiness.test.js` and confirm it currently returns `runtime-not-ready`.
- [ ] **Step 3: Implement** blank classification after identity/contract checks but before the runtime-ready rejection; require authoritative factory markers and absence of a known-good installed project.
- [ ] **Step 4: Add negative tests** proving recovering configured cards, wrong-card identities, and incomplete contracts remain recovery/error states.
- [ ] **Step 5: Run** the readiness tests and commit.

### Task 2: Adopt safe URL card host

**Files:**
- Modify: `lightweaver/src/lib/cardConnection.js`
- Modify: `lightweaver/src/lib/cardConnection.test.js`
- Modify: `lightweaver/src/v3/app.jsx`

- [ ] **Step 1: Add failing tests** proving a private IPv4 `cardHost` query is selected before mDNS, public hosts are rejected, and a safe hint dispatches the existing host-change event once.
- [ ] **Step 2: Run** the connection tests and confirm the URL hint is currently ignored by direct status discovery.
- [ ] **Step 3: Add** a small exported bootstrap helper that reads `cardHost`/`host`, validates with `isLocalCardHost`, remembers/writes it, and returns the selected host. Call it once before `useCardStatus` begins polling.
- [ ] **Step 4: Run** connection and app source-contract tests and commit.

### Task 3: Browser workflow regression

**Files:**
- Modify: `lightweaver/tests/card-workspace.spec.ts`

- [ ] **Step 1: Add a failing browser scenario** whose card status matches the live reachable factory-default/recovering payload and whose URL contains the card IP. Assert Hardware shows the blank-card action rather than indefinite Checking.
- [ ] **Step 2: Run** the focused Playwright test and confirm failure before integration.
- [ ] **Step 3: Verify** the implemented readiness/host changes make the scenario pass without issuing `/api/control` or `/api/config` automatically.
- [ ] **Step 4: Run** the exact-current-project auto-open and autosave-before-switch regression scenarios.
- [ ] **Step 5: Commit** the browser regression.

### Task 4: Integrated verification

**Files:**
- No production changes expected.

- [ ] **Step 1: Run** readiness, connection, authorization, project resolver, and save-barrier unit tests.
- [ ] **Step 2: Run** focused card-workspace and Patterns browser tests.
- [ ] **Step 3: Run** `npm run build`, `npm run stage:pages`, and `npm run verify:pages`.
- [ ] **Step 4: Probe the physical card by IP** and confirm Studio renders Blank while commands remain blocked until install.

