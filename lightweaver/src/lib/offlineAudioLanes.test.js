import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  DEFAULT_OFFLINE_AUDIO_LIMITS,
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

function wavChunk(id, payload, { pad = true } = {}) {
  const padding = pad && payload.byteLength % 2 ? 1 : 0;
  const bytes = new Uint8Array(8 + payload.byteLength + padding);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, id);
  view.setUint32(4, payload.byteLength, true);
  bytes.set(payload, 8);
  return bytes;
}

function formatChunk({ audioFormat = 1, channels = 1, sampleRate = 8000, bitsPerSample = 16 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setUint16(0, audioFormat, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * channels * bytesPerSample, true);
  view.setUint16(12, channels * bytesPerSample, true);
  view.setUint16(14, bitsPerSample, true);
  return wavChunk('fmt ', payload);
}

function encodeSamples({ audioFormat = 1, channels = 1, bitsPerSample = 16, frames = 320 }) {
  const bytesPerSample = bitsPerSample / 8;
  const payload = new Uint8Array(frames * channels * bytesPerSample);
  const view = new DataView(payload.buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.sin((frame / 8000) * Math.PI * 2 * (125 + channel * 125)) * 0.5;
      const offset = (frame * channels + channel) * bytesPerSample;
      if (audioFormat === 3) view.setFloat32(offset, sample, true);
      else if (bitsPerSample === 8) view.setUint8(offset, Math.round(sample * 127 + 128));
      else if (bitsPerSample === 16) view.setInt16(offset, Math.round(sample * 32767), true);
      else if (bitsPerSample === 24) {
        const value = Math.round(sample * 8388607);
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
      } else view.setInt32(offset, Math.round(sample * 2147483647), true);
    }
  }
  return payload;
}

function riffWav(chunks, { trailingBytes = 0, riffSize } = {}) {
  const contentBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(12 + contentBytes + trailingBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, riffSize ?? 4 + contentBytes, true);
  writeAscii(view, 8, 'WAVE');
  let offset = 12;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (trailingBytes) bytes.fill(0xa5, offset);
  return bytes;
}

function generatedFormatWav({
  audioFormat = 1,
  channels = 1,
  bitsPerSample = 16,
  dataFirst = false,
} = {}) {
  const fmt = formatChunk({ audioFormat, channels, bitsPerSample });
  const data = wavChunk('data', encodeSamples({ audioFormat, channels, bitsPerSample }));
  return riffWav(dataFirst ? [data, fmt] : [fmt, data]);
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

function nodeDigest(bytes) {
  return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
}

async function abortOutcomeBefore(operation, release, timeoutMs = 50) {
  const timeout = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), timeoutMs));
  const outcome = await Promise.race([
    operation.then(
      value => ({ value }),
      error => ({ error }),
    ),
    timeout,
  ]);
  if (outcome.timeout) release();
  return outcome;
}

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
  assert.equal(first.settings.frameTimeOrigin, 'window-center');
  assert.equal(first.settings.frameTimeOffsetSeconds, WINDOW_SIZE / (2 * SAMPLE_RATE));
  assert.equal(first.settings.analysisWorkUnits, 74 * WINDOW_SIZE * Math.log2(WINDOW_SIZE));
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
    'frameCount', 'frameTimeOrigin', 'frameTimeOffsetSeconds', 'analysisWorkUnits',
    'window', 'spectrumScale', 'minDecibels', 'maxDecibels', 'featureContract',
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

test('total FFT work is bounded before hashing or allocating transform buffers', async () => {
  const wav = generatedPcm16Wav();
  const exactWorkUnits = 74 * WINDOW_SIZE * Math.log2(WINDOW_SIZE);
  await assert.doesNotReject(() => analyzeOfflineAudioWav(wav, {
    ...SETTINGS,
    maxWorkUnits: exactWorkUnits,
  }));
  await assert.rejects(
    () => analyzeOfflineAudioWav(wav, { ...SETTINGS, maxWorkUnits: exactWorkUnits - 1 }),
    /work unit.*limit/i,
  );

  let digestCalls = 0;
  await assert.rejects(
    () => analyzeOfflineAudioWav(wav, {
      windowSize: 32_768,
      hopSize: 1,
      maxFrames: 10_000,
      cryptoImpl: {
        subtle: {
          digest: async () => {
            digestCalls += 1;
            return new Uint8Array(32).buffer;
          },
        },
      },
    }),
    /work unit.*limit/i,
  );
  assert.equal(digestCalls, 0);
  assert.ok(DEFAULT_OFFLINE_AUDIO_LIMITS.maxWorkUnits <= 1_000_000_000);
  assert.ok(DEFAULT_OFFLINE_AUDIO_LIMITS.maxFrames < 60_000);
});

test('RIFF declared bounds control chunk parsing while bytes after the RIFF are ignored', async () => {
  const valid = generatedFormatWav();
  const tooShort = valid.slice();
  new DataView(tooShort.buffer).setUint32(4, 20, true);
  await assert.rejects(
    () => analyzeOfflineAudioWav(tooShort, { windowSize: 256, hopSize: 128 }),
    /RIFF.*bounds|chunk.*RIFF/i,
  );

  const tooLong = valid.slice();
  new DataView(tooLong.buffer).setUint32(4, valid.byteLength, true);
  await assert.rejects(
    () => analyzeOfflineAudioWav(tooLong, { windowSize: 256, hopSize: 128 }),
    /RIFF.*file/i,
  );

  const withTrailingBytes = riffWav([
    formatChunk(),
    wavChunk('data', encodeSamples({})),
  ], { trailingBytes: 9 });
  await assert.doesNotReject(
    () => analyzeOfflineAudioWav(withTrailingBytes, { windowSize: 256, hopSize: 128 }),
  );
});

test('RIFF rejects duplicate critical chunks and incomplete terminal headers', async () => {
  const fmt = formatChunk();
  const data = wavChunk('data', encodeSamples({}));
  await assert.rejects(
    () => analyzeOfflineAudioWav(riffWav([fmt, fmt, data]), { windowSize: 256, hopSize: 128 }),
    /duplicate.*fmt/i,
  );
  await assert.rejects(
    () => analyzeOfflineAudioWav(riffWav([fmt, data, data]), { windowSize: 256, hopSize: 128 }),
    /duplicate.*data/i,
  );
  await assert.rejects(
    () => analyzeOfflineAudioWav(riffWav([fmt, data, new Uint8Array([1, 2, 3, 4])]), {
      windowSize: 256,
      hopSize: 128,
    }),
    /chunk header/i,
  );
});

test('RIFF rejects partial sample frames and missing odd-chunk padding', async () => {
  const partialStereo = riffWav([
    formatChunk({ channels: 2, bitsPerSample: 16 }),
    wavChunk('data', new Uint8Array(7)),
  ]);
  await assert.rejects(
    () => analyzeOfflineAudioWav(partialStereo, { windowSize: 256, hopSize: 128 }),
    /data.*block alignment|partial.*frame/i,
  );

  const missingPad = riffWav([
    formatChunk({ bitsPerSample: 8 }),
    wavChunk('data', new Uint8Array([128]), { pad: false }),
  ]);
  await assert.rejects(
    () => analyzeOfflineAudioWav(missingPad, { windowSize: 256, hopSize: 128 }),
    /padding/i,
  );
});

test('reordered PCM widths, float32, and multichannel WAV fixtures remain supported', async () => {
  const formats = [
    { audioFormat: 1, bitsPerSample: 8, channels: 1, dataFirst: true },
    { audioFormat: 1, bitsPerSample: 16, channels: 2 },
    { audioFormat: 1, bitsPerSample: 24, channels: 3 },
    { audioFormat: 1, bitsPerSample: 32, channels: 4 },
    { audioFormat: 3, bitsPerSample: 32, channels: 6, dataFirst: true },
  ];
  for (const fixture of formats) {
    const result = await analyzeOfflineAudioWav(generatedFormatWav(fixture), {
      windowSize: 256,
      hopSize: 128,
    });
    assert.equal(result.settings.channels, fixture.channels, JSON.stringify(fixture));
    assert.ok(result.lanes.level.some(value => value > 0), JSON.stringify(fixture));
  }

  await assert.rejects(
    () => analyzeOfflineAudioWav(riffWav([
      formatChunk({ bitsPerSample: 12 }),
      wavChunk('data', new Uint8Array(320)),
    ]), {
      windowSize: 256,
      hopSize: 128,
    }),
    /PCM 8\/16\/24\/32-bit/i,
  );
  await assert.rejects(
    () => analyzeOfflineAudioWav(riffWav([
      formatChunk({ audioFormat: 3, bitsPerSample: 16 }),
      wavChunk('data', new Uint8Array(320)),
    ]), {
      windowSize: 256,
      hopSize: 128,
    }),
    /float32/i,
  );
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

test('analysis snapshots caller-owned bytes before hashing or yielding', async () => {
  const original = generatedPcm16Wav();
  const mutable = original.slice();
  const expected = await analyzeOfflineAudioWav(original, SETTINGS);
  const pending = analyzeOfflineAudioWav(mutable, {
    ...SETTINGS,
    yieldEveryFrames: 1,
    cryptoImpl: { subtle: { digest: async (_algorithm, bytes) => nodeDigest(bytes) } },
  });
  setTimeout(() => mutable.fill(0, 44), 0);

  assert.deepEqual(await pending, expected);
});

test('analysis validates injected SHA-256 digest length', async () => {
  await assert.rejects(
    () => analyzeOfflineAudioWav(generatedPcm16Wav(), {
      ...SETTINGS,
      cryptoImpl: { subtle: { digest: async () => new Uint8Array(31).buffer } },
    }),
    /32 bytes/i,
  );
});

test('analysis checks cancellation before every FFT frame', async () => {
  let abortChecks = 0;
  const signal = {
    get aborted() {
      abortChecks += 1;
      return abortChecks >= 10;
    },
    get reason() { return undefined; },
    addEventListener() {},
    removeEventListener() {},
  };
  let spectrumBinsVisited = 0;
  const originalHypot = Math.hypot;
  Math.hypot = (...values) => {
    spectrumBinsVisited += 1;
    return originalHypot(...values);
  };
  try {
    await assert.rejects(
      () => analyzeOfflineAudioWav(generatedPcm16Wav(), {
        ...SETTINGS,
        signal,
        yieldEveryFrames: 10_000,
        cryptoImpl: { subtle: { digest: async () => new Uint8Array(32).buffer } },
      }),
      error => error?.name === 'AbortError',
    );
  } finally {
    Math.hypot = originalHypot;
  }
  assert.ok(spectrumBinsVisited < (WINDOW_SIZE / 2) * 10, `visited ${spectrumBinsVisited} bins`);
});

test('abort rejects promptly while Blob-style reads and digests remain pending', async () => {
  let releaseRead;
  const readController = new AbortController();
  const readPending = analyzeOfflineAudioWav({
    size: 44,
    arrayBuffer: () => new Promise(resolve => { releaseRead = () => resolve(new ArrayBuffer(44)); }),
  }, { ...SETTINGS, signal: readController.signal });
  await Promise.resolve();
  readController.abort();
  const readOutcome = await abortOutcomeBefore(readPending, () => releaseRead?.());
  assert.equal(readOutcome.timeout, undefined, 'abort must not wait for Blob.arrayBuffer() to settle');
  assert.equal(readOutcome.error?.name, 'AbortError');

  let releaseDigest;
  const digestController = new AbortController();
  const digestPending = analyzeOfflineAudioWav(generatedPcm16Wav(), {
    ...SETTINGS,
    signal: digestController.signal,
    cryptoImpl: {
      subtle: {
        digest: () => new Promise(resolve => {
          releaseDigest = () => resolve(new Uint8Array(32).buffer);
        }),
      },
    },
  });
  await Promise.resolve();
  digestController.abort();
  const digestOutcome = await abortOutcomeBefore(digestPending, () => releaseDigest?.());
  assert.equal(digestOutcome.timeout, undefined, 'abort must not wait for subtle.digest() to settle');
  assert.equal(digestOutcome.error?.name, 'AbortError');
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
  assert.throws(
    () => createOfflineAudioRequirement({
      ...result,
      audioFingerprint: { ...result.audioFingerprint, algorithm: 'SHA-1' },
    }),
    /SHA-256/i,
  );

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
