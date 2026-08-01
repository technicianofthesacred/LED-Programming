import { CARD_HARDWARE_CAPABILITIES } from './cardRuntimeContract.js';
import { compileCardKaleidoscopeMappings } from './cardKaleidoscope.js';
import { validateWiring } from './wiringModel.js';

const stripCount = strip => Math.max(0, Math.trunc(Number(strip?.pixelCount ?? strip?.pixels?.length ?? strip?.leds ?? 0)));

function sourceOrder(run) {
  let values = Array.from({ length: run.source.to - run.source.from + 1 }, (_, index) => run.source.from + index);
  if (run.seamLed != null) {
    const seamIndex = values.indexOf(run.seamLed);
    if (seamIndex >= 0) values = [...values.slice(seamIndex), ...values.slice(0, seamIndex)];
  }
  return values;
}

function rangeSourceStep(range, pixels) {
  if (range.count < 2) return null;
  const start = range.start;
  const step = pixels[start + 1].sourceLed - pixels[start].sourceLed;
  if (step !== 1 && step !== -1) return false;
  for (let offset = 2; offset < range.count; offset += 1) {
    if (pixels[start + offset].sourceLed - pixels[start + offset - 1].sourceLed !== step) {
      return false;
    }
  }
  return step;
}

function canCoalesceZoneRanges(previous, next, pixels, runsById, previousPhysicalRunById) {
  if (previous.start + previous.count !== next.start) return false;
  const previousPixel = pixels[next.start - 1];
  const nextPixel = pixels[next.start];
  if (!previousPixel || !nextPixel
    || previousPixel.outputId !== nextPixel.outputId
    || previousPixel.stripId !== nextPixel.stripId
    || previousPhysicalRunById.get(nextPixel.runId) !== previousPixel.runId) return false;

  const previousRun = runsById.get(previousPixel.runId);
  const nextRun = runsById.get(nextPixel.runId);
  if ((previousRun?.physicalDirection || 'source-forward')
    !== (nextRun?.physicalDirection || 'source-forward')) return false;

  const boundaryStep = nextPixel.sourceLed - previousPixel.sourceLed;
  if (boundaryStep !== 1 && boundaryStep !== -1) return false;
  const previousStep = rangeSourceStep(previous, pixels);
  const nextStep = rangeSourceStep(next, pixels);
  return previousStep !== false
    && nextStep !== false
    && (previousStep == null || previousStep === boundaryStep)
    && (nextStep == null || nextStep === boundaryStep);
}

function coalesceZoneRanges(zone, pixels, runsById, previousPhysicalRunById) {
  const ranges = [];
  for (const range of zone.ranges) {
    const previous = ranges[ranges.length - 1];
    if (previous && canCoalesceZoneRanges(previous, range, pixels, runsById, previousPhysicalRunById)) {
      previous.count += range.count;
    } else {
      ranges.push({ ...range });
    }
  }
  return { ...zone, ranges };
}

export function compileWiring({ wiring, strips = [], groups = [], capabilities = CARD_HARDWARE_CAPABILITIES } = {}) {
  const validation = validateWiring(wiring, strips, capabilities);
  const model = validation.wiring;
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];
  const empty = { ok: false, sendReady: false, errors, warnings, totalPixels: 0, physicalOutputCount: 0, outputs: [], runs: [], pixels: [], zones: [], kaleidoscopeMappings: [] };
  if (errors.length) return empty;
  const runsById = new Map(model.runs.map(run => [run.id, run]));
  const previousPhysicalRunById = new Map();
  for (const output of model.outputs) {
    for (let index = 1; index < output.runIds.length; index += 1) {
      previousPhysicalRunById.set(output.runIds[index], output.runIds[index - 1]);
    }
  }
  const stripsById = new Map(strips.map(strip => [strip.id, strip]));
  const zoneByStripId = new Map();
  for (const group of groups || []) {
    const id = String(group.groupId || group.id || '');
    if (!id) continue;
    for (const member of group.members || []) {
      const stripId = typeof member === 'string' ? member : member?.stripId;
      if (stripId) zoneByStripId.set(stripId, { id, label: String(group.name || group.label || id) });
    }
  }
  const outputs = [];
  const runs = [];
  const pixels = [];
  const zoneMap = new Map();

  for (const output of model.outputs) {
    const outputStart = pixels.length;
    let previousWasStrip = false;
    let previousRun = null;
    for (const runId of output.runIds) {
      const run = runsById.get(runId);
      const start = pixels.length;
      if (run.type === 'cable') {
        runs.push({ ...run, outputId: output.id, start, count: 0 });
        previousWasStrip = false;
        previousRun = null;
        continue;
      }
      if (run.type === 'inactive') {
        for (let index = 0; index < run.count; index++) pixels.push({ index: pixels.length, runId, outputId: output.id, stripId: null, sourceLed: null, x: 0, y: 0, inactive: true });
        runs.push({ ...run, outputId: output.id, start, count: run.count });
        previousWasStrip = false;
        previousRun = null;
        continue;
      }
      if (previousWasStrip && !(model.verified && previousRun?.verified && run.verified)) warnings.push({ code: 'boundary-unverified', runId, message: `Boundary before ${runId} has not been verified.` });
      previousWasStrip = true;
      previousRun = run;
      const strip = stripsById.get(run.source.stripId);
      const order = sourceOrder(run);
      for (const sourceLed of order) {
        const sourcePixel = strip.pixels?.[sourceLed] || {};
        pixels.push({
          index: pixels.length,
          runId,
          outputId: output.id,
          stripId: strip.id,
          sourceLed,
          x: Number(sourcePixel.x || 0) + Number(strip.offsetX || strip.x || 0),
          y: Number(sourcePixel.y || 0) + Number(strip.offsetY || strip.y || 0),
          inactive: false,
        });
      }
      const compiledRun = { ...run, outputId: output.id, start, count: order.length, reversed: run.physicalDirection === 'source-reverse' };
      runs.push(compiledRun);
      const zoneIdentity = zoneByStripId.get(run.source.stripId) || { id: run.source.stripId, label: strip.name || run.source.stripId };
      const zoneId = zoneIdentity.id;
      const zone = zoneMap.get(zoneId) || { ...zoneIdentity, ranges: [] };
      zone.ranges.push({ start, count: order.length });
      zoneMap.set(zoneId, zone);
    }
    const count = pixels.length - outputStart;
    const outputRuns = runs.filter(run => run.outputId === output.id && run.count > 0 && run.type !== 'cable');
    const segments = outputRuns.map(run => ({ id: run.id, count: run.count, direction: run.reversed ? 'reverse' : 'forward' }));
    const stripDirections = new Set(outputRuns.filter(run => run.type === 'strip').map(run => run.reversed ? 'reverse' : 'forward'));
    const direction = stripDirections.size === 1 ? [...stripDirections][0] : stripDirections.size > 1 ? 'mixed' : 'forward';
    outputs.push({ id: output.id, name: output.name || output.id, pin: output.pin, start: outputStart, count, pixels: count, direction, segments });
  }

  if (pixels.length > capabilities.maxPixels) errors.push({ code: 'pixel-limit', message: `Compiled wiring uses ${pixels.length} pixels; hardware supports ${capabilities.maxPixels}.` });
  const zones = [...zoneMap.values()].map(zone => (
    coalesceZoneRanges(zone, pixels, runsById, previousPhysicalRunById)
  ));
  if (zones.length > capabilities.maxZones) errors.push({ code: 'zone-limit', message: `Compiled wiring uses ${zones.length} zones.` });
  for (const zone of zones) if (zone.ranges.length > capabilities.maxRangesPerZone) errors.push({ code: 'zone-range-limit', zoneId: zone.id, message: `Zone ${zone.id} has too many ranges.` });
  const kaleidoscope = compileCardKaleidoscopeMappings({ strips, pixels, zones });
  errors.push(...kaleidoscope.errors);
  const ok = errors.length === 0;
  const sendReady = ok && model.locked && model.verified && model.runs.every(run => run.verified) && model.migrationWarnings.length === 0;
  return { ok, sendReady, errors, warnings, totalPixels: pixels.length, physicalOutputCount: outputs.length, outputs, runs, pixels, zones, groups, kaleidoscopeMappings: kaleidoscope.mappings };
}
