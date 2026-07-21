import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtNetSetupNotes, toMadrixFixtureCsv } from './madrixPatchExport.js';

function fixture() {
  return {
    name: 'Temple & "Bloom"',
    strips: [
      {
        id: 'outer', name: 'Outer, "Ring"',
        pixels: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 0 }],
      },
      {
        id: 'inner', name: 'Inner & Core',
        pixels: [{ x: 2, y: 1, z: 1 }, { x: 1, y: 1, z: 2 }, { x: 0, y: 1, z: 2 }],
      },
    ],
    groups: [
      { groupId: 'outer-group', name: 'Outer & Halo', members: [{ stripId: 'outer' }] },
      { groupId: 'inner-group', name: 'Inner "Core"', members: [{ stripId: 'inner' }] },
    ],
    wiring: {
      version: 1, locked: true, verified: true,
      outputs: [
        { id: 'out-a', name: 'Port "A"', pin: 16, runIds: ['outer-run'] },
        { id: 'out-b', name: 'Port,B', pin: 17, runIds: ['inner-run'] },
      ],
      runs: [
        {
          id: 'outer-run', type: 'strip', verified: true,
          source: { stripId: 'outer', from: 0, to: 2 },
          physicalDirection: 'source-forward', directionPolicy: 'fixed', seamLed: null,
        },
        {
          id: 'inner-run', type: 'strip', verified: true,
          source: { stripId: 'inner', from: 0, to: 2 },
          physicalDirection: 'source-reverse', directionPolicy: 'fixed', seamLed: 1,
        },
      ],
    },
    artnet: {
      startUniverse: 7,
      startChannel: 504,
      channelsPerUniverse: 510,
      fps: 40,
      targetMode: 'unicast',
      targetIp: '192.168.1.50',
    },
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

test('exports an exact MADRIX fixture-list CSV with rollover, physical order, outputs, groups, and direction', () => {
  const input = deepFreeze(fixture());
  const before = JSON.stringify(input);
  const expected = [
    'Product,Display Name,Fixture ID,Position X,Position Y,Position Z,DMX Universe,DMX Channel,Lightweaver Output ID,Lightweaver Output,Lightweaver Group,Lightweaver Direction,Source Strip,Source LED,Physical Pixel,Output Pixel',
    'Generic RGB Light 3 Channels,"Port ""A"" / Outer, ""Ring"" / 1",1,0,0,0,7,504,out-a,"Port ""A""",Outer & Halo,forward,"Outer, ""Ring""",0,0,0',
    'Generic RGB Light 3 Channels,"Port ""A"" / Outer, ""Ring"" / 2",2,1,0,1,7,507,out-a,"Port ""A""",Outer & Halo,forward,"Outer, ""Ring""",1,1,1',
    'Generic RGB Light 3 Channels,"Port ""A"" / Outer, ""Ring"" / 3",3,2,0,0,8,0,out-a,"Port ""A""",Outer & Halo,forward,"Outer, ""Ring""",2,2,2',
    'Generic RGB Light 3 Channels,"Port,B / Inner & Core / 2",4,1,1,2,8,3,out-b,"Port,B","Inner ""Core""",reverse,Inner & Core,1,3,0',
    'Generic RGB Light 3 Channels,"Port,B / Inner & Core / 3",5,0,1,2,8,6,out-b,"Port,B","Inner ""Core""",reverse,Inner & Core,2,4,1',
    'Generic RGB Light 3 Channels,"Port,B / Inner & Core / 1",6,2,1,1,8,9,out-b,"Port,B","Inner ""Core""",reverse,Inner & Core,0,5,2',
    '',
  ].join('\n');

  assert.equal(toMadrixFixtureCsv(input), expected);
  assert.equal(toMadrixFixtureCsv(input), expected, 'bytes must be deterministic');
  assert.equal(JSON.stringify(input), before, 'export must not mutate the project');
});

test('generates exact Art-Net setup notes from the same fixture addresses', () => {
  const expected = [
    '# Lightweaver Art-Net Setup',
    '',
    'Project: Temple & "Bloom"',
    'Target: 192.168.1.50 (unicast)',
    'Frame rate: 40 FPS',
    'Addressing: 0-based universe and channel',
    'Channels per universe: 510',
    'Start: universe 7, channel 504',
    'Patch: 6 active RGB pixels / 18 channels / universes 7-8',
    '',
    '## MADRIX 5 CSV import',
    '- Enable Use Header Line and select line 1.',
    '- Map Product, Display Name, Fixture ID, Position X/Y/Z, DMX Universe, and DMX Channel.',
    '- Set DMX address Index to 0-Based.',
    '- Map Product to an RGB fixture profile with exactly 3 channels per pixel.',
    '',
    '## Physical outputs',
    '- Port "A" [out-a], GPIO 16: output pixels 0-2; 3 active; universe 7 channel 504 through universe 8 channel 2; direction forward.',
    '- Port,B [out-b], GPIO 17: output pixels 0-2; 3 active; universe 8 channel 3 through universe 8 channel 11; direction reverse.',
    '',
    '## Groups',
    '- Outer & Halo: fixture IDs 1-3.',
    '- Inner "Core": fixture IDs 4-6.',
    '',
  ].join('\n');
  assert.equal(createArtNetSetupNotes(fixture()), expected);
});

test('MADRIX export validates addressing bounds and fails closed for unknown wiring', () => {
  const valid = fixture();
  assert.throws(() => toMadrixFixtureCsv({ ...valid, wiring: null }), /wiring/i);
  assert.throws(() => toMadrixFixtureCsv({ ...valid, artnet: { ...valid.artnet, startUniverse: -1 } }), /universe/i);
  assert.throws(() => toMadrixFixtureCsv({ ...valid, artnet: { ...valid.artnet, startChannel: 505 } }), /channel/i);
  assert.throws(() => toMadrixFixtureCsv({ ...valid, artnet: { ...valid.artnet, channelsPerUniverse: 511 } }), /divisible by 3|channels per universe/i);
  assert.throws(() => toMadrixFixtureCsv({ ...valid, artnet: { ...valid.artnet, startUniverse: 32767 } }), /universe.*range/i);

  const withCable = fixture();
  withCable.wiring.outputs[0].runIds.push('jump');
  withCable.wiring.runs.push({ id: 'jump', type: 'cable', verified: false });
  assert.throws(() => toMadrixFixtureCsv(withCable), /send-ready|locked.*verified|physical wiring/i);
});

test('MADRIX coordinates round-trip every finite source number without precision loss', () => {
  const input = fixture();
  input.strips[0].pixels[0] = {
    x: 0.12345678912345678,
    y: -98765.43210987654,
    z: Number.MIN_VALUE,
  };

  const firstFixture = parseCsvLine(toMadrixFixtureCsv(input).split('\n')[1]);
  assert.equal(Number(firstFixture[3]), input.strips[0].pixels[0].x);
  assert.equal(Number(firstFixture[4]), input.strips[0].pixels[0].y);
  assert.equal(Number(firstFixture[5]), input.strips[0].pixels[0].z);

  const overflow = fixture();
  overflow.strips[0].pixels[0].x = Number.MAX_VALUE;
  overflow.strips[0].offsetX = Number.MAX_VALUE;
  assert.throws(() => toMadrixFixtureCsv(overflow), /coordinate x.*finite|finite.*x/i);
});
