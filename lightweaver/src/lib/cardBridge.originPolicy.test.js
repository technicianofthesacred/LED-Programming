import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCardBridgeLaunchUrl } from './cardBridge.js';

function relayedStudioOrigin(origin) {
  globalThis.window = { location: { origin, href: `${origin}/#screen=patterns` } };
  const launch = new URL(buildCardBridgeLaunchUrl('192.168.4.1'));
  return new URLSearchParams(launch.hash.slice(1)).get('studioOrigin');
}

test('card bridge launch trusts every direct CORS Studio origin', () => {
  const trustedOrigins = [
    'https://led.mandalacodes.com',
    'https://lightweaver-edw.pages.dev',
    'http://localhost',
    'http://localhost:5173',
    'https://localhost',
    'https://localhost:5173',
    'http://127.0.0.1',
    'http://127.0.0.1:5173',
  ];

  for (const origin of trustedOrigins) {
    assert.equal(relayedStudioOrigin(origin), origin);
  }
});

test('card bridge launch rejects Cloudflare Pages preview subdomains', () => {
  for (const origin of [
    'https://attacker.lightweaver-edw.pages.dev',
    'https://studio.lightweaver-edw.pages.dev',
  ]) {
    assert.equal(relayedStudioOrigin(origin), null);
  }
});

test('card bridge launch rejects origins excluded by direct CORS', () => {
  for (const origin of ['https://127.0.0.1', 'https://evil.example']) {
    assert.equal(relayedStudioOrigin(origin), null);
  }
});
