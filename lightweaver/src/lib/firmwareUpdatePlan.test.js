import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeFirmwareUpdate,
  firmwareLabel,
  resolveInstalledFirmware,
} from './firmwareUpdatePlan.js';

const card = (buildNumber, buildId = 'a'.repeat(40), firmwareVersion = '1.0.0') => ({
  buildNumber, buildId, firmwareVersion,
});

test('firmwareLabel prefers the number and falls back to the short revision', () => {
  assert.equal(firmwareLabel(card(1092)), 'Build 1092');
  assert.equal(firmwareLabel({ buildNumber: 0, buildId: 'abcdef0123456789' }), 'Build abcdef012345');
  assert.equal(firmwareLabel({}), '');
  assert.equal(firmwareLabel(null), '');
});

test('an update states both ends and the direction', () => {
  const plan = describeFirmwareUpdate({
    installed: card(1084, 'b'.repeat(40)),
    available: card(1092, 'c'.repeat(40)),
  });
  assert.equal(plan.state, 'update');
  assert.equal(plan.installedLabel, 'Build 1084');
  assert.equal(plan.availableLabel, 'Build 1092');
  assert.match(plan.headline, /on Build 1084\. This updates it to 1\.0\.0 · Build 1092\./);
});

// Installing the build already on the card is a real thing owners do by accident.
// It must not read as an upgrade, and it must still warn about the wipe.
test('the same build says so plainly instead of implying an upgrade', () => {
  const plan = describeFirmwareUpdate({ installed: card(1092), available: card(1092) });
  assert.equal(plan.state, 'same');
  assert.match(plan.headline, /already on 1\.0\.0 · Build 1092/);
  assert.doesNotMatch(plan.headline, /updates/);
});

test('the same build id counts as the same even without numbers', () => {
  const plan = describeFirmwareUpdate({
    installed: { buildId: 'd'.repeat(40), firmwareVersion: '1.0.0' },
    available: { buildId: 'D'.repeat(40), firmwareVersion: '1.0.0' },
  });
  assert.equal(plan.state, 'same');
});

test('going backwards is named as going backwards', () => {
  const plan = describeFirmwareUpdate({
    installed: card(1095, 'e'.repeat(40)),
    available: card(1092, 'f'.repeat(40)),
  });
  assert.equal(plan.state, 'downgrade');
  assert.match(plan.headline, /NEWER/);
  assert.match(plan.headline, /backwards/);
});

// The honesty rule: never let the target read as the answer to "what is on it".
test('a card this browser has never met is reported as unknown, not as a target', () => {
  const plan = describeFirmwareUpdate({ installed: null, available: card(1092) });
  assert.equal(plan.state, 'unknown');
  assert.equal(plan.installedLabel, '');
  assert.match(plan.headline, /not been connected to Studio before/);
  assert.match(plan.headline, /This installs 1\.0\.0 · Build 1092\./);
});

test('an unnumbered card is replaced, not "updated" — the direction is unprovable', () => {
  const plan = describeFirmwareUpdate({
    installed: { buildId: '1'.repeat(40) },
    available: card(1092, '2'.repeat(40)),
  });
  assert.equal(plan.state, 'sideways');
  assert.match(plan.headline, /replaces it with/);
});

test('direct USB stable semver proves an update when build numbers are unavailable', () => {
  const plan = describeFirmwareUpdate({
    installed: {
      firmwareVersion: '1.1.1', buildId: '1'.repeat(40), source: 'usb-flash',
    },
    available: {
      firmwareVersion: '1.1.3', buildNumber: 1223, buildId: '3'.repeat(40),
    },
  });
  assert.equal(plan.state, 'update');
  assert.match(plan.headline, /updates it to 1\.1\.3 · Build 1223/);
  assert.doesNotMatch(plan.headline, /replaces/);
});

test('every outcome keeps the erase warning', () => {
  const cases = [
    { installed: card(1084, 'b'.repeat(40)), available: card(1092) },
    { installed: card(1092), available: card(1092) },
    { installed: null, available: card(1092) },
    { installed: card(1095, 'e'.repeat(40)), available: card(1092) },
  ];
  for (const input of cases) {
    assert.match(describeFirmwareUpdate(input).caution, /erases the card/);
  }
});

test('no available firmware means no claim at all', () => {
  const plan = describeFirmwareUpdate({ installed: card(1084), available: null });
  assert.equal(plan.state, 'unknown');
  assert.equal(plan.headline, '');
});

test('a live link is trusted over a remembered one', () => {
  const linked = { id: 'lw-1', buildNumber: 1092, buildId: 'x'.repeat(40) };
  const remembered = { id: 'lw-1', buildNumber: 1084, buildId: 'y'.repeat(40) };
  assert.equal(
    resolveInstalledFirmware({ linkedCard: linked, rememberedCard: remembered, hardware: { cardId: 'lw-1' } }),
    linked,
  );
});

test('firmware read directly from this USB card outranks browser and LAN history', () => {
  const hardware = {
    cardId: 'lw-1', firmwareVersion: '1.1.3', buildId: 'c'.repeat(40), source: 'usb-flash',
  };
  assert.equal(resolveInstalledFirmware({
    hardware,
    linkedCard: { id: 'lw-1', firmwareVersion: '1.1.1', buildNumber: 1198, buildId: 'a'.repeat(40) },
    rememberedCard: { id: 'lw-1', firmwareVersion: '1.0.0', buildNumber: 1000, buildId: 'b'.repeat(40) },
  }), hardware);
});

// Reporting the last card's firmware for the one on the desk is worse than
// saying nothing, because it reads as a measurement of THIS card.
test('a remembered identity for a DIFFERENT card is never used', () => {
  const remembered = { id: 'lw-other', buildNumber: 1084, buildId: 'y'.repeat(40) };
  assert.equal(
    resolveInstalledFirmware({ rememberedCard: remembered, hardware: { cardId: 'lw-1' } }),
    null,
  );
});

test('a remembered identity is used when it is the card that is plugged in', () => {
  const remembered = { id: 'LW-1', buildNumber: 1084, buildId: 'y'.repeat(40) };
  assert.equal(
    resolveInstalledFirmware({ rememberedCard: remembered, hardware: { cardId: 'lw-1' } }),
    remembered,
  );
});

test('an identity carrying no firmware at all is not an answer', () => {
  assert.equal(resolveInstalledFirmware({ rememberedCard: { id: 'lw-1' }, hardware: { cardId: 'lw-1' } }), null);
  assert.equal(resolveInstalledFirmware({}), null);
});
