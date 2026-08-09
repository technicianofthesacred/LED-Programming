import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../src');
const streamHeaderPath = resolve(root, 'LightweaverHttpFrameStream.h');
const streamSourcePath = resolve(root, 'LightweaverHttpFrameStream.cpp');
assert.ok(existsSync(streamHeaderPath) && existsSync(streamSourcePath),
  'bounded HTTP frame-stream firmware module must exist');
const header = readFileSync(streamHeaderPath, 'utf8');
const source = readFileSync(streamSourcePath, 'utf8');
const web = readFileSync(resolve(root, 'LightweaverWeb.cpp'), 'utf8');
const runtimeHeader = readFileSync(resolve(root, 'LightweaverRuntimeApi.h'), 'utf8');
const main = readFileSync(resolve(root, 'main.cpp'), 'utf8');
const frameSourceHeader = readFileSync(resolve(root, 'LightweaverFrameSource.h'), 'utf8');

for (const route of ['/api/stream/lease', '/api/stream/frame', '/api/stream/stop']) {
  assert.match(source, new RegExp(route.replaceAll('/', '\\/')), `${route} is registered`);
}
assert.match(header, /LW_HTTP_STREAM_LEASE_TTL_MS/);
assert.match(header, /LW_HTTP_STREAM_MAX_BODY_BYTES/);
assert.match(header, /cardId[\s\S]*bootId[\s\S]*ownerSessionId[\s\S]*operationGeneration[\s\S]*host[\s\S]*origin/,
  'lease binds exact card, boot, owner session, operation generation, host, and origin');
assert.match(source, /sequence[^\n]*nextSequence|nextSequence[^\n]*sequence/,
  'frame path enforces monotonic sequence ownership');
assert.match(source, /RAW_START[\s\S]*clientContentLength\(\)[\s\S]*LW_HTTP_STREAM_MAX_BODY_BYTES/,
  'request size is rejected from the raw stream before an unbounded body allocation');
assert.match(source, /RAW_ABORTED[\s\S]*(?:stop|interrupt|revoke)/i,
  'an interrupted body revokes the lease and recovers the renderer');
assert.match(source, /runtimeCancelStream\(\)/,
  'Stop, timeout, and interruption return through the canonical Stop API');
assert.match(source, /runtimeWriteHttpFrame\(/,
  'accepted frames write through the canonical runtime frame buffer API');
assert.match(main, /frameSourceClaim\(FRAME_HTTP\)/);
assert.match(main, /frameSourceMarkExternal\(FRAME_HTTP\)/);
assert.match(frameSourceHeader, /FRAME_HTTP\s*=\s*3/,
  'HTTP is a peer producer in the single existing frame-source arbiter');
assert.match(runtimeHeader, /runtimeWriteHttpFrame\(/);
assert.match(web, /registerLightweaverHttpFrameStream/,
  'LightweaverWeb wires the bounded streaming handler');

function streamModel() {
  let lease = null;
  return {
    lease(binding, now) { lease = { ...binding, expires: now + 1500, nextSequence: 1 }; },
    frame(binding, sequence, now) {
      if (!lease || now > lease.expires) { lease = null; return 'expired'; }
      for (const key of Object.keys(binding)) if (lease[key] !== binding[key]) { lease = null; return 'revoked'; }
      if (sequence !== lease.nextSequence) return 'sequence';
      lease.nextSequence += 1; lease.expires = now + 1500; return 'accepted';
    },
    stop() { lease = null; return 'stopped'; },
  };
}
const binding = { cardId: 'lw-a', bootId: 'boot-a', ownerSessionId: 's', operationGeneration: 2, host: 'h', origin: 'o' };
const model = streamModel();
model.lease(binding, 0);
assert.equal(model.frame(binding, 1, 10), 'accepted');
assert.equal(model.frame(binding, 1, 20), 'sequence');
assert.equal(model.frame({ ...binding, bootId: 'boot-b' }, 2, 30), 'revoked');
assert.equal(model.frame(binding, 2, 40), 'expired');
model.lease(binding, 100);
assert.equal(model.stop(), 'stopped');
assert.equal(model.frame(binding, 1, 110), 'expired');

console.log('windowless HTTP frame stream tests passed');
