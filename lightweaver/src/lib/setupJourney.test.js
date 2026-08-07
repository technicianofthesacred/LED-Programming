import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveSetupJourney, isSetupComplete, SETUP_STEP_IDS } from './setupJourney.js';

const jsonRoundTrip = value => JSON.parse(JSON.stringify(value));

const statuses = journey => Object.fromEntries(journey.steps.map(step => [step.id, step.status]));

// A factory-blank card that has been flashed and answers on the home network.
const FACTORY_BLANK_STATUS = {
  app: 'Lightweaver',
  cardId: 'lw-b0fe81f61b44',
  provisioningContractVersion: 1,
  firmwareVersion: '1.0.0',
  buildId: 'dev',
  bootId: 'boot-1',
  runtimePhase: 'factory',
  mode: 'factory-flash',
  source: 'defaults',
  knownGoodProject: false,
  commandReady: false,
  playbackReady: false,
  outputReady: false,
  pixels: 0,
  outputs: [],
};

// A card that classifies as fully connected and playback-ready.
const READY_STATUS = {
  app: 'Lightweaver',
  cardId: 'lw-b0fe81f61b44',
  provisioningContractVersion: 1,
  firmwareVersion: '1.0.0',
  buildId: 'dev',
  bootId: 'boot-1',
  runtimePhase: 'ready',
  mode: 'sequence',
  source: 'card',
  knownGoodProject: true,
  commandReady: true,
  playbackReady: true,
  outputReady: true,
  pixels: 120,
  outputs: [],
};

test('nothing connected starts at flash and locks everything after it', () => {
  const journey = deriveSetupJourney({});

  assert.deepEqual(journey.steps.map(step => step.id), SETUP_STEP_IDS);
  assert.equal(journey.currentStepId, 'flash');

  const status = statuses(journey);
  assert.equal(status.flash, 'current');
  assert.equal(status.wifi, 'locked');
  assert.equal(status.pin, 'locked');
  assert.equal(status.install, 'locked');
  assert.equal(status.layout, 'optional');
  assert.equal(status.save, 'optional');
  assert.equal(status.controls, 'optional');
  assert.equal(isSetupComplete(journey), false);
});

test('a flashed factory-blank card on Wi-Fi is waiting on the pin step', () => {
  const journey = deriveSetupJourney({
    cardLink: {
      state: 'connected-direct',
      host: '192.168.18.70',
      readiness: FACTORY_BLANK_STATUS,
    },
  });

  const status = statuses(journey);
  assert.equal(status.flash, 'done');
  assert.equal(status.wifi, 'done');
  assert.equal(status.pin, 'current');
  assert.equal(journey.currentStepId, 'pin');
});

test('a card still in Wi-Fi setup mode keeps the Wi-Fi step current', () => {
  const journey = deriveSetupJourney({
    cardLink: {
      state: 'connected-direct',
      host: '192.168.4.1',
      readiness: FACTORY_BLANK_STATUS,
    },
  });

  const status = statuses(journey);
  assert.equal(status.flash, 'done');
  assert.equal(status.wifi, 'current');
  assert.notEqual(status.wifi, 'done');
  assert.equal(status.pin, 'locked');
});

test('pin known but no colour order makes the colour step current', () => {
  const journey = deriveSetupJourney({
    cardLink: { state: 'connected-direct', host: '192.168.18.70' },
    project: {
      portRoles: [{ pin: 16, role: 'strip', pixelCount: 0 }],
      devices: { standaloneController: { led: { colorOrder: '' } } },
    },
  });

  const status = statuses(journey);
  assert.equal(status.pin, 'done');
  assert.equal(status.colour, 'current');
  assert.equal(status.count, 'locked');
  assert.equal(journey.currentStepId, 'colour');
});

test('pin colour and count known but the card is not installed makes install current', () => {
  const journey = deriveSetupJourney({
    cardLink: {
      state: 'connected-direct',
      host: '192.168.18.70',
      readiness: READY_STATUS,
    },
    project: {
      portRoles: [{ pin: 16, role: 'strip', pixelCount: 120 }],
      devices: { standaloneController: { led: { colorOrder: 'GRB', colorOrderConfirmed: true } } },
    },
    resolution: { matchesCurrentProject: false },
  });

  const status = statuses(journey);
  assert.equal(status.pin, 'done');
  assert.equal(status.colour, 'done');
  assert.equal(status.count, 'done');
  assert.equal(status.install, 'current');
  assert.equal(journey.currentStepId, 'install');
});

test('everything done reports a null current step and a complete journey', () => {
  const journey = deriveSetupJourney({
    cardLink: {
      state: 'connected-direct',
      host: '192.168.18.70',
      readiness: READY_STATUS,
    },
    project: {
      portRoles: [{ pin: 16, role: 'strip', pixelCount: 120 }],
      devices: { standaloneController: { led: { colorOrder: 'GRB', colorOrderConfirmed: true } } },
    },
    resolution: { matchesCurrentProject: true },
  });

  assert.equal(journey.currentStepId, null);
  const status = statuses(journey);
  assert.equal(status.flash, 'done');
  assert.equal(status.wifi, 'done');
  assert.equal(status.install, 'done');
  assert.equal(status.layout, 'optional');
  assert.equal(isSetupComplete(journey), true);
});

test('commissioning past install-safely proves the firmware even without a link', () => {
  const journey = deriveSetupJourney({
    commissioningFlow: { stage: 'set-up-card' },
  });

  const status = statuses(journey);
  assert.equal(status.flash, 'done');
  assert.equal(status.wifi, 'current');
  assert.equal(journey.currentStepId, 'wifi');
});

test('the commissioning flow may arrive as the inspect wrapper', () => {
  const journey = deriveSetupJourney({
    commissioningFlow: { flow: { stage: 'check-lights' } },
  });

  assert.equal(statuses(journey).flash, 'done');
  assert.equal(journey.currentStepId, 'wifi');
});

test('malformed card status never throws and is treated as not done', () => {
  const journey = deriveSetupJourney({
    cardLink: { state: 'garbage', host: 42, readiness: { app: 7 } },
  });

  assert.equal(statuses(journey).flash, 'current');
  assert.equal(statuses(journey).wifi, 'locked');
  assert.equal(isSetupComplete(journey), false);
});

test('the journey is JSON serializable', () => {
  const journey = deriveSetupJourney({
    cardLink: {
      state: 'connected-direct',
      host: '192.168.18.70',
      readiness: READY_STATUS,
    },
    project: {
      portRoles: [{ pin: 16, role: 'strip', pixelCount: 120 }],
      devices: { standaloneController: { led: { colorOrder: 'GRB', colorOrderConfirmed: true } } },
    },
    resolution: { matchesCurrentProject: true },
  });

  assert.deepEqual(jsonRoundTrip(journey), journey);
});

// A brand-new project ships a colour order it invented, not one the owner gave.
test('an unconfirmed colour order does not count as answered', () => {
  const journey = deriveSetupJourney({
    cardLink: { state: 'connected-direct', host: '192.168.18.70' },
    project: {
      portRoles: [{ pin: 18, role: 'strip', pixelCount: 41, controlKind: '' }],
      devices: { standaloneController: { led: { colorOrder: 'RGB' } } },
    },
  });
  const byId = Object.fromEntries(journey.steps.map(step => [step.id, step.status]));
  assert.equal(byId.colour, 'current');
  assert.equal(journey.currentStepId, 'colour');
});
