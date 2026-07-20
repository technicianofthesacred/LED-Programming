import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  OFFLINE_AUDIO_CAPABILITY,
  OFFLINE_AUDIO_LANES_VERSION,
  analyzeOfflineAudioWav,
  createOfflineAudioRequirement,
} from './offlineAudioLanes.js';
import {
  DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR,
  classifyPatternLabCompatibility,
} from './patternLabCompatibility.js';

const SAMPLE_RATE = 24_000;
const WINDOW_SIZE = 1024;
const HOP_SIZE = 512;
const DURATION_SECONDS = 1.6;

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function fixtureSample(time) {
  if (time < 0.2) return 0;
  if (time < 0.55) return Math.sin(time * Math.PI * 2 * 93.75) * 0.72;
  if (time < 0.9) return Math.sin(time * Math.PI * 2 * 703.125) * 0.72;
  if (time < 1.25) return Math.sin(time * Math.PI * 2 * 4218.75) * 0.72;
  return (
    Math.sin(time * Math.PI * 2 * 93.75)
    + Math.sin(time * Math.PI * 2 * 703.125)
    + Math.sin(time * Math.PI * 2 * 4218.75)
  ) * 0.22;
}

function generatedPcm16Wav() {
  const frames = Math.round(SAMPLE_RATE * DURATION_SECONDS);
  const dataBytes = frames * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < frames; index += 1) {
    const sample = Math.max(-1, Math.min(1, fixtureSample(index / SAMPLE_RATE)));
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return bytes;
}

function meanInRange(result, lane, startSeconds, endSeconds) {
  const { hopSize, sampleRate } = result.settings;
  const values = result.lanes[lane].filter((_, index) => {
    const seconds = index * hopSize / sampleRate;
    return seconds >= startSeconds && seconds <= endSeconds;
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const SETTINGS = {
  sampleRate: SAMPLE_RATE,
  windowSize: WINDOW_SIZE,
  hopSize: HOP_SIZE,
};

test('generated WAV produces deterministic musical feature lanes', async () => {
  const wav = generatedPcm16Wav();
  const first = await analyzeOfflineAudioWav(wav, SETTINGS);
  const second = await analyzeOfflineAudioWav(wav, SETTINGS);

  assert.deepEqual(first, second);
  assert.equal(first.version, OFFLINE_AUDIO_LANES_VERSION);
  assert.deepEqual(Object.keys(first.lanes), [
    'bass', 'mid', 'high', 'level', 'centroid', 'flux', 'onset',
  ]);
  assert.equal(first.settings.sampleRate, SAMPLE_RATE);
  assert.equal(first.settings.windowSize, WINDOW_SIZE);
  assert.equal(first.settings.hopSize, HOP_SIZE);
  assert.equal(first.settings.window, 'hann');
  assert.equal(first.settings.featureContract, 'show-audio-features-v1');
  assert.equal(first.settings.spectrumScale, 'web-audio-byte-frequency');
  assert.equal(first.settings.minDecibels, -100);
  assert.equal(first.settings.maxDecibels, -30);
  assert.equal(first.settings.frameCount, 74);
  assert.ok(Object.values(first.lanes).every(lane => lane.length === 74));
  assert.ok(Object.values(first.lanes).flat().every(value => Number.isFinite(value) && value >= 0 && value <= 1));

  const bassFrame = {
    bass: meanInRange(first, 'bass', 0.28, 0.44),
    mid: meanInRange(first, 'mid', 0.28, 0.44),
    high: meanInRange(first, 'high', 0.28, 0.44),
  };
  const midFrame = {
    bass: meanInRange(first, 'bass', 0.63, 0.79),
    mid: meanInRange(first, 'mid', 0.63, 0.79),
    high: meanInRange(first, 'high', 0.63, 0.79),
  };
  const highFrame = {
    bass: meanInRange(first, 'bass', 0.98, 1.14),
    mid: meanInRange(first, 'mid', 0.98, 1.14),
    high: meanInRange(first, 'high', 0.98, 1.14),
  };
  assert.ok(bassFrame.bass > bassFrame.mid * 4 + 0.1, JSON.stringify(bassFrame));
  assert.ok(midFrame.mid > midFrame.bass * 4 + 0.1, JSON.stringify(midFrame));
  assert.ok(midFrame.mid > midFrame.high * 4 + 0.1, JSON.stringify(midFrame));
  assert.ok(highFrame.high > highFrame.mid * 4 + 0.05, JSON.stringify(highFrame));
  assert.ok(meanInRange(first, 'level', 0.28, 1.14) > 0.2);

  const bassCentroid = meanInRange(first, 'centroid', 0.28, 0.44);
  const midCentroid = meanInRange(first, 'centroid', 0.63, 0.79);
  const highCentroid = meanInRange(first, 'centroid', 0.98, 1.14);
  assert.ok(bassCentroid < midCentroid && midCentroid < highCentroid);
  assert.ok(Math.max(...first.lanes.flux) > 0.08);
  assert.ok(Math.max(...first.lanes.onset) > 0.08);
});

test('result stores only numeric lanes, fingerprint metadata, and analysis settings', async () => {
  const wav = generatedPcm16Wav();
  const result = await analyzeOfflineAudioWav(wav, SETTINGS);
  const blobResult = await analyzeOfflineAudioWav(new Blob([wav], { type: 'audio/wav' }), SETTINGS);

  assert.deepEqual(blobResult, result);
  assert.deepEqual(Object.keys(result), ['version', 'audioFingerprint', 'settings', 'lanes']);
  assert.deepEqual(result.audioFingerprint, {
    algorithm: 'SHA-256',
    sha256: createHash('sha256').update(wav).digest('hex'),
    byteLength: wav.byteLength,
  });
  assert.deepEqual(Object.keys(result.settings), [
    'sampleRate', 'channels', 'durationSeconds', 'windowSize', 'hopSize',
    'frameCount', 'window', 'spectrumScale', 'minDecibels', 'maxDecibels',
    'featureContract',
  ]);
  assert.ok(!/(audioBytes|samples|pcm|base64|dataUrl)/i.test(JSON.stringify(result)));
  assert.doesNotThrow(() => structuredClone(result));
});

test('analysis rejects mismatched geometry and bounded resource overflows', async () => {
  const wav = generatedPcm16Wav();

  await assert.rejects(() => analyzeOfflineAudioWav(wav, { ...SETTINGS, sampleRate: 44_100 }), /sample rate/i);
  await assert.rejects(() => analyzeOfflineAudioWav(wav, { ...SETTINGS, windowSize: 1000 }), /power of two/i);
  await assert.rejects(() => analyzeOfflineAudioWav(wav, { ...SETTINGS, windowSize: 128, hopSize: 64 }), /windowSize.*between/i);
  await assert.rejects(() => analyzeOfflineAudioWav(wav, { ...SETTINGS, windowSize: 65_536 }), /windowSize.*between/i);
  await assert.rejects(() => analyzeOfflineAudioWav(wav, { ...SETTINGS, hopSize: 0 }), /hopSize/i);
  await assert.rejects(() => analyzeOfflineAudioWav(wav, { ...SETTINGS, maxFileBytes: wav.byteLength - 1 }), /file.*limit/i);
  await assert.rejects(() => analyzeOfflineAudioWav(wav, { ...SETTINGS, maxDurationSeconds: 1 }), /duration.*limit/i);
  await assert.rejects(() => analyzeOfflineAudioWav(wav, { ...SETTINGS, maxFrames: 10 }), /frame.*limit/i);
});

test('analysis is cancellable and independent of wall clock and randomness', async () => {
  const wav = generatedPcm16Wav();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => analyzeOfflineAudioWav(wav, { ...SETTINGS, signal: controller.signal }),
    error => error?.name === 'AbortError',
  );

  const activeController = new AbortController();
  const immediateCrypto = {
    subtle: { digest: async () => new Uint8Array(32).buffer },
  };
  const pending = analyzeOfflineAudioWav(wav, {
    ...SETTINGS,
    signal: activeController.signal,
    cryptoImpl: immediateCrypto,
    yieldEveryFrames: 1,
  });
  setTimeout(() => activeController.abort(), 0);
  await assert.rejects(pending, error => error?.name === 'AbortError');

  const random = Math.random;
  const now = Date.now;
  Math.random = () => { throw new Error('Math.random is forbidden'); };
  Date.now = () => { throw new Error('Date.now is forbidden'); };
  try {
    await assert.doesNotReject(() => analyzeOfflineAudioWav(wav, SETTINGS));
  } finally {
    Math.random = random;
    Date.now = now;
  }
});

test('offline audio requirement is immutable, bake-only, and references no audio bytes', async () => {
  const result = await analyzeOfflineAudioWav(generatedPcm16Wav(), SETTINGS);
  const requirement = createOfflineAudioRequirement(result);

  assert.deepEqual(requirement, {
    capability: OFFLINE_AUDIO_CAPABILITY,
    required: true,
    bakeable: true,
    delivery: 'bake-only',
    analysisVersion: OFFLINE_AUDIO_LANES_VERSION,
    audioSha256: result.audioFingerprint.sha256,
  });
  assert.ok(Object.isFrozen(requirement));
  assert.ok(!/(audioBytes|samples|pcm|base64|dataUrl)/i.test(JSON.stringify(requirement)));

  const descriptor = structuredClone(DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR);
  descriptor.features.bakeableCapabilities.push(OFFLINE_AUDIO_CAPABILITY);
  const compatibility = classifyPatternLabCompatibility({
    version: 1,
    id: 'offline-audio-recipe',
    name: 'Offline audio recipe',
    base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
    evolution: { enabled: true, character: 'tidal', durationSeconds: 10, change: 0.3 },
    layers: [],
    targets: [{ kind: 'whole-piece', id: 'all' }],
    requirements: [requirement],
  }, {
    descriptor,
    metrics: {
      pixelCount: 10,
      fps: 20,
      operationsPerFrame: 1000,
      stateBytes: 512,
      framebufferBytes: 30,
      nativeConfigBytes: 400,
      microSdBytes: 10_000,
    },
  });
  assert.equal(compatibility.classification, 'bake-to-card');
});
