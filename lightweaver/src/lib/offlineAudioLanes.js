import { createShowAudioFeatures } from './showAudioFeatures.js';

export const OFFLINE_AUDIO_LANES_VERSION = 1;
export const OFFLINE_AUDIO_CAPABILITY = 'offline-analysis';

export const DEFAULT_OFFLINE_AUDIO_LIMITS = Object.freeze({
  maxFileBytes: 192 * 1024 * 1024,
  maxDurationSeconds: 15 * 60,
  maxFrames: 60_000,
});

const DEFAULT_WINDOW_SIZE = 2048;
const DEFAULT_HOP_SIZE = 1024;
const DEFAULT_YIELD_EVERY_FRAMES = 64;
const MIN_WINDOW_SIZE = 256;
const MAX_WINDOW_SIZE = 32_768;
const FEATURE_CONTRACT = 'show-audio-features-v1';
const WINDOW_NAME = 'hann';
const WEB_AUDIO_MIN_DECIBELS = -100;
const WEB_AUDIO_MAX_DECIBELS = -30;

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Offline audio analysis was canceled', 'AbortError');
  const error = new Error('Offline audio analysis was canceled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason?.name === 'AbortError' ? signal.reason : abortError();
}

function yieldToHost() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new RangeError(`${name} must be a positive integer`);
  return number;
}

function positiveFinite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return number;
}

function powerOfTwo(value) {
  return value > 1 && (value & (value - 1)) === 0;
}

function ascii(bytes, offset, length) {
  let value = '';
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index]);
  return value;
}

async function readSourceBytes(source, maxFileBytes, signal) {
  throwIfAborted(signal);
  let bytes;
  if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else if (ArrayBuffer.isView(source)) {
    bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  } else if (source && typeof source.arrayBuffer === 'function') {
    if (Number.isFinite(source.size) && source.size > maxFileBytes) {
      throw new RangeError(`Audio file exceeds the ${maxFileBytes}-byte file limit`);
    }
    bytes = new Uint8Array(await source.arrayBuffer());
  } else {
    throw new TypeError('Offline audio analysis requires WAV bytes or a Blob/File');
  }
  throwIfAborted(signal);
  if (bytes.byteLength > maxFileBytes) {
    throw new RangeError(`Audio file exceeds the ${maxFileBytes}-byte file limit`);
  }
  return bytes;
}

function parseWav(bytes) {
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new TypeError('Offline audio input must be a RIFF/WAVE file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkBytes = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + chunkBytes;
    if (payloadEnd > bytes.byteLength) throw new TypeError(`WAV chunk ${chunkId} exceeds the file bounds`);

    if (chunkId === 'fmt ') {
      if (chunkBytes < 16) throw new TypeError('WAV fmt chunk is incomplete');
      format = {
        audioFormat: view.getUint16(payloadOffset, true),
        channels: view.getUint16(payloadOffset + 2, true),
        sampleRate: view.getUint32(payloadOffset + 4, true),
        blockAlign: view.getUint16(payloadOffset + 12, true),
        bitsPerSample: view.getUint16(payloadOffset + 14, true),
      };
    } else if (chunkId === 'data' && dataOffset < 0) {
      dataOffset = payloadOffset;
      dataBytes = chunkBytes;
    }
    offset = payloadEnd + (chunkBytes % 2);
  }

  if (!format || dataOffset < 0) throw new TypeError('WAV requires fmt and data chunks');
  const { audioFormat, channels, sampleRate, blockAlign, bitsPerSample } = format;
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new RangeError('WAV channel count must be between 1 and 8');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('WAV sample rate must be between 8000 and 192000 Hz');
  }
  const pcmBits = audioFormat === 1 && [8, 16, 24, 32].includes(bitsPerSample);
  const floatBits = audioFormat === 3 && bitsPerSample === 32;
  if (!pcmBits && !floatBits) {
    throw new RangeError('WAV must use PCM 8/16/24/32-bit or IEEE float32 samples');
  }
  const bytesPerSample = bitsPerSample / 8;
  if (blockAlign !== channels * bytesPerSample) throw new TypeError('WAV block alignment is inconsistent');
  const sampleFrames = Math.floor(dataBytes / blockAlign);
  if (sampleFrames < 1) throw new RangeError('WAV contains no audio sample frames');

  function channelSample(byteOffset) {
    if (audioFormat === 3) {
      const value = view.getFloat32(byteOffset, true);
      return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
    if (bitsPerSample === 8) return (view.getUint8(byteOffset) - 128) / 128;
    if (bitsPerSample === 16) return view.getInt16(byteOffset, true) / 32768;
    if (bitsPerSample === 24) {
      let value = view.getUint8(byteOffset)
        | (view.getUint8(byteOffset + 1) << 8)
        | (view.getUint8(byteOffset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8388608;
    }
    return view.getInt32(byteOffset, true) / 2147483648;
  }

  function readMonoSample(frameIndex) {
    if (frameIndex < 0 || frameIndex >= sampleFrames) return 0;
    const frameOffset = dataOffset + frameIndex * blockAlign;
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += channelSample(frameOffset + channel * bytesPerSample);
    }
    return sum / channels;
  }

  return { channels, sampleRate, sampleFrames, readMonoSample };
}

function createHannWindow(size) {
  const window = new Float64Array(size);
  let sum = 0;
  for (let index = 0; index < size; index += 1) {
    const value = 0.5 - 0.5 * Math.cos((Math.PI * 2 * index) / (size - 1));
    window[index] = value;
    sum += value;
  }
  return { window, sum };
}

function fftInPlace(real, imaginary) {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let length = 2; length <= size; length *= 2) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let weightReal = 1;
      let weightImaginary = 0;
      const half = length / 2;
      for (let index = 0; index < half; index += 1) {
        const even = start + index;
        const odd = even + half;
        const oddReal = real[odd] * weightReal - imaginary[odd] * weightImaginary;
        const oddImaginary = real[odd] * weightImaginary + imaginary[odd] * weightReal;
        const evenReal = real[even];
        const evenImaginary = imaginary[even];
        real[even] = evenReal + oddReal;
        imaginary[even] = evenImaginary + oddImaginary;
        real[odd] = evenReal - oddReal;
        imaginary[odd] = evenImaginary - oddImaginary;
        const nextWeightReal = weightReal * stepReal - weightImaginary * stepImaginary;
        weightImaginary = weightReal * stepImaginary + weightImaginary * stepReal;
        weightReal = nextWeightReal;
      }
    }
  }
}

function spectrumForFrame(readMonoSample, frameOffset, window, windowSum, real, imaginary, bins) {
  for (let index = 0; index < window.length; index += 1) {
    real[index] = readMonoSample(frameOffset + index) * window[index];
    imaginary[index] = 0;
  }
  fftInPlace(real, imaginary);
  for (let bin = 0; bin < bins.length; bin += 1) {
    const amplitude = Math.min(1, 2 * Math.hypot(real[bin], imaginary[bin]) / windowSum);
    const decibels = 20 * Math.log10(Math.max(amplitude, 1e-12));
    const normalized = Math.min(1, Math.max(0,
      (decibels - WEB_AUDIO_MIN_DECIBELS)
      / (WEB_AUDIO_MAX_DECIBELS - WEB_AUDIO_MIN_DECIBELS),
    ));
    bins[bin] = Math.round(normalized * 255);
  }
}

async function sha256(bytes, cryptoImpl, signal) {
  if (!cryptoImpl?.subtle?.digest) throw new Error('Secure SHA-256 fingerprinting is unavailable');
  throwIfAborted(signal);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  throwIfAborted(signal);
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function analyzeOfflineAudioWav(source, options = {}) {
  const windowSize = positiveInteger(options.windowSize ?? DEFAULT_WINDOW_SIZE, 'windowSize');
  if (!powerOfTwo(windowSize)) throw new RangeError('windowSize must be a power of two');
  if (windowSize < MIN_WINDOW_SIZE || windowSize > MAX_WINDOW_SIZE) {
    throw new RangeError(`windowSize must be between ${MIN_WINDOW_SIZE} and ${MAX_WINDOW_SIZE}`);
  }
  const hopSize = positiveInteger(options.hopSize ?? DEFAULT_HOP_SIZE, 'hopSize');
  if (hopSize > windowSize) throw new RangeError('hopSize must not exceed windowSize');
  const maxFileBytes = positiveInteger(
    options.maxFileBytes ?? DEFAULT_OFFLINE_AUDIO_LIMITS.maxFileBytes,
    'maxFileBytes',
  );
  const maxDurationSeconds = positiveFinite(
    options.maxDurationSeconds ?? DEFAULT_OFFLINE_AUDIO_LIMITS.maxDurationSeconds,
    'maxDurationSeconds',
  );
  const maxFrames = positiveInteger(
    options.maxFrames ?? DEFAULT_OFFLINE_AUDIO_LIMITS.maxFrames,
    'maxFrames',
  );
  const yieldEveryFrames = positiveInteger(
    options.yieldEveryFrames ?? DEFAULT_YIELD_EVERY_FRAMES,
    'yieldEveryFrames',
  );
  const bytes = await readSourceBytes(source, maxFileBytes, options.signal);
  const wav = parseWav(bytes);
  if (options.sampleRate !== undefined) {
    const expectedSampleRate = positiveInteger(options.sampleRate, 'sampleRate');
    if (expectedSampleRate !== wav.sampleRate) {
      throw new RangeError(`WAV sample rate ${wav.sampleRate} does not match analysis sample rate ${expectedSampleRate}`);
    }
  }

  const durationSeconds = wav.sampleFrames / wav.sampleRate;
  if (durationSeconds > maxDurationSeconds) {
    throw new RangeError(`Audio duration ${durationSeconds} seconds exceeds the ${maxDurationSeconds}-second duration limit`);
  }
  const frameCount = Math.max(1, 1 + Math.ceil((wav.sampleFrames - windowSize) / hopSize));
  if (frameCount > maxFrames) {
    throw new RangeError(`Audio frame count ${frameCount} exceeds the ${maxFrames}-frame limit`);
  }

  const fingerprint = await sha256(bytes, options.cryptoImpl ?? globalThis.crypto, options.signal);
  const analyzer = createShowAudioFeatures({ sampleRate: wav.sampleRate, fftSize: windowSize });
  const { window, sum: windowSum } = createHannWindow(windowSize);
  const real = new Float64Array(windowSize);
  const imaginary = new Float64Array(windowSize);
  const bins = new Uint8Array(windowSize / 2);
  const lanes = {
    bass: [],
    mid: [],
    high: [],
    level: [],
    centroid: [],
    flux: [],
    onset: [],
  };
  const frameDt = hopSize / wav.sampleRate;

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (frame % yieldEveryFrames === 0) {
      throwIfAborted(options.signal);
      if (frame > 0) {
        await yieldToHost();
        throwIfAborted(options.signal);
      }
    }
    spectrumForFrame(
      wav.readMonoSample,
      frame * hopSize,
      window,
      windowSum,
      real,
      imaginary,
      bins,
    );
    const features = analyzer.updateBins(bins, frameDt);
    lanes.bass.push(features.bass);
    lanes.mid.push(features.mid);
    lanes.high.push(features.high);
    lanes.level.push(features.energy);
    lanes.centroid.push(features.centroid);
    lanes.flux.push(features.flux);
    lanes.onset.push(features.beat);
  }
  throwIfAborted(options.signal);

  return {
    version: OFFLINE_AUDIO_LANES_VERSION,
    audioFingerprint: {
      algorithm: 'SHA-256',
      sha256: fingerprint,
      byteLength: bytes.byteLength,
    },
    settings: {
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      durationSeconds,
      windowSize,
      hopSize,
      frameCount,
      window: WINDOW_NAME,
      spectrumScale: 'web-audio-byte-frequency',
      minDecibels: WEB_AUDIO_MIN_DECIBELS,
      maxDecibels: WEB_AUDIO_MAX_DECIBELS,
      featureContract: FEATURE_CONTRACT,
    },
    lanes,
  };
}

export function createOfflineAudioRequirement(analysis) {
  const sha = analysis?.audioFingerprint?.sha256;
  if (analysis?.version !== OFFLINE_AUDIO_LANES_VERSION || !/^[a-f0-9]{64}$/.test(String(sha || ''))) {
    throw new TypeError('Offline audio requirement needs a valid analyzed audio fingerprint');
  }
  return Object.freeze({
    capability: OFFLINE_AUDIO_CAPABILITY,
    required: true,
    bakeable: true,
    delivery: 'bake-only',
    analysisVersion: OFFLINE_AUDIO_LANES_VERSION,
    audioSha256: sha,
  });
}
