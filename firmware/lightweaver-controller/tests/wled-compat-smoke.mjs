#!/usr/bin/env node
// Smoke test for Lightweaver's pretend-WLED JSON API.
//
// Usage:
//   node tests/wled-compat-smoke.mjs [host-or-ip]
//
// Default host: lightweaver.local
// Requires Node 18+ (uses built-in fetch). No external deps.
//
// Exit code 0 = all tests passed. Non-zero = at least one failure.

const HOST = process.argv[2] || 'lightweaver.local';
const BASE = HOST.startsWith('http') ? HOST.replace(/\/$/, '') : `http://${HOST}`;

const RESULTS = [];
let CURRENT_NAME = '';

function pass(note = '') {
  RESULTS.push({ name: CURRENT_NAME, ok: true, note });
  const tag = '\x1b[32mPASS\x1b[0m';
  console.log(`${tag}  ${CURRENT_NAME}${note ? '  — ' + note : ''}`);
}

function fail(note) {
  RESULTS.push({ name: CURRENT_NAME, ok: false, note });
  const tag = '\x1b[31mFAIL\x1b[0m';
  console.log(`${tag}  ${CURRENT_NAME}  — ${note}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function getJson(path, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} on GET ${path}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function postJson(path, body, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} on POST ${path}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(name, fn) {
  CURRENT_NAME = name;
  try {
    const note = await fn();
    pass(note || '');
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nLightweaver WLED-compat smoke test\nTarget: ${BASE}\n`);

// 1. GET /json/info
await run('GET /json/info', async () => {
  const info = await getJson('/json/info');
  assert(info && info.leds, 'no leds object');
  assert(typeof info.leds.count === 'number' && info.leds.count > 0, `leds.count not positive: ${info.leds.count}`);
  assert(typeof info.mac === 'string' && /^[0-9a-f]{12}$/i.test(info.mac), `mac format unexpected: ${info.mac}`);
  assert(info.product === 'Lightweaver', `product not "Lightweaver": ${info.product}`);
  return `count=${info.leds.count} mac=${info.mac} ver=${info.ver}`;
});

// 2. GET /json/state
await run('GET /json/state', async () => {
  const state = await getJson('/json/state');
  assert(typeof state.on === 'boolean', `state.on not boolean: ${state.on}`);
  assert(typeof state.bri === 'number' && state.bri >= 0 && state.bri <= 255, `state.bri out of range: ${state.bri}`);
  assert(Array.isArray(state.seg), `state.seg not array`);
  return `on=${state.on} bri=${state.bri} segs=${state.seg.length}`;
});

// 3. GET /json/effects vs /api/patterns
await run('GET /json/effects matches /api/patterns count', async () => {
  const effects = await getJson('/json/effects');
  assert(Array.isArray(effects), 'effects not an array');
  effects.forEach((e, i) => assert(typeof e === 'string', `effects[${i}] not string`));
  let patternsCount = null;
  try {
    const p = await getJson('/api/patterns');
    patternsCount = Array.isArray(p.patterns) ? p.patterns.length : null;
  } catch (e) {
    return `effects=${effects.length} (could not fetch /api/patterns: ${e.message})`;
  }
  if (patternsCount === null) return `effects=${effects.length} (patterns shape unknown)`;
  assert(effects.length === patternsCount, `effects ${effects.length} != patterns ${patternsCount}`);
  return `effects=${effects.length} patterns=${patternsCount}`;
});

// 4. POST /json/state { bri: 128 }
await run('POST /json/state { bri: 128 } and read back', async () => {
  const r = await postJson('/json/state', { bri: 128 });
  assert(r && r.success === true, `response not {success:true}: ${JSON.stringify(r)}`);
  await sleep(200);
  const state = await getJson('/json/state');
  // Allow ±1 for rounding.
  assert(Math.abs(state.bri - 128) <= 1, `read-back bri ${state.bri} not within 1 of 128`);
  return `bri readback=${state.bri}`;
});

// 5. POST /json/state realtime frame
await run('POST /json/state realtime frame triggers lwLive.streaming', async () => {
  const r = await postJson('/json/state', {
    seg: [{ i: ['FF0000', '00FF00', '0000FF'] }],
  });
  assert(r && r.success === true, `response not {success:true}: ${JSON.stringify(r)}`);
  // Give the card up to 1 second to flip the flag.
  let info = null;
  let ok = false;
  for (let i = 0; i < 5; i++) {
    await sleep(200);
    info = await getJson('/json/info');
    if (info.lwLive && info.lwLive.streaming === true && info.lwLive.source === 'wled-realtime') {
      ok = true;
      break;
    }
  }
  assert(ok, `lwLive did not report streaming wled-realtime within 1s: ${JSON.stringify(info && info.lwLive)}`);
  return `lwLive.source=${info.lwLive.source}`;
});

// 6. After 3s, streaming should drop
await run('lwLive.streaming clears within 3 seconds of last frame', async () => {
  await sleep(3000);
  const info = await getJson('/json/info');
  assert(info.lwLive, 'no lwLive on info');
  assert(info.lwLive.streaming === false, `streaming still true after 3s: ${JSON.stringify(info.lwLive)}`);
  return `streaming=${info.lwLive.streaming}`;
});

// 7. /api/status reachable, ideally exposes streaming + frameSource
await run('GET /api/status reachable (and ideally has streaming + frameSource)', async () => {
  const s = await getJson('/api/status');
  assert(s && typeof s === 'object', '/api/status returned non-object');
  const hasStreaming = Object.prototype.hasOwnProperty.call(s, 'streaming');
  const hasSource = Object.prototype.hasOwnProperty.call(s, 'frameSource');
  if (hasStreaming && hasSource) {
    return `streaming=${s.streaming} frameSource=${s.frameSource}`;
  }
  // Not a failure — Agent D may not have shipped these yet.
  return `reachable; new fields not present yet (streaming:${hasStreaming} frameSource:${hasSource})`;
});

// ─────────────────────────────────────────────────────────────────────────────

const total = RESULTS.length;
const failed = RESULTS.filter((r) => !r.ok).length;
const passed = total - failed;

console.log('');
console.log(`Summary: ${passed}/${total} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const r of RESULTS.filter((x) => !x.ok)) {
    console.log(`  - ${r.name}: ${r.note}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
