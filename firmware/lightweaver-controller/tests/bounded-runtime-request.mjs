import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const web = readFileSync(new URL('../src/LightweaverWeb.cpp', import.meta.url), 'utf8');

function receiveBoundedBody(declaredLength, chunks) {
  const limit = 3968;
  if (!Number.isInteger(declaredLength) || declaredLength <= 0) return { ok: false, reason: 'length-required', allocated: 0 };
  if (declaredLength > limit) return { ok: false, reason: 'too-large', allocated: 0 };
  const fixed = new Uint8Array(limit + 1);
  let received = 0;
  for (const size of chunks) {
    if (received + size > limit || received + size > declaredLength) {
      return { ok: false, reason: 'too-large', allocated: fixed.byteLength };
    }
    received += size;
  }
  if (received !== declaredLength) return { ok: false, reason: 'partial', allocated: fixed.byteLength };
  return { ok: true, received, allocated: fixed.byteLength };
}

assert.deepEqual(receiveBoundedBody(3969, [1]), { ok: false, reason: 'too-large', allocated: 0 });
assert.deepEqual(receiveBoundedBody(0, [100]), { ok: false, reason: 'length-required', allocated: 0 });
assert.equal(receiveBoundedBody(3968, [1024, 1024, 1024, 896]).ok, true);
assert.equal(receiveBoundedBody(3968, [3969]).ok, false);
assert.equal(receiveBoundedBody(100, [40, 40]).reason, 'partial');
assert.equal(receiveBoundedBody(100, [60, 41]).reason, 'too-large');

assert.match(web, /constexpr size_t LW_MAX_RUNTIME_REQUEST_BODY_BYTES\s*=\s*3968/);
assert.match(web, /class BoundedRuntimeRequestHandler/);
assert.match(web, /uri == "\/api\/config"[\s\S]*uri == "\/api\/wiring\/candidate"/);
assert.match(web, /clientContentLength\(\)[\s\S]*LW_MAX_RUNTIME_REQUEST_BODY_BYTES/,
  'declared oversized bodies must be rejected on RAW_START');
assert.match(web, /runtimeRequestExpectedLength[\s\S]*runtimeRequestBodyLength/,
  'RAW_END must reject partial bodies that do not match Content-Length');
assert.match(web, /server\.addHandler\(new BoundedRuntimeRequestHandler\(\)\)/);

for (const [name, next] of [
  ['handleConfigPost', 'readWiringRequest'],
  ['handleWiringCandidate', 'wiringActivationId'],
]) {
  const start = web.indexOf(`void ${name}(`);
  const end = web.indexOf(next, start + 1);
  const body = web.slice(start, end);
  assert.doesNotMatch(body, /server\.(?:arg|hasArg)\("plain"\)/,
    `${name} must not allow WebServer to allocate an ordinary plain request body`);
}

console.log('bounded-runtime-request tests passed');
