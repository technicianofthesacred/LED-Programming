// The owner picks the LED chipset once per project. It is one global value on
// the card (RuntimeConfig.ledType), the firmware accepts exactly two, and a
// third value makes the whole install fail — so these tests pin the path from
// the project file to the JSON body of POST /api/config.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CARD_LED_TYPES,
  isCardLedType,
  normalizeCardLedType,
} from './cardHardwareContract.js';
import { cardStorageJson } from './cardPushClient.js';
import { normalizeCardRuntimeConfig } from './cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from './cardRuntimeProject.js';
import { createDefaultProject, defaultStandaloneController, migrateProject } from './projectModel.js';
import { normalizeStandaloneLed } from './standaloneController.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const firmwareStoragePath = path.resolve(here, '../../../firmware/lightweaver-controller/src/LightweaverStorage.cpp');

function projectWithLedType(type) {
  const project = createDefaultProject();
  return {
    ...project,
    devices: {
      ...project.devices,
      standaloneController: defaultStandaloneController({
        ...project.devices.standaloneController,
        led: { ...project.devices.standaloneController.led, type },
      }),
    },
  };
}

function cardPackageFor(project) {
  return buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    standaloneController: project.devices.standaloneController,
  });
}

function postedConfig(project) {
  return JSON.parse(cardStorageJson(cardPackageFor(project)));
}

test('Studio offers exactly the chipsets the firmware validator accepts', async () => {
  const storage = await readFile(firmwareStoragePath, 'utf8');
  const guard = storage.match(
    /String ledType = String\(doc\["led"\]\["type"\] \| "(\w+)"\);\s*\n\s*if \(ledType != "(\w+)" && ledType != "(\w+)"\)/,
  );
  assert.ok(guard, 'firmware LED type guard moved — re-derive the accepted chipset list before trusting the Studio picker');

  const accepted = [...new Set([guard[2], guard[3]])].sort();
  assert.deepEqual([...CARD_LED_TYPES].sort(), accepted);
  // The firmware's own fallback for a config with no LED type must also be one
  // Studio can offer, otherwise legacy cards read back a chipset we cannot show.
  assert.ok(isCardLedType(guard[1]));
});

test('each supported chipset round-trips from the project into the POST /api/config body', () => {
  for (const type of CARD_LED_TYPES) {
    const project = projectWithLedType(type);
    assert.equal(project.devices.standaloneController.led.type, type, `${type} must persist on the project`);
    assert.equal(cardPackageFor(project).config.led.type, type, `${type} must survive the runtime package`);
    assert.equal(postedConfig(project).led.type, type, `${type} must reach the card payload`);
  }
});

test('a chipset the card would reject never reaches the card payload', () => {
  for (const bogus of ['APA102', 'SK6812', 'ws2812b; DROP', '', null, 42, { type: 'WS2815' }]) {
    const project = projectWithLedType(bogus);
    const persisted = project.devices.standaloneController.led.type;
    assert.ok(isCardLedType(persisted), `project must not persist ${JSON.stringify(bogus)}`);
    assert.ok(isCardLedType(postedConfig(project).led.type), `payload must not carry ${JSON.stringify(bogus)}`);
  }

  // Even a payload assembled outside the project path is coerced, so a
  // hand-edited or bridged config cannot smuggle an unsupported chipset in.
  const smuggled = normalizeCardRuntimeConfig({ led: { type: 'APA102', pixels: 12 } });
  assert.equal(smuggled.led.type, 'WS2812B');
  assert.equal(normalizeStandaloneLed({ type: 'APA102' }).type, 'WS2815');
});

test('lowercase and padded chipset spellings normalize instead of failing the install', () => {
  assert.equal(normalizeCardLedType(' ws2815 '), 'WS2815');
  assert.equal(normalizeCardLedType('ws2812b'), 'WS2812B');
  assert.equal(normalizeCardLedType(undefined, 'WS2815'), 'WS2815');
  assert.equal(normalizeCardLedType(undefined, 'APA102'), CARD_LED_TYPES[0]);
  assert.equal(postedConfig(projectWithLedType('ws2812b')).led.type, 'WS2812B');
});

test('projects saved before the chipset picker still load and install', () => {
  // v3 project whose controller carries no led block at all.
  const bare = createDefaultProject();
  delete bare.devices.standaloneController.led;
  const migratedBare = migrateProject(JSON.parse(JSON.stringify(bare)));
  assert.ok(isCardLedType(migratedBare.devices.standaloneController.led.type));
  assert.ok(isCardLedType(postedConfig(migratedBare).led.type));

  // v1 project, which never had a standalone controller.
  const legacy = migrateProject({ version: 1, name: 'Legacy', strips: [{ id: 'a', pixelCount: 30 }] });
  assert.ok(isCardLedType(legacy.devices.standaloneController.led.type));
  assert.ok(isCardLedType(postedConfig(legacy).led.type));

  // A project explicitly saved as WS2812B keeps that choice across a reload.
  const saved = projectWithLedType('WS2812B');
  const reloaded = migrateProject(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.devices.standaloneController.led.type, 'WS2812B');
  assert.equal(postedConfig(reloaded).led.type, 'WS2812B');
});

test('every chipset gate in Studio reads the one contract list', async () => {
  const libDir = path.resolve(here);
  const sources = await Promise.all(
    ['cardWiringSafety.js', 'cardCommissioningFlow.js', 'productionJobPackage.js', 'standaloneController.js']
      .map(async name => [name, await readFile(path.join(libDir, name), 'utf8')]),
  );
  for (const [name, source] of sources) {
    // Only cardHardwareContract.js may name a chipset in a gate. Everything
    // else calls isCardLedType/normalizeCardLedType so adding a third
    // supported chipset is a one-line change in one file.
    const gates = source.replace(/^export const DEFAULT_STANDALONE_LED = \{[\s\S]*?\n\};/m, '');
    assert.doesNotMatch(
      gates,
      /\bWS2812B\b|\bWS2815\b/,
      `${name} must gate on cardHardwareContract's chipset list instead of its own copy`,
    );
  }

  // DEFAULT_CARD_LED.type is the one remaining literal in the runtime
  // contract: it is a default value, not a gate, and must stay supported.
  const contract = await readFile(path.join(libDir, 'cardRuntimeContract.js'), 'utf8');
  assert.doesNotMatch(contract, /led\.type === '/, 'the runtime contract must coerce through normalizeCardLedType');
});
