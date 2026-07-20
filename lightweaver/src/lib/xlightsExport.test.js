import test from 'node:test';
import assert from 'node:assert/strict';

import { toXlightsXmodel } from './xlightsExport.js';

function fixture() {
  return {
    name: 'Temple & "Bloom"',
    strips: [
      {
        id: 'outer',
        name: 'Outer, "Ring"',
        pixels: [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 1 },
          { x: 2, y: 0, z: 0 },
        ],
      },
      {
        id: 'inner',
        name: 'Inner & Core',
        pixels: [
          { x: 2, y: 1, z: 1 },
          { x: 1, y: 1, z: 2 },
          { x: 0, y: 1, z: 2 },
        ],
      },
    ],
    groups: [
      { groupId: 'outer-group', name: 'Outer & Halo', members: [{ stripId: 'outer' }] },
      { groupId: 'inner-group', name: 'Inner "Core"', members: [{ stripId: 'inner' }] },
    ],
    wiring: {
      version: 1,
      locked: true,
      verified: true,
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
    xlights: {
      controllerName: 'Gallery & Card',
      protocol: 'ws2815',
      firstPort: 3,
    },
  };
}

function parseAttributes(source) {
  return Object.fromEntries(
    [...source.matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)]
      .map(([, name, value]) => [name, value]),
  );
}

function parseXmodelMetadata(xml) {
  const root = xml.match(/^<custommodel\s+([^>]+)>/m);
  const connection = xml.match(/<ControllerConnection\s+([^>]+)\/>/);
  assert.ok(root, 'custommodel root must parse');
  assert.ok(connection, 'ControllerConnection child must parse');
  return {
    model: parseAttributes(root[1]),
    connection: parseAttributes(connection[1]),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

test('exports deterministic standards-compatible xLights custom-model XML in physical wiring order', () => {
  const input = deepFreeze(fixture());
  const before = JSON.stringify(input);
  const expected = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<custommodel name="Temple &amp; &quot;Bloom&quot;" CustomWidth="3" CustomHeight="2" Depth="3" StringType="RGB Nodes" Transparency="0" PixelSize="2" ModelBrightness="0" Antialias="1" CustomStrings="2" NodeStart1="1" NodeStart2="4" Controller="Gallery &amp; Card" CustomModel=",,;1,,3|,,6;,2,|5,4,;,," SourceVersion="Lightweaver 1">',
    '  <ControllerConnection Port="3" Protocol="ws2815"/>',
    '  <subModel name="Output Port &quot;A&quot; · forward" layout="horizontal" type="ranges" line0="1-3"/>',
    '  <subModel name="Output Port,B · reverse" layout="horizontal" type="ranges" line0="4-6"/>',
    '  <subModel name="Group Outer &amp; Halo" layout="horizontal" type="ranges" line0="1-3"/>',
    '  <subModel name="Group Inner &quot;Core&quot;" layout="horizontal" type="ranges" line0="4-6"/>',
    '</custommodel>',
    '',
  ].join('\n');

  assert.equal(toXlightsXmodel(input), expected);
  assert.equal(toXlightsXmodel(input), expected, 'bytes must be deterministic');
  assert.equal(JSON.stringify(input), before, 'export must not mutate the project');

  const metadata = parseXmodelMetadata(toXlightsXmodel(input));
  assert.deepEqual(
    {
      controller: metadata.model.Controller,
      strings: metadata.model.CustomStrings,
      outputStarts: [metadata.model.NodeStart1, metadata.model.NodeStart2],
      firstPort: metadata.connection.Port,
      protocol: metadata.connection.Protocol,
    },
    {
      controller: 'Gallery &amp; Card',
      strings: '2',
      outputStarts: ['1', '4'],
      firstPort: '3',
      protocol: 'ws2815',
    },
  );
});

test('xLights export fails closed for unknown wiring and lossy or invalid coordinates', () => {
  const valid = fixture();
  assert.throws(() => toXlightsXmodel({ ...valid, wiring: null }), /wiring/i);
  assert.throws(() => toXlightsXmodel({ ...valid, wiring: { outputs: [], runs: [] } }), /wiring|pixel/i);

  const duplicate = fixture();
  duplicate.strips[0].pixels[1] = { ...duplicate.strips[0].pixels[0] };
  assert.throws(() => toXlightsXmodel(duplicate), /same x\/y\/z|coordinate/i);

  const nonFinite = fixture();
  nonFinite.strips[0].pixels[0].z = Number.NaN;
  assert.throws(() => toXlightsXmodel(nonFinite), /finite.*z|coordinate/i);

  const withCable = fixture();
  withCable.wiring.outputs[0].runIds.push('jump');
  withCable.wiring.runs.push({ id: 'jump', type: 'cable', verified: false });
  assert.throws(() => toXlightsXmodel(withCable), /send-ready|locked.*verified|physical wiring/i);

  const large = fixture();
  large.strips = [{
    id: 'large',
    name: 'Large',
    pixels: Array.from({ length: 101 }, (_, index) => ({ x: index, y: index, z: index })),
  }];
  large.groups = [];
  large.wiring = {
    version: 1,
    locked: true,
    verified: true,
    outputs: [{ id: 'out', name: 'Output', pin: 16, runIds: ['large-run'] }],
    runs: [{
      id: 'large-run', type: 'strip', verified: true,
      source: { stripId: 'large', from: 0, to: 100 },
      physicalDirection: 'source-forward', directionPolicy: 'fixed', seamLed: null,
    }],
  };
  assert.throws(() => toXlightsXmodel(large), /grid.*limit/i);
});

test('xLights grid preserves non-uniform coordinate spacing instead of collapsing to ranks', () => {
  const spaced = fixture();
  spaced.strips[0].pixels[1].x = 2;
  spaced.strips[0].pixels[2].x = 10;
  spaced.strips[1].pixels[0].x = 10;
  spaced.strips[1].pixels[1].x = 2;
  for (const pixel of spaced.strips[1].pixels) pixel.y = 10;

  const model = toXlightsXmodel(spaced);
  assert.match(model, /CustomWidth="11"/);
  assert.match(model, /CustomHeight="11"/);
});

test('xLights geometry export is independent from optional Art-Net controller settings', () => {
  const input = fixture();
  input.artnet = { startUniverse: -1, startChannel: 999, channelsPerUniverse: 511 };
  assert.doesNotThrow(() => toXlightsXmodel(input));
});
