import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLEAR_PROJECT_CONFIRM_TOKEN,
  CLEAR_PROJECT_MIN_BRIDGE_VERSION,
  ClearProjectError,
  clearCardProject,
} from './cardClearProject.js';

function okResponse(body = { ok: true, accepted: true, wifiPreserved: true, requiresReboot: true }) {
  return { ok: true, status: 202, json: async () => body };
}

test('direct clear guards identity first, then posts the exact confirmation token', async () => {
  const calls = [];
  const response = await clearCardProject({
    host: 'lightweaver.local',
    direct: true,
    guardImpl: async host => { calls.push(['guard', host]); return null; },
    fetchImpl: async (url, init) => {
      calls.push(['fetch', url, init.method, init.body]);
      return okResponse();
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.wifiPreserved, true);
  assert.deepEqual(calls[0], ['guard', 'lightweaver.local']);
  assert.equal(calls[1][1], 'http://lightweaver.local/api/clear-project');
  assert.equal(calls[1][2], 'POST');
  assert.deepEqual(JSON.parse(calls[1][3]), { confirm: CLEAR_PROJECT_CONFIRM_TOKEN });
});

test('a refused direct clear surfaces the card error and reason', async () => {
  await assert.rejects(
    clearCardProject({
      host: 'lightweaver.local',
      direct: true,
      guardImpl: async () => null,
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'missing confirmation' }) }),
    }),
    error => error instanceof ClearProjectError
      && error.reason === 'refused'
      && /missing confirmation/.test(error.message),
  );
});

test('the bridge path relays clear-project with the token', async () => {
  const sends = [];
  const response = await clearCardProject({
    host: 'lightweaver.local',
    direct: false,
    bridgeVersion: CLEAR_PROJECT_MIN_BRIDGE_VERSION,
    bridgeRequestImpl: async (type, payload, options) => {
      sends.push([type, payload, options.host]);
      return { ok: true, accepted: true, wifiPreserved: true };
    },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(sends, [['clear-project', { confirm: 'CLEAR' }, 'lightweaver.local']]);
});

test('a pre-v5 bridge is refused with the firmware-update message before any send', async () => {
  let sent = 0;
  await assert.rejects(
    clearCardProject({
      host: 'lightweaver.local',
      direct: false,
      bridgeVersion: 4,
      bridgeRequestImpl: async () => { sent += 1; return { ok: true }; },
    }),
    error => error instanceof ClearProjectError && error.reason === 'bridge-too-old',
  );
  assert.equal(sent, 0, 'no bridge message may be sent to a card that has no relay for it');
});

test('a bridge reply without ok:true is never treated as cleared', async () => {
  await assert.rejects(
    clearCardProject({
      host: 'lightweaver.local',
      direct: false,
      bridgeVersion: 5,
      bridgeRequestImpl: async () => ({ accepted: true }),
    }),
    error => error instanceof ClearProjectError && error.reason === 'unacknowledged',
  );
});
