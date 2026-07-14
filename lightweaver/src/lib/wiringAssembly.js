const roundLength = value => Math.round(value * 10) / 10;

function scaleInfo(physicalScale) {
  const pxPerMm = typeof physicalScale === 'number' ? physicalScale : Number(physicalScale?.pxPerMm);
  const mmPerUnit = Number(physicalScale?.mmPerUnit);
  if (Number.isFinite(pxPerMm) && pxPerMm > 0) return { multiplier: 1 / pxPerMm, unit: 'mm', relative: false };
  if (Number.isFinite(mmPerUnit) && mmPerUnit > 0) return { multiplier: mmPerUnit, unit: 'mm', relative: false };
  return { multiplier: 1, unit: 'relative units', relative: true };
}

function sourcePoint(run, stripsById, first) {
  if (run?.type !== 'strip') return null;
  const strip = stripsById.get(String(run.source?.stripId));
  if (!strip) return null;
  const forward = run.physicalDirection !== 'source-reverse';
  const sourceLed = first
    ? (forward ? run.source?.from : run.source?.to)
    : (forward ? run.source?.to : run.source?.from);
  const point = strip.pixels?.[sourceLed];
  const x = Number(point?.x) + Number(strip.offsetX ?? strip.x ?? 0);
  const y = Number(point?.y) + Number(strip.offsetY ?? strip.y ?? 0);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function jumper(fromRun, toRun, stripsById, scale) {
  const from = sourcePoint(fromRun, stripsById, false);
  const to = sourcePoint(toRun, stripsById, true);
  if (!from || !to) return { toRunId: toRun.id, estimatedLength: null, lengthLabel: scale.relative ? 'Relative length unavailable' : 'Length unavailable' };
  const estimatedLength = roundLength(Math.hypot(to.x - from.x, to.y - from.y) * scale.multiplier);
  return { toRunId: toRun.id, estimatedLength, lengthLabel: `${estimatedLength} ${scale.unit}` };
}

function nextStrip(rows, index) {
  for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
    if (rows[cursor].type === 'strip') return rows[cursor];
    if (rows[cursor].type === 'inactive') return null;
  }
  return null;
}

export function deriveWiringAssembly({ wiring, compiled, strips = [], physicalScale = null } = {}) {
  if (!wiring?.locked) return { ok: false, errors: [{ code: 'wiring-unlocked', message: 'Lock verified wiring before opening the assembly map.' }], outputs: [] };
  if (!compiled?.ok) return { ok: false, errors: [{ code: 'compiler-invalid', message: 'The compiler must produce valid wiring before assembly instructions are available.' }], outputs: [] };
  if (!(compiled.sendReady === true || (wiring.verified === true && (wiring.runs || []).every(run => run.verified === true)))) {
    return { ok: false, errors: [{ code: 'wiring-unverified', message: 'Complete bench verification before using assembly instructions.' }], outputs: [] };
  }

  const compiledRuns = new Map((compiled.runs || []).map(run => [run.id, run]));
  const modelRuns = new Map((wiring.runs || []).map(run => [run.id, run]));
  const stripsById = new Map(strips.map(strip => [String(strip.id), strip]));
  const stripNames = new Map(strips.map(strip => [String(strip.id), strip.name || String(strip.id)]));
  const scale = scaleInfo(physicalScale);
  const outputs = (wiring.outputs || []).map(output => {
    const compiledOutput = (compiled.outputs || []).find(item => item.id === output.id) || {};
    const ordered = (output.runIds || []).map(id => compiledRuns.get(id) || modelRuns.get(id)).filter(Boolean);
    const rows = ordered.map((run, index) => {
      const count = Math.max(0, Number(run.count ?? (run.source ? run.source.to - run.source.from + 1 : 0)) || 0);
      const base = {
        id: run.id,
        type: run.type,
        label: run.type === 'strip' ? (stripNames.get(String(run.source?.stripId)) || run.source?.stripId || run.id) : run.type === 'cable' ? 'Cable jump' : 'Reserved · unlit',
        addressRange: count ? [run.start, run.start + count - 1] : null,
        sourceRange: run.type === 'strip' ? [run.source.from, run.source.to] : null,
        count,
        direction: run.type === 'strip' ? (run.physicalDirection === 'source-reverse' ? 'End LED → start LED' : 'Start LED → end LED') : null,
        seamLed: run.type === 'strip' ? (run.seamLed ?? null) : null,
        verified: run.verified === true,
        jumper: null,
      };
      const destination = nextStrip(ordered, index);
      if (run.type === 'cable' && destination) {
        const previous = [...ordered.slice(0, index)].reverse().find(item => item.type === 'strip');
        base.jumper = previous ? jumper(previous, destination, stripsById, scale) : { toRunId: destination.id, estimatedLength: null, lengthLabel: scale.relative ? 'Relative length unavailable' : 'Length unavailable' };
      } else if (run.type === 'strip' && ordered[index + 1]?.type === 'strip') {
        base.jumper = jumper(run, ordered[index + 1], stripsById, scale);
      }
      return base;
    });
    return {
      id: output.id,
      label: compiledOutput.name || output.name || output.id,
      pin: compiledOutput.pin ?? output.pin,
      start: compiledOutput.start ?? 0,
      count: compiledOutput.count ?? 0,
      verified: ordered.length > 0 && ordered.every(run => run.verified === true),
      runs: rows,
    };
  });
  return { ok: true, errors: [], controllerAnchor: wiring.controllerAnchor ?? null, totalPixels: compiled.totalPixels || 0, outputs, relativeLengths: scale.relative };
}
