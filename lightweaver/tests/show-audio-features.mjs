import assert from 'node:assert/strict';
import { createShowAudioFeatures } from '../src/lib/showAudioFeatures.js';

const sampleRate = 44100;
const fftSize = 2048;
const binCount = fftSize / 2;
const binHz = sampleRate / fftSize;

function binsWith(ranges = []) {
  const bins = new Uint8Array(binCount);
  for (const [lo, hi, value] of ranges) {
    const first = Math.max(0, Math.ceil(lo / binHz));
    const last = Math.min(binCount - 1, Math.floor(hi / binHz));
    for (let i = first; i <= last; i++) bins[i] = value;
  }
  return bins;
}

function advance(analyzer, bins, seconds, dt = 1 / 60) {
  const frames = Math.ceil(seconds / dt);
  for (let i = 0; i < frames; i++) analyzer.updateBins(bins, dt);
}

function fresh() {
  return createShowAudioFeatures({ sampleRate, fftSize });
}

const silence = binsWith();
const broadband = binsWith([[30, 9000, 92]]);

// Invalid spectral geometry is rejected at construction time.
for (const [options, pattern] of [
  [{ sampleRate: 0, fftSize }, /sampleRate.*positive finite/i],
  [{ sampleRate: Number.NaN, fftSize }, /sampleRate.*positive finite/i],
  [{ sampleRate, fftSize: 3 }, /fftSize.*even integer/i],
  [{ sampleRate, fftSize: 2048.5 }, /fftSize.*even integer/i],
]) {
  assert.throws(() => createShowAudioFeatures(options), RangeError);
  assert.throws(() => createShowAudioFeatures(options), pattern);
}

// Public API and feature shape remain small and deterministic.
{
  const analyzer = fresh();
  assert.deepEqual(Object.keys(analyzer).sort(), [
    'getFeatures', 'reset', 'updateAnalyser', 'updateBins',
  ]);
  analyzer.updateBins(silence, 1 / 60);
  assert.deepEqual(Object.keys(analyzer.getFeatures()), [
    'bass', 'mid', 'high', 'energy', 'centroid', 'flux', 'beat',
  ]);
  for (const value of Object.values(analyzer.getFeatures())) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  }
}

// RMS bands distinguish energy in the three specified musical ranges.
for (const [name, range, dominant, others] of [
  ['bass', [45, 110], 'bass', ['mid', 'high']],
  ['mid', [300, 1200], 'mid', ['bass', 'high']],
  ['high', [3000, 7000], 'high', ['bass', 'mid']],
]) {
  const analyzer = fresh();
  advance(analyzer, binsWith([[...range, 150]]), 1);
  const frame = analyzer.getFeatures();
  assert.ok(frame[dominant] > 0.35, `${name}: dominant band is visible`);
  for (const other of others) {
    assert.ok(frame[dominant] > frame[other] * 3 + 0.05,
      `${name}: ${dominant} (${frame[dominant]}) dominates ${other} (${frame[other]})`);
  }
}

// Frequencies in the gaps above each musical band must not leak into that band.
// Use exact FFT-bin centers so the fixtures remain honest about frequency resolution.
for (const [name, requestedHz, excludedBand] of [
  ['bass upper boundary', 193.8, 'bass'],
  ['mid upper boundary', 1894.9, 'mid'],
  ['high upper boundary', 9496.1, 'high'],
]) {
  const analyzer = fresh();
  const bin = Math.round(requestedHz / binHz);
  const resolvedHz = bin * binHz;
  assert.ok(Math.abs(resolvedHz - requestedHz) <= binHz / 2,
    `${name}: fixture resolves within half an FFT bin (${resolvedHz} Hz)`);
  const bins = new Uint8Array(binCount);
  bins[bin] = 210;
  advance(analyzer, bins, 1);
  assert.ok(analyzer.getFeatures()[excludedBand] < 0.03,
    `${name}: ${resolvedHz} Hz is outside ${excludedBand} (${analyzer.getFeatures()[excludedBand]})`);
}

// Frequency-to-bin mapping follows non-default analyser geometry too.
{
  const alternateRate = 48000;
  const alternateFftSize = 4096;
  const analyzer = createShowAudioFeatures({
    sampleRate: alternateRate,
    fftSize: alternateFftSize,
  });
  const bins = new Uint8Array(alternateFftSize / 2);
  const bassBin = 10;
  const resolvedHz = bassBin * alternateRate / alternateFftSize;
  assert.ok(resolvedHz >= 30 && resolvedHz <= 140,
    `alternate geometry fixture resolves inside bass (${resolvedHz} Hz)`);
  bins[bassBin] = 210;
  analyzer.updateBins(bins, 1 / 60);
  const frame = analyzer.getFeatures();
  assert.ok(frame.bass > 0.3, `alternate geometry maps the single bin to bass (${frame.bass})`);
  assert.ok(frame.mid < 0.03 && frame.high < 0.03,
    `alternate geometry keeps the bin out of other bands (${frame.mid}, ${frame.high})`);
}

// Slowly adapting normalization must not erase a sustained musical passage.
{
  const analyzer = fresh();
  advance(analyzer, broadband, 10);
  const stabilized = analyzer.getFeatures().energy;
  advance(analyzer, broadband, 5 * 60);
  const afterFiveMinutes = analyzer.getFeatures().energy;
  assert.ok(stabilized > 0.25, `steady broadband establishes useful energy (${stabilized})`);
  assert.ok(afterFiveMinutes >= stabilized * 0.70,
    `steady energy retains >=70% after five minutes (${afterFiveMinutes} vs ${stabilized})`);
}

// A 100 ms broadband onset produces a prompt beat and a gentle sub-second tail.
{
  const analyzer = fresh();
  advance(analyzer, silence, 1);
  let peakBeat = 0;
  for (let elapsed = 0; elapsed < 0.3; elapsed += 1 / 60) {
    analyzer.updateBins(elapsed < 0.1 ? binsWith([[30, 9000, 210]]) : silence, 1 / 60);
    peakBeat = Math.max(peakBeat, analyzer.getFeatures().beat);
  }
  assert.ok(peakBeat > 0.45, `pulse raises beat within 300 ms (${peakBeat})`);

  advance(analyzer, silence, 0.25);
  const duringRelease = analyzer.getFeatures().beat;
  assert.ok(duringRelease > 0.08, `beat has a gentle release tail (${duringRelease})`);
  advance(analyzer, silence, 0.55);
  assert.ok(analyzer.getFeatures().beat < 0.08,
    `beat release settles after the sub-second tail (${analyzer.getFeatures().beat})`);
}

// Silence and a stationary low noise floor must not become a continuous beat.
for (const [name, bins] of [
  ['silence', silence],
  ['noise', binsWith([[30, 9000, 5]])],
]) {
  const analyzer = fresh();
  advance(analyzer, bins, 8);
  const frame = analyzer.getFeatures();
  assert.ok(frame.beat < 0.03, `${name}: beat stays quiet (${frame.beat})`);
  assert.ok(frame.flux < 0.03, `${name}: flux stays quiet (${frame.flux})`);
}

// A missing/empty frame is a stream gap: levels clear, transients decay, and
// the next real frame establishes a fresh spectral baseline without a false beat.
for (const missingBins of [undefined, new Uint8Array(0)]) {
  const analyzer = fresh();
  analyzer.updateBins(broadband, 1 / 60);
  analyzer.updateBins(binsWith([[30, 9000, 210]]), 1 / 60);
  const beforeGap = analyzer.getFeatures();
  analyzer.updateBins(missingBins, 1);
  const duringGap = analyzer.getFeatures();
  assert.deepEqual({
    bass: duringGap.bass,
    mid: duringGap.mid,
    high: duringGap.high,
    energy: duringGap.energy,
    centroid: duringGap.centroid,
  }, { bass: 0, mid: 0, high: 0, energy: 0, centroid: 0 });
  assert.ok(duringGap.beat < beforeGap.beat && duringGap.flux < beforeGap.flux,
    `gap decays transient features (${duringGap.beat}, ${duringGap.flux})`);
  analyzer.updateBins(broadband, 1 / 60);
  assert.ok(analyzer.getFeatures().beat < 0.03,
    `first frame after a gap resets spectral history (${analyzer.getFeatures().beat})`);
}

// Browser analyser integration reuses its frequency buffer and reset clears state.
{
  const analyzer = fresh();
  const seen = [];
  const fakeAnalyser = {
    frequencyBinCount: binCount,
    getByteFrequencyData(buffer) {
      seen.push(buffer);
      buffer.set(broadband);
    },
  };
  analyzer.updateAnalyser(fakeAnalyser, 1 / 60);
  analyzer.updateAnalyser(fakeAnalyser, 1 / 60);
  assert.equal(seen.length, 2);
  assert.strictEqual(seen[0], seen[1], 'updateAnalyser reuses one Uint8Array');

  analyzer.reset();
  assert.deepEqual(analyzer.getFeatures(), {
    bass: 0, mid: 0, high: 0, energy: 0, centroid: 0, flux: 0, beat: 0,
  });
  analyzer.updateAnalyser(fakeAnalyser, 1 / 60);
  assert.strictEqual(seen[1], seen[2], 'reset does not reallocate the analyser buffer');
}

// Browser analyser geometry must match the configured FFT size.
{
  const analyzer = fresh();
  const mismatchedAnalyser = {
    frequencyBinCount: binCount / 2,
    getByteFrequencyData() {},
  };
  assert.throws(
    () => analyzer.updateAnalyser(mismatchedAnalyser, 1 / 60),
    (error) => error instanceof RangeError
      && /frequencyBinCount/i.test(error.message)
      && error.message.includes(String(binCount))
      && error.message.includes(String(binCount / 2)),
  );
}

// A reported Web Audio sample rate must match the frequency mapping configuration.
{
  const analyzer = fresh();
  const mismatchedAnalyser = {
    frequencyBinCount: binCount,
    context: { sampleRate: 48000 },
    getByteFrequencyData() {},
  };
  assert.throws(
    () => analyzer.updateAnalyser(mismatchedAnalyser, 1 / 60),
    (error) => error instanceof RangeError
      && /sampleRate/i.test(error.message)
      && error.message.includes(String(sampleRate))
      && error.message.includes('48000'),
  );
}

console.log('show-audio-features tests passed');
