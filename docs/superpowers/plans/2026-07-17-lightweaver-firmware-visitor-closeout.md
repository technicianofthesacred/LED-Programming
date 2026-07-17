# Lightweaver Firmware Visitor Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure settled visitor controls are both visually and semantically enabled, and make the rollback contract part of the normal launch gate.

**Architecture:** Preserve the existing embedded confirmed-control state machine and API. Correct only settlement ordering, then register its focused source-level regression in the existing core chain and rebuild the shipped firmware image.

**Tech Stack:** ESP32-S3 C++, embedded JavaScript, Node contract tests, PlatformIO.

---

### Task 1: Settle scene semantics after pending state clears

**Files:**
- Modify: `firmware/lightweaver-controller/tests/visitor-control-rollback.mjs`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`

- [ ] **Step 1: Write the failing settlement-order test**

Extend the extracted-control harness so success and failure must record this ordering:

```js
assert.deepEqual(successEvents.slice(-2), ['enabled', 'render:confirmed']);
assert.deepEqual(failureEvents.slice(-2), ['enabled', 'render:previous-confirmed']);
```

Also assert scene tiles finish with `aria-disabled="false"` after confirmation, rollback, and Retry success.

- [ ] **Step 2: Run and confirm RED**

```bash
node firmware/lightweaver-controller/tests/visitor-control-rollback.mjs
```

- [ ] **Step 3: Correct settlement order**

Within `makeConfirmedControl`, use this exact sequence:

```js
// success
confirmed = value; state = 'confirmed'; setDisabled(false); render(confirmed); clearControlError(owner);
// failure
failed = value; state = 'failed'; setDisabled(false); render(confirmed); showControlError(message, retry, owner);
```

Keep request IDs, `/api/control`, payloads, and response schema unchanged.

- [ ] **Step 4: Verify focused firmware contracts and commit**

```bash
node firmware/lightweaver-controller/tests/visitor-control-rollback.mjs
node firmware/lightweaver-controller/tests/web-pattern-thumbnails.mjs
node firmware/lightweaver-controller/tests/control-sync-order.mjs
node firmware/lightweaver-controller/tests/bounded-runtime-request.mjs
git commit -m "fix(firmware): settle visitor controls accessibly"
```

### Task 2: Register the regression and rebuild the distributable image

**Files:**
- Modify: `lightweaver/package.json` (`test:core` script only)
- Modify: `firmware/lightweaver-controller-esp32s3-factory.bin`

- [ ] **Step 1: Add the test to the normal core sequence**

Insert this command before factory freshness:

```json
"node ../firmware/lightweaver-controller/tests/visitor-control-rollback.mjs"
```

- [ ] **Step 2: Compile and rebuild**

```bash
pio run -d firmware/lightweaver-controller -e esp32-s3-n16r8
firmware/lightweaver-controller/scripts/build-factory-bin.sh
cd lightweaver
npm run firmware:check-bin
```

- [ ] **Step 3: Verify the registered path and commit**

```bash
cd lightweaver
npm run test:core
git add package.json ../firmware/lightweaver-controller-esp32s3-factory.bin
git commit -m "test: gate visitor rollback in launch checks"
```
