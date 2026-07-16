import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const web = readFileSync(new URL('../src/LightweaverWeb.cpp', import.meta.url), 'utf8');
const parserGuard = readFileSync(new URL('../scripts/guard-webserver-control-body.py', import.meta.url), 'utf8');
const platformio = readFileSync(new URL('../platformio.ini', import.meta.url), 'utf8');

function receiveBoundedBody(declaredLength, chunks, limit = 3968) {
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

function preParserGuard(path, contentType, contentLength) {
  const limit = path === '/api/wiring/candidate' ? 3982 : 3968;
  const mediaType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return { status: 415, allocated: 0 };
  if (!contentLength) return { status: 411, allocated: 0 };
  if (contentLength > limit) return { status: 413, allocated: 0 };
  return { status: 0, allocated: limit + 1 };
}
assert.deepEqual(preParserGuard('/api/config', 'multipart/form-data; boundary=x', 40), { status: 415, allocated: 0 });
assert.deepEqual(preParserGuard('/api/wiring/candidate', 'application/x-www-form-urlencoded', 40), { status: 415, allocated: 0 });
assert.deepEqual(preParserGuard('/api/config', 'application/json', 0), { status: 411, allocated: 0 });
assert.deepEqual(preParserGuard('/api/config', 'application/json', 3969), { status: 413, allocated: 0 });

const envelopeOverhead = Buffer.byteLength('{"candidate":}');
assert.equal(envelopeOverhead, 14);
const validConfigBase = { led: { outputs: [{ pin: 16, pixels: 1 }] }, pad: '' };
const validConfigOverhead = Buffer.byteLength(JSON.stringify(validConfigBase));
const exactConfig = JSON.stringify({ ...validConfigBase, pad: 'a'.repeat(3968 - validConfigOverhead) });
const oversizedConfig = JSON.stringify({ ...validConfigBase, pad: 'a'.repeat(3969 - validConfigOverhead) });
assert.equal(Buffer.byteLength(exactConfig), 3968);
assert.equal(Buffer.byteLength(oversizedConfig), 3969);
assert.equal(receiveBoundedBody(Buffer.byteLength(exactConfig), [3968], 3968).ok, true, 'an exact maximum raw config must pass');
assert.equal(receiveBoundedBody(Buffer.byteLength(oversizedConfig), [3969], 3968).ok, false, 'a raw config one byte over policy must fail');
assert.equal(receiveBoundedBody(3968 + envelopeOverhead, [3982], 3982).ok, true,
  'the candidate route must reserve exactly the fixed wrapper overhead');
assert.equal(receiveBoundedBody(3969 + envelopeOverhead, [3983], 3982).ok, false,
  'the wrapper must not make a 3969-byte candidate acceptable');
assert.equal(canonicalCandidateEnvelope(`{"candidate":${exactConfig}}`), true);

function canonicalCandidateEnvelope(body) {
  const parsed = JSON.parse(body);
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !parsed.candidate || Array.isArray(parsed.candidate)) return false;
  return body === `{"candidate":${JSON.stringify(parsed.candidate)}}`;
}

const utf8Config = JSON.stringify({ label: '灯'.repeat(100) });
const utf8Envelope = `{"candidate":${utf8Config}}`;
assert.equal(Buffer.byteLength(utf8Envelope), Buffer.byteLength(utf8Config) + envelopeOverhead,
  'limits must count UTF-8 bytes rather than JavaScript characters');
assert.equal(canonicalCandidateEnvelope(utf8Envelope), true);
assert.equal(canonicalCandidateEnvelope(` {"candidate":${utf8Config}}`), false, 'outer whitespace is not a valid size bypass');
assert.equal(canonicalCandidateEnvelope(`{"candidate": ${utf8Config}}`), false, 'wrapper whitespace is not accepted');
assert.equal(canonicalCandidateEnvelope(`{"candidate":${utf8Config},"extra":true}`), false, 'unknown envelope fields are rejected');
const utf8Base = '灯'.repeat(1000);
const utf8BaseJson = JSON.stringify({ ...validConfigBase, pad: utf8Base });
const exactUtf8Config = JSON.stringify({
  ...validConfigBase,
  pad: utf8Base + 'a'.repeat(3968 - Buffer.byteLength(utf8BaseJson)),
});
assert.equal(Buffer.byteLength(exactUtf8Config), 3968);
assert.equal(canonicalCandidateEnvelope(`{"candidate":${exactUtf8Config}}`), true,
  'an exact 3968-byte UTF-8 config must pass in the fixed candidate envelope');

assert.match(web, /constexpr size_t LW_MAX_RUNTIME_REQUEST_BODY_BYTES\s*=\s*3968/);
assert.match(web, /constexpr size_t LW_CANDIDATE_ENVELOPE_BYTES\s*=\s*14/);
assert.match(web, /LW_MAX_CANDIDATE_REQUEST_BODY_BYTES\s*=\s*LW_MAX_RUNTIME_REQUEST_BODY_BYTES\s*\+\s*LW_CANDIDATE_ENVELOPE_BYTES/);
assert.match(web, /class BoundedRuntimeRequestHandler/);
assert.match(web, /uri == "\/api\/config"[\s\S]*uri == "\/api\/wiring\/candidate"/);
assert.match(web, /clientContentLength\(\)[\s\S]*LW_MAX_RUNTIME_REQUEST_BODY_BYTES/,
  'declared oversized bodies must be rejected on RAW_START');
assert.match(web, /runtimeRequestExpectedLength[\s\S]*runtimeRequestBodyLength/,
  'RAW_END must reject partial bodies that do not match Content-Length');
assert.match(web, /candidateJson\.length\(\)\s*\+\s*LW_CANDIDATE_ENVELOPE_BYTES/,
  'candidate parsing must verify exact serialized config bytes plus fixed wrapper overhead');
assert.match(web, /doc\.size\(\)\s*!=\s*1/,
  'candidate envelopes with unknown fields must fail closed');
assert.match(web, /server\.addHandler\(new BoundedRuntimeRequestHandler\(\)\)/);
assert.match(parserGuard, /application\/json/);
assert.match(parserGuard, /\/api\/config/);
assert.match(parserGuard, /\/api\/wiring\/candidate/);
assert.match(parserGuard, /isForm|multipart/);
assert.match(parserGuard, /isEncoded/);
assert.match(parserGuard, /_clientContentLength\s*==\s*0/);
assert.match(parserGuard, /LW_WEB_CONFIG_MAX_BODY_BYTES/);
assert.match(parserGuard, /LW_WEB_CANDIDATE_MAX_BODY_BYTES/);
assert.match(platformio, /-DLW_WEB_CONFIG_MAX_BODY_BYTES=3968/);
assert.match(platformio, /-DLW_WEB_CANDIDATE_MAX_BODY_BYTES=3982/);

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
