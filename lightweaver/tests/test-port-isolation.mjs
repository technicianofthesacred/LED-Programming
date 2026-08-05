// Guards the fix for a silent-false-pass: two Conductor workspaces sharing one
// test port meant Playwright adopted the other workspace's Vite server and
// reported a clean suite for source it never loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { derivePort, testPort, workspaceRoot, PORT_BAND_START, PORT_BAND_SIZE } from './testPort.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('sibling workspaces of the same repo never share a port', () => {
  const ports = [
    '/Users/x/conductor/workspaces/led/oslo/lightweaver',
    '/Users/x/conductor/workspaces/led/london/lightweaver',
    '/Users/x/conductor/workspaces/led/seoul/lightweaver',
    '/Users/x/Documents/Coding/led/lightweaver',
  ].map(derivePort);
  assert.equal(new Set(ports).size, ports.length, `sibling workspaces collided: ${ports}`);
});

test('the derived port is stable for one workspace so server reuse stays safe', () => {
  const root = '/Users/x/conductor/workspaces/led/oslo/lightweaver';
  assert.equal(derivePort(root), derivePort(root));
});

test('derived ports stay inside the reserved band, clear of the dev port', () => {
  for (const root of [workspaceRoot, '/a', '/b/c/d', 'x'.repeat(200)]) {
    const port = derivePort(root);
    assert.ok(port >= PORT_BAND_START && port < PORT_BAND_START + PORT_BAND_SIZE, `${port} out of band`);
    assert.notEqual(port, 9999, 'must not collide with the app dev port');
    assert.notEqual(port, 9997, 'must not reuse the old shared default');
  }
});

test('LIGHTWEAVER_TEST_PORT still wins when a specific port is needed', () => {
  assert.equal(
    Number(process.env.LIGHTWEAVER_TEST_PORT || derivePort(workspaceRoot)),
    testPort,
  );
});

test('no test or config hardcodes the old shared default port', () => {
  const files = ['playwright.config.ts', 'tests/capture.mjs', 'tests/production-setup.spec.ts',
                 'tests/card-workspace.spec.ts', 'tests/layout-send-to-card.spec.ts'];
  for (const file of files) {
    const body = readFileSync(resolve(here, '..', file), 'utf8');
    assert.doesNotMatch(body, /\b9997\b/, `${file} still pins the shared port`);
  }
});
