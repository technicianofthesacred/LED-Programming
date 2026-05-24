# Standalone Sequence Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first Lightweaver app support for the standalone ESP32-S3 + microSD sequence controller.

**Architecture:** Add a focused `standaloneController` library for controller profiles, four-output connector defaults, `.lwseq` frame packaging, and microSD package manifests. Persist standalone controller settings in the project model, then expose a new export target in the existing `ExportDialog` so Lightweaver can download controller-ready JSON packages and raw `.lwseq` frame files.

**Tech Stack:** Vite, React, plain ES modules, Node `assert` audit tests, existing Lightweaver frame renderer and export dialog.

---

## File Structure

- Create `lightweaver/src/lib/standaloneController.js`
  - Owns standalone controller defaults, connector normalization, profile generation, file naming, size estimates, and `.lwseq` byte serialization.
- Modify `lightweaver/src/lib/projectModel.js`
  - Adds persisted `devices.standaloneController` defaults and migration.
- Modify `lightweaver/src/lib/export.js`
  - Re-exports package helpers or delegates to `standaloneController.js` where useful.
- Modify `lightweaver/src/components/ExportDialog.jsx`
  - Adds "Lightweaver Standalone Controller" target and `.lwseq` / microSD package formats.
- Modify `lightweaver/tests/project-frame-audit.mjs`
  - Adds direct assertions for standalone profile defaults, connector normalization, size estimates, `.lwseq` header/payload layout, and project migration.

## Task 1: Standalone Controller Library

**Files:**
- Create: `lightweaver/src/lib/standaloneController.js`
- Test: `lightweaver/tests/project-frame-audit.mjs`

- [ ] **Step 1: Write the failing test**

Add this import to `lightweaver/tests/project-frame-audit.mjs`:

```js
import {
  LWSEQ_HEADER_BYTES,
  buildStandaloneProfile,
  estimateLwseqBytes,
  makeStandalonePackage,
  normalizeStandaloneOutputs,
  toLwseqBytes,
} from '../src/lib/standaloneController.js';
```

Add this assertion block after the WLED device/controller assertions:

```js
const standaloneOutputs = normalizeStandaloneOutputs([
  { id: 'outer', pin: 16, pixels: 260 },
  { id: 'inner', pin: 17, pixels: 180 },
  { id: '', pin: 18, pixels: -5 },
  { id: 'unused', pin: null, pixels: 0 },
  { id: 'ignored', pin: 21, pixels: 50 },
]);
assert.deepEqual(standaloneOutputs, [
  { id: 'outer', name: 'Outer', pin: 16, pixels: 260 },
  { id: 'inner', name: 'Inner', pin: 17, pixels: 180 },
]);
assert.deepEqual(estimateLwseqBytes({ pixels: 440, fps: 24, duration: 10 }), {
  headerBytes: LWSEQ_HEADER_BYTES,
  payloadBytes: 316800,
  totalBytes: 316800 + LWSEQ_HEADER_BYTES,
});

const standaloneProfile = buildStandaloneProfile({
  projectName: 'Spiral 01',
  outputs: standaloneOutputs,
  looks: [{ id: 'ember', label: 'Ember', file: '/sequences/001-ember.lwseq', fps: 24 }],
});
assert.equal(standaloneProfile.piece.id, 'spiral-01');
assert.equal(standaloneProfile.outputs.length, 2);
assert.equal(standaloneProfile.controls.encoder.press, 6);
assert.equal(standaloneProfile.startupLook, 'ember');

const lwseq = toLwseqBytes([
  [{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }],
  [{ r: 7, g: 8, b: 9 }, { r: 10, g: 11, b: 12 }],
], { fps: 24, outputs: [{ id: 'main', pin: 16, pixels: 2 }] });
assert.equal(lwseq.byteLength, LWSEQ_HEADER_BYTES + 12);
assert.equal(String.fromCharCode(...lwseq.slice(0, 6)), 'LWSEQ1');
assert.deepEqual([...lwseq.slice(LWSEQ_HEADER_BYTES)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const standalonePackage = makeStandalonePackage({
  projectName: 'Spiral 01',
  outputs: standaloneOutputs,
  sequenceFilename: '001-ember.lwseq',
  frames: [[{ r: 1, g: 2, b: 3 }]],
  fps: 24,
});
assert.equal(standalonePackage.files['/lightweaver.json'].piece.name, 'Spiral 01');
assert.equal(standalonePackage.files['/sequences/001-ember.lwseq'].encoding, 'base64');
assert.equal(standalonePackage.files['/sequences/001-ember.lwseq'].bytes, LWSEQ_HEADER_BYTES + 3);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd lightweaver && npm run test:core
```

Expected: FAIL with `Cannot find module '../src/lib/standaloneController.js'`.

- [ ] **Step 3: Add standalone controller implementation**

Create `lightweaver/src/lib/standaloneController.js`:

```js
export const LWSEQ_HEADER_BYTES = 64;
export const DEFAULT_STANDALONE_OUTPUTS = [
  { id: 'out1', name: 'Output 1', pin: 16, pixels: 0 },
  { id: 'out2', name: 'Output 2', pin: 17, pixels: 0 },
  { id: 'out3', name: 'Output 3', pin: 18, pixels: 0 },
  { id: 'out4', name: 'Output 4', pin: 21, pixels: 0 },
];

export const DEFAULT_STANDALONE_CONTROLS = {
  encoder: { a: 4, b: 5, press: 6 },
  previous: 7,
  next: 8,
  blackout: 9,
  brightness: 1,
  statusLed: 2,
};

export function normalizeStandaloneOutputs(outputs = DEFAULT_STANDALONE_OUTPUTS) {
  return outputs
    .slice(0, 4)
    .map((output, index) => {
      const id = sanitizeId(output.id || `out${index + 1}`);
      const pixels = Math.max(0, Math.floor(Number(output.pixels || output.pixelCount || 0)));
      const pin = Number.isFinite(Number(output.pin)) ? Number(output.pin) : null;
      return {
        id,
        name: output.name || titleFromId(id) || `Output ${index + 1}`,
        pin,
        pixels,
      };
    })
    .filter(output => output.pin != null && output.pixels > 0);
}

export function buildStandaloneProfile({
  projectName = 'Untitled Project',
  outputs = DEFAULT_STANDALONE_OUTPUTS,
  controls = DEFAULT_STANDALONE_CONTROLS,
  looks = [],
  led = {},
} = {}) {
  const normalizedOutputs = normalizeStandaloneOutputs(outputs);
  const normalizedLooks = looks.length
    ? looks.map((look, index) => normalizeLook(look, index))
    : [normalizeLook({ id: 'timeline-render', label: 'Timeline Render', file: '/sequences/001-timeline-render.lwseq' }, 0)];
  return {
    version: 1,
    piece: {
      id: sanitizeId(projectName),
      name: projectName || 'Untitled Project',
    },
    led: {
      type: led.type || 'WS2815',
      colorOrder: led.colorOrder || 'GRB',
      brightnessLimit: clamp01(led.brightnessLimit ?? 0.45),
    },
    outputs: normalizedOutputs,
    controls: {
      encoder: { ...DEFAULT_STANDALONE_CONTROLS.encoder, ...(controls.encoder || {}) },
      previous: controls.previous ?? DEFAULT_STANDALONE_CONTROLS.previous,
      next: controls.next ?? DEFAULT_STANDALONE_CONTROLS.next,
      blackout: controls.blackout ?? DEFAULT_STANDALONE_CONTROLS.blackout,
      brightness: controls.brightness ?? DEFAULT_STANDALONE_CONTROLS.brightness,
      statusLed: controls.statusLed ?? DEFAULT_STANDALONE_CONTROLS.statusLed,
    },
    looks: normalizedLooks,
    startupLook: normalizedLooks[0]?.id || '',
  };
}

export function estimateLwseqBytes({ pixels = 0, fps = 24, duration = 0, frames = null } = {}) {
  const frameCount = frames == null ? Math.max(0, Math.round(Number(duration || 0) * Number(fps || 0))) : Math.max(0, Number(frames) || 0);
  const payloadBytes = Math.max(0, Number(pixels) || 0) * 3 * frameCount;
  return {
    headerBytes: LWSEQ_HEADER_BYTES,
    payloadBytes,
    totalBytes: LWSEQ_HEADER_BYTES + payloadBytes,
  };
}

export function toLwseqBytes(frames = [], { fps = 24, outputs = DEFAULT_STANDALONE_OUTPUTS } = {}) {
  const normalizedOutputs = normalizeStandaloneOutputs(outputs);
  const expectedPixels = normalizedOutputs.reduce((sum, output) => sum + output.pixels, 0) || (frames[0]?.length || 0);
  const frameCount = frames.length;
  const payloadBytes = expectedPixels * 3 * frameCount;
  const bytes = new Uint8Array(LWSEQ_HEADER_BYTES + payloadBytes);
  bytes.set([76, 87, 83, 69, 81, 49], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  view.setUint16(10, normalizedOutputs.length || 1, true);
  view.setUint32(12, expectedPixels, true);
  view.setUint32(16, frameCount, true);
  view.setUint16(20, Math.round(Number(fps) || 24), true);
  view.setUint16(22, 3, true);
  let cursor = LWSEQ_HEADER_BYTES;
  for (const frame of frames) {
    if (frame.length !== expectedPixels) {
      throw new RangeError(`Frame has ${frame.length} pixels, expected ${expectedPixels}`);
    }
    for (const pixel of frame) {
      bytes[cursor++] = clampByte(pixel.r);
      bytes[cursor++] = clampByte(pixel.g);
      bytes[cursor++] = clampByte(pixel.b);
    }
  }
  return bytes;
}

export function makeStandalonePackage({
  projectName = 'Untitled Project',
  outputs = DEFAULT_STANDALONE_OUTPUTS,
  controls = DEFAULT_STANDALONE_CONTROLS,
  sequenceFilename = '001-timeline-render.lwseq',
  frames = [],
  fps = 24,
  loop = true,
  led = {},
} = {}) {
  const filePath = `/sequences/${sequenceFilename.replace(/^\/+/, '')}`;
  const profile = buildStandaloneProfile({
    projectName,
    outputs,
    controls,
    led,
    looks: [{
      id: sequenceFilename.replace(/\.[^.]+$/, ''),
      label: projectName,
      mode: 'sequence',
      file: filePath,
      fps,
      loop,
    }],
  });
  const sequence = toLwseqBytes(frames, { fps, outputs });
  return {
    app: 'Lightweaver',
    format: 'standalone-controller-package',
    version: 1,
    files: {
      '/lightweaver.json': profile,
      [filePath]: {
        encoding: 'base64',
        bytes: sequence.byteLength,
        data: uint8ToBase64(sequence),
      },
    },
  };
}

function normalizeLook(look = {}, index = 0) {
  const id = sanitizeId(look.id || look.label || `look-${index + 1}`);
  return {
    id,
    label: look.label || titleFromId(id),
    mode: look.mode || 'sequence',
    file: look.file || `/sequences/${String(index + 1).padStart(3, '0')}-${id}.lwseq`,
    fps: Math.round(Number(look.fps || 24)),
    loop: look.loop ?? true,
    fadeOutMs: Math.max(0, Math.round(Number(look.fadeOutMs ?? 800))),
    fadeInMs: Math.max(0, Math.round(Number(look.fadeInMs ?? 1200))),
    brightness: clamp01(look.brightness ?? 0.35),
  };
}

function sanitizeId(value) {
  return String(value || 'untitled')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function titleFromId(id) {
  return String(id || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampByte(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function uint8ToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd lightweaver && npm run test:core
```

Expected: PASS with `project-frame-audit passed`.

## Task 2: Persist Standalone Controller Settings

**Files:**
- Modify: `lightweaver/src/lib/projectModel.js`
- Test: `lightweaver/tests/project-frame-audit.mjs`

- [ ] **Step 1: Write the failing test**

Add this assertion after `const defaultProject = createDefaultProject();`:

```js
assert.equal(defaultProject.devices.standaloneController.outputs.length, 4);
assert.equal(defaultProject.devices.standaloneController.outputs[0].pin, 16);
assert.equal(defaultProject.devices.standaloneController.controls.blackout, 9);
```

Add this assertion after the existing `migratedV3` checks:

```js
assert.equal(migratedV3.devices.standaloneController.outputs.length, 4);
assert.equal(migrateProject({
  version: PROJECT_VERSION,
  devices: {
    standaloneController: {
      outputs: [{ id: 'outer', name: 'Outer', pin: 32, pixels: 144 }],
      controls: { blackout: 12 },
    },
  },
}).devices.standaloneController.controls.blackout, 12);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd lightweaver && npm run test:core
```

Expected: FAIL because `standaloneController` is missing on `devices`.

- [ ] **Step 3: Add project model defaults and migration**

In `lightweaver/src/lib/projectModel.js`, import defaults:

```js
import {
  DEFAULT_STANDALONE_CONTROLS,
  DEFAULT_STANDALONE_OUTPUTS,
} from './standaloneController.js';
```

Add helper:

```js
function defaultStandaloneController(overrides = {}) {
  return {
    outputs: overrides.outputs || DEFAULT_STANDALONE_OUTPUTS,
    controls: {
      ...DEFAULT_STANDALONE_CONTROLS,
      ...(overrides.controls || {}),
      encoder: {
        ...DEFAULT_STANDALONE_CONTROLS.encoder,
        ...(overrides.controls?.encoder || {}),
      },
    },
    led: {
      type: 'WS2815',
      colorOrder: 'GRB',
      brightnessLimit: 0.45,
      ...(overrides.led || {}),
    },
  };
}
```

Change default `devices` to include:

```js
standaloneController: defaultStandaloneController(),
```

In both migration paths, merge:

```js
standaloneController: defaultStandaloneController(data.devices?.standaloneController),
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd lightweaver && npm run test:core
```

Expected: PASS with `project-frame-audit passed`.

## Task 3: Export Dialog Connector

**Files:**
- Modify: `lightweaver/src/components/ExportDialog.jsx`
- Test: `lightweaver/tests/project-frame-audit.mjs`

- [ ] **Step 1: Write the failing test**

This task is UI integration, so the behavior is covered indirectly by Task 1/2 unit assertions and the build in Step 4. No production logic should be added here until Tasks 1/2 are green.

- [ ] **Step 2: Add standalone target and formats**

Import helpers:

```js
import {
  buildStandaloneProfile,
  estimateLwseqBytes,
  makeStandalonePackage,
  toLwseqBytes,
} from '../lib/standaloneController.js';
```

Add target:

```js
{ id: 'standalone', name: 'Lightweaver Controller', sub: 'ESP32-S3 + microSD package', tag: 'SD', hw: 'ESP32-S3' },
```

Add formats:

```js
{ id: 'lwpackage', name: 'microSD package JSON', sub: 'lightweaver.json + base64 .lwseq files', ext: '.json' },
{ id: 'lwseq', name: 'Raw .lwseq sequence', sub: 'Standalone controller frame file', ext: '.lwseq' },
```

Use `project.devices.standaloneController` when target is `standalone`. For `lwpackage`, call `makeStandalonePackage()`. For `lwseq`, call `toLwseqBytes()`.

- [ ] **Step 3: Wire byte estimates and summary**

When target is `standalone`, calculate size from total LEDs rather than Art-Net universes:

```js
const standaloneBytes = estimateLwseqBytes({ pixels: totalLEDs, fps, duration: showDuration });
```

Display target as `ESP32-S3` and destination as `microSD package`.

- [ ] **Step 4: Run build and core tests**

Run:

```bash
cd lightweaver && npm run test:core && npm run build
```

Expected: PASS for tests and Vite production build.

## Task 4: Documentation Hook

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `docs/superpowers/specs/2026-05-24-standalone-sequence-controller-design.md`

- [ ] **Step 1: Update roadmap**

Add an open software follow-up:

```md
- [ ] Standalone controller export: generate `lightweaver.json` and `.lwseq` microSD packages for ESP32-S3 playback.
```

- [ ] **Step 2: Update spec status**

Change:

```md
Status: Draft for user review
```

to:

```md
Status: Approved; Phase 1 wiring in progress
```

- [ ] **Step 3: Verify docs and diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; changed files are only the plan, docs, tests, and Lightweaver app files from this work.

## Final Verification

- [ ] Run:

```bash
cd lightweaver && npm run test:core && npm run build
```

Expected:

- `project-frame-audit passed`
- Vite build exits 0

- [ ] Run:

```bash
git diff --check
git status --short
```

Expected:

- no whitespace errors
- only intended files modified
