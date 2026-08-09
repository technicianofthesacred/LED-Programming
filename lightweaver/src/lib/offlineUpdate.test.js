import test from 'node:test';
import assert from 'node:assert/strict';

import { createOfflineUpdateController } from './offlineUpdate.js';

test('offline update registers only for public HTTPS and reports ready after shell verification', async () => {
  const states = [];
  const registration = { active: {}, waiting: null, addEventListener() {} };
  const controller = createOfflineUpdateController({
    runtimeMode: { kind: 'public-https' },
    serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) },
    verifyShell: async () => true,
  });
  controller.subscribe(state => states.push(state.status));
  await controller.register();
  assert.equal(controller.getState().status, 'ready');
  assert.ok(states.includes('installing'));
  assert.ok(states.includes('ready'));
});

test('waiting update cannot activate during card mutation or unsaved transition', async () => {
  const messages = [];
  const waiting = { postMessage(message) { messages.push(message); } };
  let mutation = true;
  let unsaved = false;
  const controller = createOfflineUpdateController({
    runtimeMode: { kind: 'public-https' },
    serviceWorker: { register: async () => ({ active: {}, waiting, addEventListener() {} }), ready: Promise.resolve({}) },
    verifyShell: async () => true,
    hasActiveMutation: () => mutation,
    hasUnsavedTransition: () => unsaved,
  });
  await controller.register();
  assert.equal(controller.getState().status, 'update-waiting');
  assert.equal(controller.activateUpdate(), false);
  mutation = false;
  unsaved = true;
  assert.equal(controller.activateUpdate(), false);
  unsaved = false;
  assert.equal(controller.activateUpdate(), true);
  assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }]);
});

test('guards can bind to live Studio state and controllerchange reloads only after safe activation', async () => {
  let controllerChange;
  let reloads = 0;
  let dirty = true;
  const waiting = { postMessage() {} };
  const serviceWorker = {
    register: async () => ({ active: {}, waiting, addEventListener() {} }),
    ready: Promise.resolve({}),
    addEventListener(type, listener) { if (type === 'controllerchange') controllerChange = listener; },
  };
  const controller = createOfflineUpdateController({
    runtimeMode: { kind: 'public-https' }, serviceWorker,
    reloadImpl: () => { reloads += 1; },
  });
  controller.setGuards({ hasActiveMutation: () => false, hasUnsavedTransition: () => dirty });
  await controller.register();
  assert.equal(controller.activateUpdate(), false);
  dirty = false;
  assert.equal(controller.activateUpdate(), true);
  controllerChange();
  assert.equal(reloads, 1);
  assert.equal(controller.getState().status, 'reloading');
});

test('the Studio shell visibly reports offline readiness and offers controlled updates', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../v3/app.jsx', import.meta.url), 'utf8');
  assert.match(source, /Ready offline/);
  assert.match(source, /activateUpdate/);
  assert.match(source, /projectHasUnsavedChanges/);
});

test('card-local runtime never registers a Service Worker', async () => {
  let called = 0;
  const controller = createOfflineUpdateController({
    runtimeMode: { kind: 'card-local' },
    serviceWorker: { register: async () => { called += 1; } },
  });
  await controller.register();
  assert.equal(called, 0);
  assert.equal(controller.getState().status, 'disabled');
});
