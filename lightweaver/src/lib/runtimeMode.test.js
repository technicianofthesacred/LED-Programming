import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ONLINE_STUDIO_URL,
  cardLocalSecureToolForHash,
  detectRuntimeMode,
  handBackToOnlineStudio,
  installCardSecureToolHandback,
  onlineStudioToolUrl,
} from './runtimeMode.js';

test('runtime mode follows origin capability, never browser name', () => {
  assert.deepEqual(detectRuntimeMode({ origin: 'https://led.mandalacodes.com', secureContext: true }), {
    kind: 'public-https', transport: 'direct-lna', secureTools: true, onlineStudioUrl: ONLINE_STUDIO_URL,
  });
  assert.deepEqual(detectRuntimeMode({ origin: 'http://lightweaver.local', secureContext: false }), {
    kind: 'card-local', transport: 'local-origin', secureTools: false, onlineStudioUrl: ONLINE_STUDIO_URL,
  });
});

test('the compiled public Studio target stays public when served from a secure preview origin', () => {
  assert.deepEqual(detectRuntimeMode({
    origin: 'http://127.0.0.1:4173',
    secureContext: true,
    buildTarget: 'public-https',
  }), {
    kind: 'public-https', transport: 'direct-lna', secureTools: true, onlineStudioUrl: ONLINE_STUDIO_URL,
  });
});

test('secure tool handback assigns a bounded canonical HTTPS route in the same tab', () => {
  let assigned = '';
  const url = handBackToOnlineStudio('flash', { locationRef: { assign(value) { assigned = value; } } });
  assert.equal(url, 'https://led.mandalacodes.com/#screen=flash');
  assert.equal(assigned, url);
  assert.throws(() => handBackToOnlineStudio('https://evil.example', { locationRef: { assign() {} } }), /route/i);
});

test('card-local secure routes and later navigation hand back in the same tab', () => {
  assert.equal(cardLocalSecureToolForHash('#screen=flash&mode=install'), 'flash');
  assert.equal(cardLocalSecureToolForHash('#screen=card&section=install'), 'flash');
  assert.equal(cardLocalSecureToolForHash('#screen=show&tool=microphone'), 'microphone');
  // `section=firmware` was never a real card section; provenance now points
  // at the install section, so the old dead hash matches nothing.
  assert.equal(cardLocalSecureToolForHash('#screen=card&section=firmware'), '');
  assert.equal(cardLocalSecureToolForHash('#screen=pattern'), '');

  let listener;
  let assigned = '';
  const locationRef = { hash: '#screen=pattern', assign(value) { assigned = value; } };
  const eventTarget = {
    addEventListener(type, callback) { if (type === 'hashchange') listener = callback; },
    removeEventListener() {},
  };
  const stop = installCardSecureToolHandback({ locationRef, eventTarget });
  locationRef.hash = '#screen=card&section=install';
  listener();
  assert.equal(assigned, 'https://led.mandalacodes.com/#screen=flash');
  stop();
});

test('the provenance tool routes to the card install section, a real card section', () => {
  assert.equal(
    onlineStudioToolUrl('provenance'),
    'https://led.mandalacodes.com/#screen=card&section=install',
  );
});

test('the microphone control uses the secure same-tab handback in card-local mode', async () => {
  const source = await readFile(new URL('../v3/lw-show.jsx', import.meta.url), 'utf8');
  assert.match(source, /handBackToOnlineStudio\('microphone'\)/);
  assert.match(source, /__LW_RUNTIME_MODE__/);
});
