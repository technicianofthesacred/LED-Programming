import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestPost as stage } from '../functions/api/handoff/stage.js';
import { onRequestGet as consume } from '../functions/api/handoff/[tokenHash].js';
import { createMemoryHandoffStore } from '../functions/api/handoff/_shared/store.js';

const tokenHash = Buffer.alloc(32, 0xaa).toString('base64url');
const now = Date.now();
const encrypted = Buffer.from(Uint8Array.from({ length: 96 }, (_, index) => (index * 47 + 19) % 256)).toString('base64url');

function stageRequest(body) {
  return new Request('https://led.mandalacodes.com/api/handoff/stage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('ciphertext stage is bounded, token-hash indexed, expiring, and atomically single-use', async () => {
  const store = createMemoryHandoffStore({ now: () => now });
  const body = { tokenHash, iv: Buffer.alloc(12, 7).toString('base64url'), ciphertext: encrypted, expiresAt: now + 60_000 };
  const staged = await stage({ request: stageRequest(body), env: { HANDOFF_STORE: store }, waitUntil() {} });
  assert.equal(staged.status, 201);
  assert.equal(staged.headers.get('cache-control'), 'no-store');

  const claim = () => consume({
    request: new Request(`https://led.mandalacodes.com/api/handoff/${tokenHash}`),
    params: { tokenHash }, env: { HANDOFF_STORE: store }, waitUntil() {},
  });
  const [first, second] = await Promise.all([claim(), claim()]);
  assert.deepEqual([first.status, second.status].sort(), [200, 404]);
  const successful = first.status === 200 ? first : second;
  assert.deepEqual(await successful.json(), { iv: body.iv, ciphertext: body.ciphertext, expiresAt: body.expiresAt });
  assert.equal(successful.headers.get('cache-control'), 'no-store');
});

test('stage rejects project-like plaintext, long TTL, duplicate tokens, and oversized ciphertext', async () => {
  const store = createMemoryHandoffStore({ now: () => now });
  const invoke = value => stage({ request: stageRequest(value), env: { HANDOFF_STORE: store }, waitUntil() {} });
  assert.equal((await invoke({ tokenHash, project: { id: 'plaintext' }, expiresAt: now + 1000 })).status, 400);
  assert.equal((await invoke({ tokenHash, iv: Buffer.alloc(12).toString('base64url'), ciphertext: Buffer.from('{"project":{"id":"plaintext"}}').toString('base64url'), expiresAt: now + 1000 })).status, 400);
  const valid = { tokenHash, iv: Buffer.alloc(12, 7).toString('base64url'), ciphertext: encrypted, expiresAt: now + 60_000 };
  assert.equal((await invoke({ ...valid, expiresAt: now + 60 * 60_000 })).status, 400);
  assert.equal((await invoke(valid)).status, 201);
  assert.equal((await invoke(valid)).status, 409);
  assert.equal((await invoke({ ...valid, tokenHash: Buffer.alloc(32, 0xbb).toString('base64url'), ciphertext: Buffer.alloc(3 * 1024 * 1024).toString('base64url') })).status, 413);
});

test('expired staged ciphertext is consumed as gone and can never be replayed', async () => {
  let clock = now;
  const store = createMemoryHandoffStore({ now: () => clock });
  const body = { tokenHash, iv: Buffer.alloc(12, 3).toString('base64url'), ciphertext: encrypted, expiresAt: now + 1000 };
  assert.equal((await stage({ request: stageRequest(body), env: { HANDOFF_STORE: store }, waitUntil() {} })).status, 201);
  clock += 1001;
  const context = { request: new Request(`https://led.mandalacodes.com/api/handoff/${tokenHash}`), params: { tokenHash }, env: { HANDOFF_STORE: store }, waitUntil() {} };
  assert.equal((await consume(context)).status, 410);
  assert.equal((await consume(context)).status, 404);
});
