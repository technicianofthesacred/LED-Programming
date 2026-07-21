import { dmxAddressForPixel, pixelsFromWiring } from './export.js';

const MAX_ARTNET_UNIVERSE = 32_767;
const MADRIX_PRODUCT = 'Generic RGB Light 3 Channels';

function integerInRange(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function requirePhysicalWiring(wiring) {
  if (!wiring || !Array.isArray(wiring.outputs) || !wiring.outputs.length
    || !Array.isArray(wiring.runs) || !wiring.runs.length) {
    throw new TypeError('A known physical wiring model is required for fixture export');
  }
}

function normalizeArtNet(input = {}) {
  const channelsPerUniverse = integerInRange(
    input.channelsPerUniverse ?? 510,
    'Art-Net channels per universe',
    3,
    512,
  );
  if (channelsPerUniverse % 3 !== 0) {
    throw new RangeError('Art-Net channels per universe must be divisible by 3 for RGB pixels');
  }
  const startChannel = integerInRange(
    input.startChannel ?? 0,
    'Art-Net start channel',
    0,
    channelsPerUniverse - 3,
  );
  if (startChannel % 3 !== 0) {
    throw new RangeError('Art-Net start channel must align to an RGB pixel boundary');
  }
  return {
    startUniverse: integerInRange(
      input.startUniverse ?? 0,
      'Art-Net start universe',
      0,
      MAX_ARTNET_UNIVERSE,
    ),
    startChannel,
    channelsPerUniverse,
    fps: integerInRange(input.fps ?? 40, 'Art-Net frame rate', 1, 240),
    targetMode: String(input.targetMode || 'unicast'),
    targetIp: String(input.targetIp || '').trim(),
  };
}

function groupByStrip(groups = []) {
  const map = new Map();
  for (const group of groups || []) {
    const id = String(group?.groupId || group?.id || '').trim();
    if (!id) continue;
    const label = String(group?.name || group?.label || id);
    for (const member of group.members || []) {
      const stripId = typeof member === 'string' ? member : member?.stripId;
      if (stripId) map.set(String(stripId), { id, label });
    }
  }
  return map;
}

function finiteCoordinate(value, axis, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`Fixture coordinate ${axis} must be finite`);
  return Object.is(number, -0) ? 0 : number;
}

function sourcePosition(pixel, strip) {
  const source = strip?.pixels?.[pixel.sourceLed];
  if (!source) throw new TypeError(`Wiring pixel ${pixel.index} has no known source coordinate`);
  const sum = (value, offset, axis) => {
    const result = finiteCoordinate(value, axis) + finiteCoordinate(offset, `${axis} offset`);
    if (!Number.isFinite(result)) throw new TypeError(`Fixture coordinate ${axis} must remain finite after offset`);
    return Object.is(result, -0) ? 0 : result;
  };
  const x = sum(source.x, strip.offsetX ?? strip.x, 'x');
  const y = sum(source.y, strip.offsetY ?? strip.y, 'y');
  const z = sum(source.z, strip.offsetZ ?? strip.z, 'z');
  return { x, y, z };
}

function directionForRun(run) {
  return run?.physicalDirection === 'source-reverse' ? 'reverse' : 'forward';
}

export function compileFixturePatch(input = {}) {
  requirePhysicalWiring(input.wiring);
  const strips = Array.isArray(input.strips) ? input.strips : [];
  const groups = Array.isArray(input.groups) ? input.groups : [];
  const artnet = normalizeArtNet(input.artnet);
  const physicalPixels = pixelsFromWiring(
    input.wiring,
    strips,
    groups,
    undefined,
    { requireSendReady: true },
  );
  if (!physicalPixels.length) throw new TypeError('Physical wiring contains no addressable pixels');

  const stripsById = new Map(strips.map(strip => [String(strip.id), strip]));
  const runsById = new Map(input.wiring.runs.map(run => [String(run.id), run]));
  const outputsById = new Map(input.wiring.outputs.map(output => [String(output.id), output]));
  const groupsByStrip = groupByStrip(groups);
  const outputOffsets = new Map();
  const fixtures = [];

  for (const pixel of physicalPixels) {
    const outputId = String(pixel.outputId || '');
    const outputPixel = outputOffsets.get(outputId) || 0;
    outputOffsets.set(outputId, outputPixel + 1);
    const address = dmxAddressForPixel(pixel.index, {
      startUniverse: artnet.startUniverse,
      startChannel: artnet.startChannel,
      channelsPerUniverse: artnet.channelsPerUniverse,
      channelsPerPixel: 3,
      maxUniverse: MAX_ARTNET_UNIVERSE,
    });
    if (pixel.inactive) continue;
    const strip = stripsById.get(String(pixel.stripId));
    const run = runsById.get(String(pixel.runId));
    const output = outputsById.get(outputId);
    if (!strip || !run || !output) throw new TypeError(`Wiring pixel ${pixel.index} has unknown physical metadata`);
    const group = groupsByStrip.get(String(strip.id)) || {
      id: String(strip.id),
      label: String(strip.name || strip.id),
    };
    fixtures.push({
      fixtureId: fixtures.length + 1,
      physicalPixel: pixel.index,
      outputPixel,
      outputId,
      outputName: String(output.name || output.id),
      outputPin: output.pin,
      runId: String(run.id),
      direction: directionForRun(run),
      stripId: String(strip.id),
      stripName: String(strip.name || strip.id),
      sourceLed: pixel.sourceLed,
      groupId: group.id,
      groupName: group.label,
      ...sourcePosition(pixel, strip),
      ...address,
    });
  }
  if (!fixtures.length) throw new TypeError('Physical wiring contains no active fixture pixels');
  return { artnet, physicalPixelCount: physicalPixels.length, fixtures };
}

function csvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function coordinate(value) {
  return String(Object.is(value, -0) ? 0 : value);
}

export function toMadrixFixtureCsv(input = {}) {
  const { fixtures } = compileFixturePatch(input);
  const rows = [[
    'Product', 'Display Name', 'Fixture ID', 'Position X', 'Position Y', 'Position Z',
    'DMX Universe', 'DMX Channel', 'Lightweaver Output ID', 'Lightweaver Output',
    'Lightweaver Group', 'Lightweaver Direction', 'Source Strip', 'Source LED',
    'Physical Pixel', 'Output Pixel',
  ]];
  for (const fixture of fixtures) rows.push([
    MADRIX_PRODUCT,
    `${fixture.outputName} / ${fixture.stripName} / ${fixture.sourceLed + 1}`,
    fixture.fixtureId,
    coordinate(fixture.x),
    coordinate(fixture.y),
    coordinate(fixture.z),
    fixture.universe,
    fixture.channel,
    fixture.outputId,
    fixture.outputName,
    fixture.groupName,
    fixture.direction,
    fixture.stripName,
    fixture.sourceLed,
    fixture.physicalPixel,
    fixture.outputPixel,
  ]);
  return `${rows.map(row => row.map(csvField).join(',')).join('\n')}\n`;
}

function addressLabel(fixture, end = false) {
  const absolute = fixture.channel + (end ? 2 : 0);
  return `universe ${fixture.universe} channel ${absolute}`;
}

function compressIds(ids) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let end = start;
  for (const value of sorted.slice(1)) {
    if (value === end + 1) {
      end = value;
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = value;
      end = value;
    }
  }
  if (start !== undefined) ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(',');
}

export function createArtNetSetupNotes(input = {}) {
  const patch = compileFixturePatch(input);
  const { artnet, fixtures } = patch;
  const first = fixtures[0];
  const last = fixtures[fixtures.length - 1];
  const outputLines = [];
  for (const output of input.wiring.outputs) {
    const items = fixtures.filter(fixture => fixture.outputId === String(output.id));
    if (!items.length) continue;
    const directions = [...new Set(items.map(item => item.direction))];
    outputLines.push(
      `- ${String(output.name || output.id)} [${output.id}], GPIO ${output.pin}: `
      + `output pixels ${items[0].outputPixel}-${items[items.length - 1].outputPixel}; `
      + `${items.length} active; ${addressLabel(items[0])} through ${addressLabel(items[items.length - 1], true)}; `
      + `direction ${directions.length === 1 ? directions[0] : 'mixed'}.`,
    );
  }
  const groupOrder = [];
  const fixtureIdsByGroup = new Map();
  for (const fixture of fixtures) {
    if (!fixtureIdsByGroup.has(fixture.groupId)) {
      fixtureIdsByGroup.set(fixture.groupId, []);
      groupOrder.push({ id: fixture.groupId, label: fixture.groupName });
    }
    fixtureIdsByGroup.get(fixture.groupId).push(fixture.fixtureId);
  }
  const target = artnet.targetIp || '<controller-ip>';
  return [
    '# Lightweaver Art-Net Setup',
    '',
    `Project: ${String(input.name || 'Untitled Project')}`,
    `Target: ${target} (${artnet.targetMode})`,
    `Frame rate: ${artnet.fps} FPS`,
    'Addressing: 0-based universe and channel',
    `Channels per universe: ${artnet.channelsPerUniverse}`,
    `Start: universe ${artnet.startUniverse}, channel ${artnet.startChannel}`,
    `Patch: ${fixtures.length} active RGB pixels / ${fixtures.length * 3} channels / universes ${first.universe}-${last.universe}`,
    '',
    '## MADRIX 5 CSV import',
    '- Enable Use Header Line and select line 1.',
    '- Map Product, Display Name, Fixture ID, Position X/Y/Z, DMX Universe, and DMX Channel.',
    '- Set DMX address Index to 0-Based.',
    '- Map Product to an RGB fixture profile with exactly 3 channels per pixel.',
    '',
    '## Physical outputs',
    ...outputLines,
    '',
    '## Groups',
    ...groupOrder.map(group => `- ${group.label}: fixture IDs ${compressIds(fixtureIdsByGroup.get(group.id))}.`),
    '',
  ].join('\n');
}
