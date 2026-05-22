# AI Pattern Creator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a draft-first AI assistant drawer that can create, transform, refine, validate, preview, and accept editable Lightweaver patterns.

**Architecture:** Extract custom pattern storage into a shared registry so built-in and custom patterns resolve everywhere: Cards, Code, Preview, frame rendering, and AI acceptance. Add a server-side OpenAI Responses API endpoint that returns strict structured drafts, then validate drafts in the client before showing them in the assistant drawer. Keep all AI output draft-only until the user accepts it.

**Tech Stack:** React 18, Vite, Express, OpenAI JavaScript SDK, Zod, localStorage-backed custom pattern registry, existing Lightweaver JS pattern compiler, existing Playwright and Node assertion tests.

---

## References

- Design spec: `docs/superpowers/specs/2026-05-22-ai-pattern-creator-design.md`
- OpenAI SDK docs: `https://developers.openai.com/api/docs/libraries`
- OpenAI structured output docs: `https://developers.openai.com/api/docs/guides/structured-outputs`
- OpenAI text generation docs: `https://developers.openai.com/api/docs/guides/text`

## File Structure

- Create `lightweaver/src/lib/patternParams.js`
  - Owns shared `parseParamsFromCode(code)` behavior. Removes duplicate parser logic from `data.js` and `PatternModes.jsx`.
- Create `lightweaver/src/lib/customPatterns.js`
  - Owns localStorage keys, custom pattern CRUD, accept behavior, revision history, and the `lw:custom-updated` event.
- Create `lightweaver/src/lib/patternRegistry.js`
  - Provides `getPatternById(id)`, `listPatterns()`, `getPatternCode(id)`, and `isBuiltInPattern(id)` across built-in plus custom patterns.
- Modify `lightweaver/src/data.js`
  - Uses the shared param parser.
- Modify `lightweaver/src/lib/frameEngine.js`
  - Resolves custom pattern code through the registry before compiling.
- Modify `lightweaver/src/components/PatternModes.jsx`
  - Uses shared registry and custom storage helpers.
  - Removes local custom pattern helper definitions.
  - Loads custom pattern code in Code Mode.
- Create `lightweaver/src/lib/aiPatternDraft.js`
  - Owns draft shape validation, unsafe token checks, compile checks, and preview render checks.
- Create `lightweaver/src/lib/aiPatternClient.js`
  - Browser helper for `POST /api/ai/pattern`.
- Create `lightweaver/server/aiPattern.js`
  - Express router and pure helper functions for the OpenAI draft endpoint.
- Modify `lightweaver/server/index.js`
  - Mounts the AI route before static file serving.
- Create `lightweaver/src/components/AiPatternAssistant.jsx`
  - Assistant drawer UI, draft state, refine requests, errors, and accept actions.
- Modify `lightweaver/src/App.jsx`
  - Wires the assistant drawer into `PatternPanel` with current pattern, palette, params, strips, and save callbacks.
- Modify `lightweaver/src/main.css`
  - Adds assistant drawer, messages, draft card, and error styles.
- Modify `lightweaver/package.json` and `lightweaver/package-lock.json`
  - Adds `openai` and `zod`.
- Modify `lightweaver/tests/project-frame-audit.mjs`
  - Adds deterministic registry and draft validation assertions.
- Create `lightweaver/tests/ai-pattern-assistant.spec.ts`
  - Playwright flow with mocked `/api/ai/pattern`.

---

### Task 1: Shared Pattern Registry

**Files:**
- Create: `lightweaver/src/lib/patternParams.js`
- Create: `lightweaver/src/lib/customPatterns.js`
- Create: `lightweaver/src/lib/patternRegistry.js`
- Modify: `lightweaver/src/data.js`
- Modify: `lightweaver/src/lib/frameEngine.js`
- Modify: `lightweaver/src/components/PatternModes.jsx`
- Test: `lightweaver/tests/project-frame-audit.mjs`

- [ ] **Step 1: Write failing registry tests**

Add these imports near the top of `lightweaver/tests/project-frame-audit.mjs`:

```js
import {
  CUSTOM_PATTERNS_EVENT,
  CUSTOM_PATTERNS_KEY,
  CUSTOM_PATTERN_REVISIONS_KEY,
  buildCustomPatternEntry,
  buildCustomPatternId,
  deleteCustomPattern,
  loadCustomPatterns,
  saveCustomPattern,
  updateCustomPattern,
} from '../src/lib/customPatterns.js';
import {
  getPatternById,
  getPatternCode,
  isBuiltInPattern,
  listPatterns,
} from '../src/lib/patternRegistry.js';
import { parseParamsFromCode } from '../src/lib/patternParams.js';
```

Add this block after the duplicate built-in ID assertion:

```js
const memoryStorage = (() => {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
})();

const parsedParams = parseParamsFromCode('// @param speed float 0.25 0.05 1.0\nreturn rgb(params.speed,0,0);');
assert.deepEqual(parsedParams, [{ name: 'speed', value: 0.25, min: 0.05, max: 1, step: 0.01 }]);

assert.equal(buildCustomPatternId('Aurora Glass Drift'), 'custom_aurora_glass_drift');
assert.match(buildCustomPatternId('###'), /^custom_[a-z0-9]+$/);

const customEntry = buildCustomPatternEntry({
  name: 'Aurora Glass Drift',
  code: 'return hsv(time, 1, 1);',
  palette: ['#102a2b', '#57e7c1'],
});
assert.equal(customEntry.id, 'custom_aurora_glass_drift');
assert.equal(customEntry.custom, true);
assert.equal(customEntry.preview, 'linear-gradient(135deg,#102a2b,#57e7c1)');

saveCustomPattern(customEntry, { storage: memoryStorage, dispatch: false });
assert.equal(loadCustomPatterns({ storage: memoryStorage }).length, 1);
assert.equal(getPatternById('custom_aurora_glass_drift', { storage: memoryStorage }).name, 'Aurora Glass Drift');
assert.equal(getPatternCode('custom_aurora_glass_drift', { storage: memoryStorage }), 'return hsv(time, 1, 1);');
assert.equal(isBuiltInPattern('aurora'), true);
assert.equal(isBuiltInPattern('custom_aurora_glass_drift', { storage: memoryStorage }), false);
assert.ok(listPatterns({ storage: memoryStorage }).some(pattern => pattern.id === 'custom_aurora_glass_drift'));

updateCustomPattern('custom_aurora_glass_drift', {
  name: 'Aurora Glass Drift',
  code: 'return hsv(0.6, 1, 1);',
  palette: ['#000000', '#ffffff'],
}, { storage: memoryStorage, dispatch: false });
const revisions = JSON.parse(memoryStorage.getItem(CUSTOM_PATTERN_REVISIONS_KEY));
assert.equal(revisions.custom_aurora_glass_drift.length, 1);
assert.equal(revisions.custom_aurora_glass_drift[0].code, 'return hsv(time, 1, 1);');
assert.equal(getPatternCode('custom_aurora_glass_drift', { storage: memoryStorage }), 'return hsv(0.6, 1, 1);');

deleteCustomPattern('custom_aurora_glass_drift', { storage: memoryStorage, dispatch: false });
assert.equal(loadCustomPatterns({ storage: memoryStorage }).length, 0);
assert.equal(CUSTOM_PATTERNS_EVENT, 'lw:custom-updated');
assert.equal(CUSTOM_PATTERNS_KEY, 'lw_custom_patterns');
```

- [ ] **Step 2: Run the failing core audit**

Run:

```bash
cd lightweaver
npm run test:core
```

Expected: FAIL with module resolution errors for `customPatterns.js`, `patternRegistry.js`, and `patternParams.js`.

- [ ] **Step 3: Add shared param parser**

Create `lightweaver/src/lib/patternParams.js`:

```js
export function parseParamsFromCode(code = '') {
  const re = /\/\/ @param\s+(\w+)\s+\w+\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;
  const params = [];
  let match;
  while ((match = re.exec(String(code))) !== null) {
    const value = Number.parseFloat(match[2]);
    const min = Number.parseFloat(match[3]);
    const max = Number.parseFloat(match[4]);
    if (![value, min, max].every(Number.isFinite)) continue;
    const range = max - min;
    const step = range <= 1 ? 0.01 : range <= 10 ? 0.1 : 0.5;
    params.push({ name: match[1], value, min, max, step });
  }
  return params;
}
```

- [ ] **Step 4: Add custom pattern storage**

Create `lightweaver/src/lib/customPatterns.js`:

```js
export const CUSTOM_PATTERNS_KEY = 'lw_custom_patterns';
export const CUSTOM_PATTERN_REVISIONS_KEY = 'lw_custom_pattern_revisions';
export const CUSTOM_PATTERNS_EVENT = 'lw:custom-updated';

function safeStorage(storage = globalThis.localStorage) {
  return storage || null;
}

function safeDispatch(dispatch = true) {
  if (!dispatch || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CUSTOM_PATTERNS_EVENT));
}

export function buildCustomPatternId(name, existingIds = []) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  const seed = base ? `custom_${base}` : `custom_${Date.now().toString(36)}`;
  let id = seed;
  let i = 2;
  while (existingIds.includes(id)) {
    id = `${seed}_${i}`;
    i += 1;
  }
  return id;
}

export function previewFromPalette(palette = []) {
  const colors = Array.isArray(palette) && palette.length ? palette : ['#667eea', '#764ba2'];
  return `linear-gradient(135deg,${colors.join(',')})`;
}

export function loadCustomPatterns({ storage } = {}) {
  const target = safeStorage(storage);
  if (!target) return [];
  try {
    const parsed = JSON.parse(target.getItem(CUSTOM_PATTERNS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(pattern => pattern?.id && pattern?.code) : [];
  } catch {
    return [];
  }
}

export function writeCustomPatterns(patterns, { storage, dispatch = true } = {}) {
  const target = safeStorage(storage);
  if (!target) return;
  target.setItem(CUSTOM_PATTERNS_KEY, JSON.stringify(patterns));
  safeDispatch(dispatch);
}

export function buildCustomPatternEntry({ id, name, description = '', code, palette = [], params = {}, preview }) {
  const finalName = String(name || 'AI Pattern').trim();
  return {
    id: id || buildCustomPatternId(finalName),
    name: finalName,
    desc: description || 'Custom Lightweaver pattern',
    code: String(code || 'return rgb(0,0,0);'),
    palette: Array.isArray(palette) ? palette : [],
    params: params && typeof params === 'object' ? params : {},
    preview: preview || previewFromPalette(palette),
    custom: true,
    updatedAt: Date.now(),
  };
}

function loadRevisionMap(storage) {
  const target = safeStorage(storage);
  if (!target) return {};
  try {
    const parsed = JSON.parse(target.getItem(CUSTOM_PATTERN_REVISIONS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveRevision(pattern, { storage } = {}) {
  const target = safeStorage(storage);
  if (!target || !pattern?.id) return;
  const revisions = loadRevisionMap(target);
  const prev = Array.isArray(revisions[pattern.id]) ? revisions[pattern.id] : [];
  revisions[pattern.id] = [
    {
      savedAt: Date.now(),
      name: pattern.name,
      code: pattern.code,
      palette: pattern.palette || [],
      params: pattern.params || {},
      preview: pattern.preview,
    },
    ...prev,
  ].slice(0, 10);
  target.setItem(CUSTOM_PATTERN_REVISIONS_KEY, JSON.stringify(revisions));
}

export function saveCustomPattern(entry, { storage, dispatch = true } = {}) {
  const existing = loadCustomPatterns({ storage });
  const id = entry.id || buildCustomPatternId(entry.name, existing.map(pattern => pattern.id));
  const nextEntry = buildCustomPatternEntry({ ...entry, id });
  writeCustomPatterns([nextEntry, ...existing.filter(pattern => pattern.id !== id)], { storage, dispatch });
  return nextEntry;
}

export function updateCustomPattern(id, patch, { storage, dispatch = true } = {}) {
  const existing = loadCustomPatterns({ storage });
  const current = existing.find(pattern => pattern.id === id);
  if (!current) return saveCustomPattern({ ...patch, id }, { storage, dispatch });
  saveRevision(current, { storage });
  const nextEntry = buildCustomPatternEntry({
    ...current,
    ...patch,
    id,
    name: patch.name || current.name,
    description: patch.description || patch.desc || current.desc,
    code: patch.code || current.code,
    palette: patch.palette || current.palette || [],
    params: patch.params || current.params || {},
  });
  writeCustomPatterns([nextEntry, ...existing.filter(pattern => pattern.id !== id)], { storage, dispatch });
  return nextEntry;
}

export function deleteCustomPattern(id, { storage, dispatch = true } = {}) {
  writeCustomPatterns(loadCustomPatterns({ storage }).filter(pattern => pattern.id !== id), { storage, dispatch });
}
```

- [ ] **Step 5: Add pattern registry**

Create `lightweaver/src/lib/patternRegistry.js`:

```js
import { PATTERNS as BUILT_IN_PATTERNS } from './patterns-library.js';
import { loadCustomPatterns } from './customPatterns.js';

export function listBuiltInPatterns() {
  return BUILT_IN_PATTERNS;
}

export function listPatterns(options = {}) {
  return [...loadCustomPatterns(options), ...BUILT_IN_PATTERNS];
}

export function getPatternById(id, options = {}) {
  return listPatterns(options).find(pattern => pattern.id === id) || null;
}

export function getPatternCode(id, options = {}) {
  return getPatternById(id, options)?.code || '';
}

export function isBuiltInPattern(id) {
  return BUILT_IN_PATTERNS.some(pattern => pattern.id === id);
}
```

- [ ] **Step 6: Use the parser and registry in existing modules**

In `lightweaver/src/data.js`, remove the local `parseParams` function and add:

```js
import { PATTERNS as LIB_PATTERNS } from './lib/patterns-library.js';
import { parseParamsFromCode } from './lib/patternParams.js';
```

Change `DEFAULT_PARAMS` to:

```js
export const DEFAULT_PARAMS = Object.fromEntries(
  LIB_PATTERNS.map(pattern => [pattern.id, parseParamsFromCode(pattern.code)])
);
```

In `lightweaver/src/lib/frameEngine.js`, add:

```js
import { getPatternById } from './patternRegistry.js';
```

Change `compilePattern(patternId)` to:

```js
export function compilePattern(patternId) {
  const pat = getPatternById(patternId);
  if (!pat) return null;
  return compile(pat.code).fn;
}
```

- [ ] **Step 7: Replace local custom helpers in PatternModes**

In `lightweaver/src/components/PatternModes.jsx`, replace the local parser and custom storage definitions with imports:

```js
import { PATTERNS, DEFAULT_PARAMS, PATTERN_CODE, GRAPH_NODES, GRAPH_EDGES } from '../data.js';
import { PATTERNS as LIB_PATTERNS } from '../lib/patterns-library.js';
import { compile } from '../lib/patterns.js';
import { parseParamsFromCode } from '../lib/patternParams.js';
import {
  CUSTOM_PATTERNS_EVENT,
  deleteCustomPattern,
  loadCustomPatterns,
  saveCustomPattern,
} from '../lib/customPatterns.js';
import { getPatternById, getPatternCode } from '../lib/patternRegistry.js';
```

Remove the local `parseParamsFromCode`, `LS_CUSTOM_KEY`, `LW_CUSTOM_EVT`, `loadCustomPatterns`, `saveCustomPattern`, and `deleteCustomPattern` declarations.

Change the custom update listener to:

```js
useEffect(() => {
  const handler = () => setCustomPatterns(loadCustomPatterns());
  window.addEventListener(CUSTOM_PATTERNS_EVENT, handler);
  return () => window.removeEventListener(CUSTOM_PATTERNS_EVENT, handler);
}, []);
```

Change custom save in Code Mode to:

```js
saveCustomPattern({ name: name.trim(), code });
```

Change Code Mode initial and pattern-change code lookup to:

```js
const initialCode = getPatternCode(patternId) || '// Select a pattern\nreturn hsv(x, 1, 1);';
```

and:

```js
const newCode = getPatternCode(patternId) || '// Select a pattern\nreturn hsv(x, 1, 1);';
```

Change tuning pattern lookup to:

```js
const tuningPattern = getPatternById(tuningPatternId);
const activeLibPattern = getPatternById(tuningPatternId);
```

- [ ] **Step 8: Run the registry test again**

Run:

```bash
cd lightweaver
npm run test:core
```

Expected: PASS. Existing unrelated failures must be investigated before continuing.

- [ ] **Step 9: Commit registry extraction**

Run:

```bash
git add lightweaver/src/lib/patternParams.js lightweaver/src/lib/customPatterns.js lightweaver/src/lib/patternRegistry.js lightweaver/src/data.js lightweaver/src/lib/frameEngine.js lightweaver/src/components/PatternModes.jsx lightweaver/tests/project-frame-audit.mjs
git commit -m "feat: share custom pattern registry"
```

Expected: commit succeeds with only these files staged.

---

### Task 2: AI Draft Validation

**Files:**
- Create: `lightweaver/src/lib/aiPatternDraft.js`
- Modify: `lightweaver/tests/project-frame-audit.mjs`

- [ ] **Step 1: Write failing draft validation tests**

Add this import to `lightweaver/tests/project-frame-audit.mjs`:

```js
import {
  buildAiPatternPreviewFrame,
  validateAiPatternDraft,
} from '../src/lib/aiPatternDraft.js';
```

Add this block after the registry assertions:

```js
const validDraft = validateAiPatternDraft({
  name: 'Soft Reef',
  description: 'Blue-green bioluminescent drift.',
  changeSummary: ['Created slow ocean motion'],
  palette: ['#001a2a', '#22e6c7', '#7aa7ff'],
  code: '// @param speed float 0.2 0.05 1.0\nconst v = fbm(x * 2 + t * params.speed, y * 2, 4);\nreturn samplePalette(v);',
  suggestedParams: { speed: 0.2 },
}, {
  strips: [{
    id: 'draft-strip',
    pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
  }],
});
assert.equal(validDraft.ok, true);
assert.equal(validDraft.draft.name, 'Soft Reef');
assert.equal(validDraft.params[0].name, 'speed');

const unsafeDraft = validateAiPatternDraft({
  name: 'Unsafe',
  description: 'Attempts browser access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'fetch("https://example.com"); return rgb(1,1,1);',
});
assert.equal(unsafeDraft.ok, false);
assert.equal(unsafeDraft.error.kind, 'unsafe-code');

const blankDraft = validateAiPatternDraft({
  name: 'Blank',
  description: 'Accidental blackout.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(blankDraft.ok, false);
assert.equal(blankDraft.error.kind, 'blank-render');

const blackoutDraft = validateAiPatternDraft({
  name: 'Blackout',
  description: 'Intentional blackout scene.',
  changeSummary: ['Turns all LEDs off'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  instruction: 'make an intentional blackout',
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(blackoutDraft.ok, true);

const previewFrame = buildAiPatternPreviewFrame(validDraft.draft, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(previewFrame.pixels.length, 2);
```

- [ ] **Step 2: Run failing validation tests**

Run:

```bash
cd lightweaver
npm run test:core
```

Expected: FAIL with `Cannot find module '../src/lib/aiPatternDraft.js'`.

- [ ] **Step 3: Implement draft validator**

Create `lightweaver/src/lib/aiPatternDraft.js`:

```js
import { compile } from './patterns.js';
import { normalizePalette, renderPixelFrame, resolvePatternParams } from './frameEngine.js';
import { parseParamsFromCode } from './patternParams.js';

const REQUIRED_STRING_FIELDS = ['name', 'description', 'code'];
const UNSAFE_TOKEN_RE = /\b(fetch|XMLHttpRequest|localStorage|sessionStorage|document|window|Function|eval|import|require|WebSocket|Worker)\b/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeDraftPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: { kind: 'invalid-shape', message: 'Draft response must be an object.' } };
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) {
      return { ok: false, error: { kind: 'invalid-shape', message: `Draft is missing ${field}.` } };
    }
  }
  if (!Array.isArray(raw.changeSummary) || raw.changeSummary.length < 1 || raw.changeSummary.length > 6) {
    return { ok: false, error: { kind: 'invalid-shape', message: 'Draft needs 1 to 6 change summary entries.' } };
  }
  if (!Array.isArray(raw.palette) || raw.palette.length < 2 || raw.palette.length > 8 || raw.palette.some(color => !HEX_RE.test(color))) {
    return { ok: false, error: { kind: 'invalid-palette', message: 'Draft palette must contain 2 to 8 hex colors.' } };
  }
  return {
    ok: true,
    draft: {
      name: raw.name.trim(),
      description: raw.description.trim(),
      changeSummary: raw.changeSummary.map(item => String(item).trim()).filter(Boolean).slice(0, 6),
      palette: raw.palette.map(color => color.toLowerCase()),
      code: raw.code.trim(),
      suggestedParams: raw.suggestedParams && typeof raw.suggestedParams === 'object' ? raw.suggestedParams : {},
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
    },
  };
}

export function stripPixelsToFrameStrips(strips = []) {
  const visible = Array.isArray(strips) && strips.length ? strips : [{
    id: 'draft-default',
    pixels: Array.from({ length: 12 }, (_, i) => ({ x: i / 11, y: 0.5 + Math.sin(i) * 0.2 })),
  }];
  return visible
    .filter(strip => strip && !strip.hidden)
    .map(strip => {
      const pixels = strip.pixels || strip.pts || [];
      const count = pixels.length;
      return {
        id: strip.id || 'draft-strip',
        pts: pixels.map((pixel, i) => ({
          x: Number.isFinite(pixel.x) ? pixel.x : i,
          y: Number.isFinite(pixel.y) ? pixel.y : 0,
          p: count > 1 ? i / (count - 1) : 0.5,
        })),
      };
    })
    .filter(strip => strip.pts.length > 0);
}

function allowsBlackout(instruction = '') {
  return /\b(blackout|turn off|all off|dark|darkness)\b/i.test(instruction);
}

export function buildAiPatternPreviewFrame(draft, {
  strips = [],
  t = 0.5,
  bpm = 120,
  audioBands = null,
} = {}) {
  const compiled = compile(draft.code);
  if (compiled.error || !compiled.fn) {
    throw new Error(compiled.error || 'Draft did not compile.');
  }
  return renderPixelFrame({
    t,
    strips: stripPixelsToFrameStrips(strips),
    activeFn: compiled.fn,
    params: {
      ...Object.fromEntries(parseParamsFromCode(draft.code).map(param => [param.name, param.value])),
      ...(draft.suggestedParams || {}),
    },
    paletteNorm: normalizePalette(draft.palette),
    bpm,
    audioBands,
  });
}

function frameHasLight(frame) {
  return (frame?.pixels || []).some(pixel => Math.max(pixel.r || 0, pixel.g || 0, pixel.b || 0) > 8);
}

export function validateAiPatternDraft(rawDraft, options = {}) {
  const normalized = normalizeDraftPayload(rawDraft);
  if (!normalized.ok) return normalized;
  const { draft } = normalized;
  if (UNSAFE_TOKEN_RE.test(draft.code)) {
    return { ok: false, error: { kind: 'unsafe-code', message: 'Draft code used a blocked browser or network API.' } };
  }
  const compiled = compile(draft.code);
  if (compiled.error || !compiled.fn) {
    return { ok: false, error: { kind: 'compile-error', message: compiled.error || 'Draft did not compile.' } };
  }
  const params = parseParamsFromCode(draft.code);
  try {
    const frame = buildAiPatternPreviewFrame(draft, options);
    if (!frameHasLight(frame) && !allowsBlackout(options.instruction)) {
      return { ok: false, error: { kind: 'blank-render', message: 'Draft rendered as a blackout.' } };
    }
    return { ok: true, draft, params, frame };
  } catch (error) {
    return { ok: false, error: { kind: 'runtime-error', message: error.message || 'Draft failed during preview.' } };
  }
}
```

- [ ] **Step 4: Run validation tests**

Run:

```bash
cd lightweaver
npm run test:core
```

Expected: PASS.

- [ ] **Step 5: Commit validation layer**

Run:

```bash
git add lightweaver/src/lib/aiPatternDraft.js lightweaver/tests/project-frame-audit.mjs
git commit -m "feat: validate AI pattern drafts"
```

Expected: commit succeeds.

---

### Task 3: Server AI Endpoint

**Files:**
- Modify: `lightweaver/package.json`
- Modify: `lightweaver/package-lock.json`
- Create: `lightweaver/server/aiPattern.js`
- Modify: `lightweaver/server/index.js`
- Create: `lightweaver/tests/ai-pattern-server.mjs`

- [ ] **Step 1: Install server dependencies**

Run:

```bash
cd lightweaver
npm install openai zod
```

Expected: `package.json` contains `openai` and `zod`, and `package-lock.json` is updated.

- [ ] **Step 2: Add failing server helper tests**

Create `lightweaver/tests/ai-pattern-server.mjs`:

```js
import assert from 'node:assert/strict';
import {
  buildAiPatternInput,
  getAiPatternModel,
  normalizeAiProviderError,
} from '../server/aiPattern.js';

assert.equal(getAiPatternModel({ AI_PATTERN_MODEL: 'gpt-5.5' }), 'gpt-5.5');
assert.equal(getAiPatternModel({}), 'gpt-5.4-mini');

const input = buildAiPatternInput({
  mode: 'transform',
  instruction: 'make it slower',
  sourcePattern: {
    id: 'aurora',
    name: 'Aurora',
    code: 'return hsv(time,1,1);',
    palette: ['#00ffaa', '#6600aa'],
    params: { speed: 0.2 },
    isCustom: false,
  },
  projectContext: { ledCount: 128, stripCount: 3, hasAudio: true, hasMappedXY: true },
});
assert.equal(input[0].role, 'developer');
assert.match(input[0].content, /Lightweaver pattern draft generator/);
assert.equal(input[1].role, 'user');
assert.match(input[1].content, /make it slower/);
assert.match(input[1].content, /"ledCount":128/);

const providerError = normalizeAiProviderError(Object.assign(new Error('Rate limit'), { status: 429 }));
assert.equal(providerError.status, 429);
assert.equal(providerError.code, 'rate_limited');

const timeoutError = normalizeAiProviderError(Object.assign(new Error('Timeout'), { name: 'AbortError' }));
assert.equal(timeoutError.status, 504);
assert.equal(timeoutError.code, 'timeout');
```

- [ ] **Step 3: Run failing server tests**

Run:

```bash
cd lightweaver
node tests/ai-pattern-server.mjs
```

Expected: FAIL because `server/aiPattern.js` does not exist.

- [ ] **Step 4: Implement server route module**

Create `lightweaver/server/aiPattern.js`:

```js
import express from 'express';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

export const AiPatternDraftSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(220),
  changeSummary: z.array(z.string().min(1).max(140)).min(1).max(6),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(8),
  code: z.string().min(1).max(6000),
  suggestedParams: z.record(z.number()).optional().default({}),
  notes: z.string().max(600).optional().default(''),
});

const DEFAULT_MODEL = 'gpt-5.4-mini';

export function getAiPatternModel(env = process.env) {
  return env.AI_PATTERN_MODEL || DEFAULT_MODEL;
}

export function buildAiPatternInput(payload) {
  const source = payload?.sourcePattern || {};
  const draft = payload?.draftPattern || null;
  const project = payload?.projectContext || {};
  const mode = payload?.mode || 'transform';
  const instruction = String(payload?.instruction || '').trim();

  return [
    {
      role: 'developer',
      content: [
        'You are the Lightweaver pattern draft generator.',
        'Return only a structured draft that matches the supplied schema.',
        'Generate JavaScript function-body code for the existing Lightweaver per-pixel pattern runtime.',
        'Allowed inputs: index, x, y, t, time, pixelCount, palette, beat, beatSin, params, stripId, stripProgress, bass, mid, hi.',
        'Allowed helpers: hsv, rgb, wave, triangle, square, clamp, lerp, fract, abs, floor, ceil, int, float, min, max, pow, sqrt, exp, log, tan, atan2, round, map, step, smoothstep, mix, mod, vec2, length, distance, sin, cos, noise, randomF, ping, easeIn, easeOut, easeInOut, norm, polar, fbm, samplePalette.',
        'Do not use browser APIs, network APIs, imports, eval, Function, document, window, localStorage, timers, or asynchronous code.',
        'Prefer editable code with clear @param annotations for user-facing controls.',
        'Use palette-aware code when the prompt mentions colors.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        mode,
        instruction,
        sourcePattern: {
          id: source.id || '',
          name: source.name || '',
          description: source.description || source.desc || '',
          code: source.code || '',
          palette: Array.isArray(source.palette) ? source.palette : [],
          params: source.params || {},
          isCustom: !!source.isCustom,
        },
        draftPattern: draft,
        projectContext: {
          ledCount: project.ledCount || 0,
          stripCount: project.stripCount || 0,
          hasAudio: !!project.hasAudio,
          hasMappedXY: project.hasMappedXY !== false,
        },
      }),
    },
  ];
}

export function normalizeAiProviderError(error) {
  if (error?.name === 'AbortError') {
    return { status: 504, code: 'timeout', message: 'AI request timed out.' };
  }
  if (error?.status === 429) {
    return { status: 429, code: 'rate_limited', message: 'AI provider rate limit reached.' };
  }
  if (error?.status === 401) {
    return { status: 401, code: 'unauthorized', message: 'AI provider rejected the API key.' };
  }
  return {
    status: error?.status || 502,
    code: 'provider_error',
    message: error?.message || 'AI provider request failed.',
  };
}

export function createAiPatternRouter({ env = process.env, client = null } = {}) {
  const router = express.Router();

  router.post('/pattern', async (req, res) => {
    if (!env.OPENAI_API_KEY && !client) {
      return res.status(501).json({
        error: {
          code: 'missing_api_key',
          message: 'Set OPENAI_API_KEY on the Lightweaver server to enable AI pattern creation.',
        },
      });
    }

    try {
      const openai = client || new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const response = await openai.responses.parse({
        model: getAiPatternModel(env),
        input: buildAiPatternInput(req.body || {}),
        text: {
          format: zodTextFormat(AiPatternDraftSchema, 'lightweaver_pattern_draft'),
        },
      });
      return res.json({ draft: response.output_parsed });
    } catch (error) {
      const normalized = normalizeAiProviderError(error);
      return res.status(normalized.status).json({ error: normalized });
    }
  });

  return router;
}
```

- [ ] **Step 5: Mount route in server**

In `lightweaver/server/index.js`, add:

```js
import { createAiPatternRouter } from './aiPattern.js';
```

Mount before static serving:

```js
app.use('/api/ai', createAiPatternRouter());
```

Place it before:

```js
if (existsSync(distDir)) {
```

- [ ] **Step 6: Add server test script and run**

In `lightweaver/package.json`, update `scripts`:

```json
"test:server": "node tests/ai-pattern-server.mjs"
```

Run:

```bash
cd lightweaver
npm run test:server
npm run test:core
```

Expected: both PASS.

- [ ] **Step 7: Commit server endpoint**

Run:

```bash
git add lightweaver/package.json lightweaver/package-lock.json lightweaver/server/aiPattern.js lightweaver/server/index.js lightweaver/tests/ai-pattern-server.mjs
git commit -m "feat: add AI pattern server endpoint"
```

Expected: commit succeeds.

---

### Task 4: Client API and Assistant Drawer

**Files:**
- Create: `lightweaver/src/lib/aiPatternClient.js`
- Create: `lightweaver/src/components/AiPatternAssistant.jsx`
- Modify: `lightweaver/src/App.jsx`
- Modify: `lightweaver/src/main.css`

- [ ] **Step 1: Add AI client helper**

Create `lightweaver/src/lib/aiPatternClient.js`:

```js
export async function requestAiPatternDraft(payload, { fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const response = await fetchImpl('/api/ai/pattern', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `AI request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code || 'request_failed';
    error.data = data;
    throw error;
  }
  return data.draft;
}
```

- [ ] **Step 2: Add assistant component**

Create `lightweaver/src/components/AiPatternAssistant.jsx`:

```jsx
import { useMemo, useState } from 'react';
import { requestAiPatternDraft } from '../lib/aiPatternClient.js';
import { validateAiPatternDraft } from '../lib/aiPatternDraft.js';
import { getPatternById, isBuiltInPattern } from '../lib/patternRegistry.js';

function buildProjectContext(strips = [], audioBands = null) {
  const visible = strips.filter(strip => !strip.hidden);
  return {
    ledCount: visible.reduce((sum, strip) => sum + (strip.pixels?.length || strip.pixelCount || 0), 0),
    stripCount: visible.length,
    hasAudio: !!audioBands,
    hasMappedXY: true,
  };
}

function sourceFromPattern(patternId, palette, params) {
  const pattern = getPatternById(patternId);
  if (!pattern) return null;
  return {
    id: pattern.id,
    name: pattern.name,
    description: pattern.desc || '',
    code: pattern.code || '',
    palette: pattern.palette?.length ? pattern.palette : palette,
    params,
    isCustom: !isBuiltInPattern(pattern.id),
  };
}

export function AiPatternAssistant({
  patternId,
  palette,
  params,
  strips,
  audioBands,
  onAcceptDraft,
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState(null);
  const [validated, setValidated] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const sourcePattern = useMemo(
    () => sourceFromPattern(patternId, palette, params),
    [patternId, palette, params],
  );

  const sendInstruction = async (modeOverride = null) => {
    const instruction = input.trim();
    if (!instruction || !sourcePattern || pending) return;
    setPending(true);
    setError(null);
    setMessages(prev => [...prev, { role: 'user', text: instruction }]);
    try {
      const rawDraft = await requestAiPatternDraft({
        mode: modeOverride || (draft ? 'refine' : 'transform'),
        instruction,
        sourcePattern,
        draftPattern: draft,
        projectContext: buildProjectContext(strips, audioBands),
      });
      const result = validateAiPatternDraft(rawDraft, { instruction, strips, audioBands });
      if (!result.ok) {
        setError(result.error);
        setMessages(prev => [...prev, { role: 'assistant', text: result.error.message, error: true }]);
        return;
      }
      setDraft(result.draft);
      setValidated(result);
      setMessages(prev => [...prev, { role: 'assistant', text: result.draft.changeSummary.join(' ') }]);
      setInput('');
    } catch (requestError) {
      setError({ kind: requestError.code || 'request-failed', message: requestError.message });
      setMessages(prev => [...prev, { role: 'assistant', text: requestError.message, error: true }]);
    } finally {
      setPending(false);
    }
  };

  const acceptDraft = () => {
    if (!validated?.draft || !sourcePattern) return;
    const accepted = onAcceptDraft(validated.draft, sourcePattern, validated.params || []);
    if (accepted) {
      setMessages(prev => [...prev, { role: 'assistant', text: `Accepted ${accepted.name}.` }]);
      setDraft(null);
      setValidated(null);
      setError(null);
    }
  };

  return (
    <section className={`lw-ai-assistant ${open ? 'open' : ''}`}>
      <button className="lw-ai-toggle" type="button" onClick={() => setOpen(value => !value)}>
        <span>AI Pattern</span>
        <strong>{open ? 'Close' : 'Open'}</strong>
      </button>
      {open && (
        <div className="lw-ai-body">
          <div className="lw-ai-context">
            Transforming <strong>{sourcePattern?.name || patternId}</strong>
          </div>
          <div className="lw-ai-messages" aria-live="polite">
            {messages.length === 0 && (
              <div className="lw-ai-empty">Describe a new direction, or say things like slower, smoother, warmer, or more sparkly.</div>
            )}
            {messages.map((message, index) => (
              <div key={index} className={`lw-ai-message ${message.role} ${message.error ? 'error' : ''}`}>
                {message.text}
              </div>
            ))}
          </div>
          {draft && (
            <div className="lw-ai-draft">
              <div className="lw-ai-draft-head">
                <div>
                  <div className="eyebrow">Draft pattern</div>
                  <div className="title">{draft.name}</div>
                </div>
                <span>not applied</span>
              </div>
              <p>{draft.description}</p>
              <div className="lw-ai-swatches">
                {draft.palette.map(color => <span key={color} style={{ background: color }}/>)}
              </div>
              <ul>
                {draft.changeSummary.map(item => <li key={item}>{item}</li>)}
              </ul>
              <div className="lw-ai-actions">
                <button className="btn" type="button" onClick={acceptDraft}>Accept</button>
                <button className="btn btn-ghost" type="button" onClick={() => setInput('make this draft simpler and safer')}>Simplify</button>
              </div>
            </div>
          )}
          {error && (
            <div className="lw-ai-error">
              <strong>{error.kind}</strong>
              <span>{error.message}</span>
            </div>
          )}
          <div className="lw-ai-input-row">
            <textarea
              value={input}
              onChange={event => setInput(event.target.value)}
              placeholder="Make this slower and smoother..."
              rows={3}
            />
            <button className="btn" type="button" disabled={pending || !input.trim()} onClick={() => sendInstruction()}>
              {pending ? 'Thinking' : draft ? 'Refine' : 'Generate'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Wire assistant into PatternPanel**

In `lightweaver/src/App.jsx`, add:

```js
const AiPatternAssistant = lazy(() => import('./components/AiPatternAssistant.jsx').then(m => ({ default: m.AiPatternAssistant })));
```

Update `PatternPanel` props to include:

```js
audioBands,
onAcceptAiDraft,
```

Render the assistant immediately below the mode switch:

```jsx
<Suspense fallback={null}>
  <AiPatternAssistant
    patternId={patternId}
    palette={palette}
    params={params}
    strips={strips}
    audioBands={audioBands}
    onAcceptDraft={onAcceptAiDraft}
  />
</Suspense>
```

Pass the new props from `PatternScreen` into `PatternPanel`:

```jsx
audioBands={audioBands}
onAcceptAiDraft={handleAcceptAiDraft}
```

Temporarily define `handleAcceptAiDraft` above the `return` in `PatternScreen`; Task 5 will replace the body with persistence:

```js
const handleAcceptAiDraft = useCallback((acceptedDraft) => {
  console.info('AI draft accepted', acceptedDraft.name);
  return null;
}, []);
```

- [ ] **Step 4: Add assistant styles**

Append to `lightweaver/src/main.css`:

```css
.lw-ai-assistant {
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.lw-ai-toggle {
  width: 100%;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  cursor: pointer;
  font: inherit;
}

.lw-ai-toggle span {
  color: var(--accent);
  font-size: var(--fs-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.lw-ai-toggle strong {
  font-size: var(--fs-2xs);
  color: var(--text-3);
}

.lw-ai-body {
  display: grid;
  gap: 10px;
  padding: 10px;
}

.lw-ai-context,
.lw-ai-empty {
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.lw-ai-messages {
  display: grid;
  gap: 6px;
  max-height: 150px;
  overflow: auto;
}

.lw-ai-message {
  max-width: 88%;
  padding: 8px 10px;
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-xs);
  line-height: 1.45;
}

.lw-ai-message.user {
  justify-self: end;
  background: color-mix(in oklch, var(--accent) 22%, var(--surface-2));
  color: var(--text);
}

.lw-ai-message.error,
.lw-ai-error {
  border: 1px solid color-mix(in oklch, var(--danger) 55%, var(--border));
  color: var(--danger);
}

.lw-ai-draft {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg);
}

.lw-ai-draft-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.lw-ai-draft .eyebrow {
  color: var(--accent);
  font-size: var(--fs-2xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.lw-ai-draft .title {
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 650;
}

.lw-ai-draft p,
.lw-ai-draft li {
  color: var(--text-3);
  font-size: var(--fs-xs);
  line-height: 1.45;
}

.lw-ai-swatches {
  display: flex;
  gap: 4px;
}

.lw-ai-swatches span {
  width: 24px;
  height: 18px;
  border-radius: 3px;
  border: 1px solid var(--border);
}

.lw-ai-actions,
.lw-ai-input-row {
  display: flex;
  gap: 8px;
}

.lw-ai-input-row textarea {
  flex: 1;
  min-width: 0;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg);
  color: var(--text);
  padding: 8px;
  font: inherit;
  font-size: var(--fs-xs);
}

.lw-ai-error {
  display: grid;
  gap: 3px;
  padding: 8px 10px;
  border-radius: var(--r-md);
  background: color-mix(in oklch, var(--danger) 8%, var(--bg));
  font-size: var(--fs-xs);
}
```

- [ ] **Step 5: Run build**

Run:

```bash
cd lightweaver
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit assistant shell**

Run:

```bash
git add lightweaver/src/lib/aiPatternClient.js lightweaver/src/components/AiPatternAssistant.jsx lightweaver/src/App.jsx lightweaver/src/main.css
git commit -m "feat: add AI pattern assistant drawer"
```

Expected: commit succeeds.

---

### Task 5: Accept and Save AI Drafts

**Files:**
- Modify: `lightweaver/src/App.jsx`
- Modify: `lightweaver/src/components/AiPatternAssistant.jsx`
- Modify: `lightweaver/src/lib/customPatterns.js`
- Modify: `lightweaver/tests/project-frame-audit.mjs`

- [ ] **Step 1: Add accept behavior tests**

Add this import to `lightweaver/tests/project-frame-audit.mjs`:

```js
import { acceptAiDraftAsCustomPattern } from '../src/lib/customPatterns.js';
```

Add this block after the update/delete custom pattern assertions:

```js
const builtInAccept = acceptAiDraftAsCustomPattern({
  sourcePattern: { id: 'aurora', name: 'Aurora', isCustom: false },
  draft: {
    name: 'Aurora Glass Drift',
    description: 'Softer aurora',
    code: 'return hsv(0.6,1,1);',
    palette: ['#102a2b', '#57e7c1'],
    suggestedParams: { speed: 0.1 },
  },
}, { storage: memoryStorage, dispatch: false });
assert.equal(builtInAccept.id, 'custom_aurora_glass_drift');
assert.equal(loadCustomPatterns({ storage: memoryStorage }).some(pattern => pattern.id === builtInAccept.id), true);

const updatedAccept = acceptAiDraftAsCustomPattern({
  sourcePattern: { id: builtInAccept.id, name: builtInAccept.name, isCustom: true },
  draft: {
    name: 'Aurora Glass Drift',
    description: 'Even smoother',
    code: 'return hsv(0.7,1,1);',
    palette: ['#000000', '#ffffff'],
    suggestedParams: { speed: 0.05 },
  },
}, { storage: memoryStorage, dispatch: false });
assert.equal(updatedAccept.id, builtInAccept.id);
assert.equal(getPatternCode(builtInAccept.id, { storage: memoryStorage }), 'return hsv(0.7,1,1);');
```

- [ ] **Step 2: Run failing accept tests**

Run:

```bash
cd lightweaver
npm run test:core
```

Expected: FAIL because `acceptAiDraftAsCustomPattern` is not exported.

- [ ] **Step 3: Implement accept helper**

Add to `lightweaver/src/lib/customPatterns.js`:

```js
export function acceptAiDraftAsCustomPattern({ sourcePattern, draft }, options = {}) {
  const entry = {
    id: sourcePattern?.isCustom ? sourcePattern.id : undefined,
    name: draft.name,
    description: draft.description,
    code: draft.code,
    palette: draft.palette || [],
    params: draft.suggestedParams || {},
  };
  if (sourcePattern?.isCustom && sourcePattern.id) {
    return updateCustomPattern(sourcePattern.id, entry, options);
  }
  const existing = loadCustomPatterns(options);
  return saveCustomPattern({
    ...entry,
    id: buildCustomPatternId(draft.name, existing.map(pattern => pattern.id)),
  }, options);
}
```

- [ ] **Step 4: Wire accept into App**

In `lightweaver/src/App.jsx`, add:

```js
import { acceptAiDraftAsCustomPattern } from './lib/customPatterns.js';
```

Replace the temporary `handleAcceptAiDraft` with:

```js
const handleAcceptAiDraft = useCallback((acceptedDraft, sourcePattern, parsedParams = []) => {
  const accepted = acceptAiDraftAsCustomPattern({ sourcePattern, draft: acceptedDraft });
  if (!accepted?.id) return null;
  setPatternId(accepted.id);
  setCompiledFn(null);
  if (accepted.palette?.length) setPalette(accepted.palette);
  const defaults = Object.fromEntries(parsedParams.map(param => [param.name, param.value]));
  setPatternParams(prev => ({
    ...prev,
    [accepted.id]: {
      ...defaults,
      ...(accepted.params || {}),
    },
  }));
  return accepted;
}, [setPalette, setPatternId, setPatternParams]);
```

- [ ] **Step 5: Make assistant send parsed params into accept**

In `lightweaver/src/components/AiPatternAssistant.jsx`, ensure `acceptDraft` passes parsed params:

```js
const accepted = onAcceptDraft(validated.draft, sourcePattern, validated.params || []);
```

This should already match Task 4. Keep it as-is if present.

- [ ] **Step 6: Run tests and build**

Run:

```bash
cd lightweaver
npm run test:core
npm run build
```

Expected: both PASS.

- [ ] **Step 7: Commit accept behavior**

Run:

```bash
git add lightweaver/src/App.jsx lightweaver/src/components/AiPatternAssistant.jsx lightweaver/src/lib/customPatterns.js lightweaver/tests/project-frame-audit.mjs
git commit -m "feat: accept AI pattern drafts"
```

Expected: commit succeeds.

---

### Task 6: End-to-End Mocked AI Flow

**Files:**
- Create: `lightweaver/tests/ai-pattern-assistant.spec.ts`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Add Playwright test**

Create `lightweaver/tests/ai-pattern-assistant.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('generates an AI draft and accepts it as a custom pattern', async ({ page }) => {
  await page.route('**/api/ai/pattern', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        draft: {
          name: 'Aurora Glass Drift',
          description: 'A slower aurora with softened motion and gold center light.',
          changeSummary: ['Reduced speed', 'Softened contrast', 'Added warm center glow'],
          palette: ['#102a2b', '#57e7c1', '#9476ff', '#d6b56c'],
          code: '// @param speed float 0.06 0.01 0.4\nconst drift = fbm(x * 1.8 + t * params.speed, y * 1.2, 4);\nconst gold = smoothstep(0.42, 0.0, polar(x, y).r);\nreturn samplePalette(drift + gold * 0.12);',
          suggestedParams: { speed: 0.06 },
        },
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.lw-rail-btn', { hasText: 'Pattern' }).click();
  await page.getByRole('button', { name: /AI Pattern/i }).click();
  await page.getByPlaceholder('Make this slower and smoother...').fill('slower and smoother with gold near the center');
  await page.getByRole('button', { name: 'Generate' }).click();

  await expect(page.getByText('Aurora Glass Drift')).toBeVisible();
  await expect(page.getByText('not applied')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Accepted Aurora Glass Drift.')).toBeVisible();

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_custom_patterns') || '[]'));
  expect(saved).toHaveLength(1);
  expect(saved[0].id).toBe('custom_aurora_glass_drift');
  expect(saved[0].palette).toEqual(['#102a2b', '#57e7c1', '#9476ff', '#d6b56c']);
});

test('shows setup message when server has no AI key', async ({ page }) => {
  await page.route('**/api/ai/pattern', async route => {
    await route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'missing_api_key',
          message: 'Set OPENAI_API_KEY on the Lightweaver server to enable AI pattern creation.',
        },
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.lw-rail-btn', { hasText: 'Pattern' }).click();
  await page.getByRole('button', { name: /AI Pattern/i }).click();
  await page.getByPlaceholder('Make this slower and smoother...').fill('make a calm reef pattern');
  await page.getByRole('button', { name: 'Generate' }).click();

  await expect(page.getByText('Set OPENAI_API_KEY on the Lightweaver server to enable AI pattern creation.')).toBeVisible();
});
```

- [ ] **Step 2: Add combined test script**

In `lightweaver/package.json`, update `scripts`:

```json
"test:ai": "npm run test:server && npm run test:core && npx playwright test tests/ai-pattern-assistant.spec.ts"
```

- [ ] **Step 3: Run mocked AI tests**

Run:

```bash
cd lightweaver
npm run test:ai
```

Expected: PASS. If the Playwright selector for the rail button differs, inspect the rendered text and update only the selector, not the feature behavior.

- [ ] **Step 4: Commit E2E coverage**

Run:

```bash
git add lightweaver/tests/ai-pattern-assistant.spec.ts lightweaver/package.json
git commit -m "test: cover AI pattern assistant flow"
```

Expected: commit succeeds.

---

### Task 7: Final Verification and Documentation Note

**Files:**
- Modify: `docs/superpowers/specs/2026-05-22-ai-pattern-creator-design.md`

- [ ] **Step 1: Add implementation note to the spec**

Append this section to `docs/superpowers/specs/2026-05-22-ai-pattern-creator-design.md`:

```md
## Implementation Notes

The first implementation uses the OpenAI JavaScript SDK on the Lightweaver server, not in the browser. The server reads `OPENAI_API_KEY` and optional `AI_PATTERN_MODEL`, calls the Responses API with structured output, and returns a draft JSON object to the browser.

The browser validates every draft with the local Lightweaver compiler and preview renderer before showing an Accept action. Built-in pattern transforms save as new custom patterns. Existing custom pattern transforms update in place and keep local revision history.
```

- [ ] **Step 2: Run full local verification**

Run:

```bash
cd lightweaver
npm run test:core
npm run test:server
npm run build
npx playwright test tests/ai-pattern-assistant.spec.ts
```

Expected: all commands PASS.

- [ ] **Step 3: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intentional files from this task are modified, plus any unrelated pre-existing user changes that were present before implementation.

- [ ] **Step 4: Commit final docs note**

Run:

```bash
git add docs/superpowers/specs/2026-05-22-ai-pattern-creator-design.md
git commit -m "docs: note AI pattern implementation details"
```

Expected: commit succeeds.

---

## Plan Self-Review

Spec coverage:

- Assistant drawer UX: Task 4.
- Draft-only behavior: Tasks 4, 5, and 6.
- Built-in protection and custom update-in-place: Tasks 1 and 5.
- Structured AI response: Task 3.
- Validation before accept: Task 2.
- Server-side API key handling: Task 3.
- Mocked deterministic tests: Tasks 2, 3, and 6.

Type consistency:

- Draft field names are `name`, `description`, `changeSummary`, `palette`, `code`, `suggestedParams`, and `notes` across server, validator, UI, tests, and accept helper.
- Custom pattern persisted fields are `id`, `name`, `desc`, `code`, `palette`, `params`, `preview`, `custom`, and `updatedAt`.
- The assistant uses `sourcePattern.isCustom` for accept decisions, matching the design spec.

Implementation boundary:

- The plan does not replace the existing pattern compiler, renderer, WLED transport, timeline, or project model.
- The first implementation is computer/local browser first and remains compatible with Pi-hosted server deployment.
