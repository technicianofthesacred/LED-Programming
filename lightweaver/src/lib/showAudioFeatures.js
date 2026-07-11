const FEATURE_RANGES = {
  bass: [30, 140],
  mid: [150, 1800],
  high: [2000, 9000],
};

const MIN_FREQUENCY = 20;
const MAX_FREQUENCY = 10000;
const INITIAL_HEADROOM = 0.65;

function clamp01(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function smoothingFactor(dt, timeConstant) {
  return 1 - Math.exp(-Math.max(0, dt) / timeConstant);
}

export function createShowAudioFeatures({ sampleRate = 44100, fftSize = 2048 } = {}) {
  const configuredBinCount = Math.max(1, Math.floor(fftSize / 2));
  const binHz = sampleRate / fftSize;
  let analyserBuffer = new Uint8Array(configuredBinCount);
  let previousBins = new Float32Array(configuredBinCount);
  let hasPreviousFrame = false;
  let floor = 0;
  let headroom = INITIAL_HEADROOM;
  let features;

  function clearFeatures() {
    features = {
      bass: 0,
      mid: 0,
      high: 0,
      energy: 0,
      centroid: 0,
      flux: 0,
      beat: 0,
    };
  }

  function rmsInRange(bins, lowHz, highHz) {
    const first = Math.max(0, Math.ceil(lowHz / binHz));
    const last = Math.min(bins.length - 1, Math.floor(highHz / binHz));
    if (last < first) return 0;

    let sumSquares = 0;
    for (let i = first; i <= last; i += 1) {
      const magnitude = bins[i] / 255;
      sumSquares += magnitude * magnitude;
    }
    return Math.sqrt(sumSquares / (last - first + 1));
  }

  function normalizeLevel(raw) {
    return clamp01((raw - floor) / Math.max(0.18, headroom - floor));
  }

  function updateBins(bins, dt = 1 / 60) {
    const frameDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 1 / 60;
    const usableBins = Math.min(bins?.length ?? 0, configuredBinCount);
    if (usableBins === 0) {
      features.beat *= Math.exp(-frameDt / 0.23);
      features.flux *= Math.exp(-frameDt / 0.09);
      return getFeatures();
    }

    const rawBass = rmsInRange(bins, ...FEATURE_RANGES.bass);
    const rawMid = rmsInRange(bins, ...FEATURE_RANGES.mid);
    const rawHigh = rmsInRange(bins, ...FEATURE_RANGES.high);
    const rawEnergy = rmsInRange(bins, MIN_FREQUENCY, MAX_FREQUENCY);

    // The floor rises only very slowly and remains a small fraction of a sustained
    // passage. Headroom releases on a similarly long horizon, so normalization
    // remains useful without gradually flattening steady music to zero.
    const floorTarget = Math.min(rawEnergy * 0.12, 0.08);
    const floorTau = floorTarget > floor ? 20 * 60 : 1.5;
    floor += (floorTarget - floor) * smoothingFactor(frameDt, floorTau);

    const desiredHeadroom = Math.max(0.45, rawEnergy * 1.35);
    const headroomTau = desiredHeadroom > headroom ? 0.35 : 15 * 60;
    headroom += (desiredHeadroom - headroom) * smoothingFactor(frameDt, headroomTau);

    let weightedFrequency = 0;
    let magnitudeSum = 0;
    let positiveDeltaSquares = 0;
    let fluxBins = 0;
    const first = Math.max(0, Math.ceil(MIN_FREQUENCY / binHz));
    const last = Math.min(usableBins - 1, Math.floor(MAX_FREQUENCY / binHz));
    for (let i = first; i <= last; i += 1) {
      const magnitude = bins[i] / 255;
      const frequency = i * binHz;
      magnitudeSum += magnitude;
      weightedFrequency += magnitude * frequency;

      if (hasPreviousFrame) {
        const delta = Math.max(0, magnitude - previousBins[i]);
        positiveDeltaSquares += delta * delta;
        fluxBins += 1;
      }
      previousBins[i] = magnitude;
    }
    hasPreviousFrame = true;

    const rawFlux = fluxBins > 0 ? Math.sqrt(positiveDeltaSquares / fluxBins) : 0;
    const fluxTarget = clamp01(rawFlux * 1.8);
    const fluxTau = fluxTarget > features.flux ? 0.018 : 0.09;
    features.flux += (fluxTarget - features.flux) * smoothingFactor(frameDt, fluxTau);

    const releasedBeat = features.beat * Math.exp(-frameDt / 0.23);
    const onset = rawFlux > 0.075 ? clamp01((rawFlux - 0.075) / 0.35) : 0;
    features.beat = Math.max(releasedBeat, onset);
    features.bass = normalizeLevel(rawBass);
    features.mid = normalizeLevel(rawMid);
    features.high = normalizeLevel(rawHigh);
    features.energy = normalizeLevel(rawEnergy);
    features.centroid = magnitudeSum > 0
      ? clamp01(((weightedFrequency / magnitudeSum) - MIN_FREQUENCY)
        / (MAX_FREQUENCY - MIN_FREQUENCY))
      : 0;

    return getFeatures();
  }

  function updateAnalyser(analyser, dt = 1 / 60) {
    const requiredLength = analyser?.frequencyBinCount ?? configuredBinCount;
    if (analyserBuffer.length !== requiredLength) {
      analyserBuffer = new Uint8Array(requiredLength);
    }
    analyser.getByteFrequencyData(analyserBuffer);
    return updateBins(analyserBuffer, dt);
  }

  function reset() {
    previousBins.fill(0);
    hasPreviousFrame = false;
    floor = 0;
    headroom = INITIAL_HEADROOM;
    clearFeatures();
  }

  function getFeatures() {
    return { ...features };
  }

  clearFeatures();
  return { updateBins, updateAnalyser, reset, getFeatures };
}
