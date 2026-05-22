const MIN_RECORDED_CLIP_DURATION = 0.25;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function quantizeTime(time, quantize = 'free', bpm = 120) {
  if (quantize === 'beat') {
    const beat = 60 / Math.max(1, bpm);
    return Math.round(time / beat) * beat;
  }
  if (quantize === 'bar') {
    const bar = (60 / Math.max(1, bpm)) * 4;
    return Math.round(time / bar) * bar;
  }
  return time;
}

function findPreviousRecordedClip(clips, at) {
  return [...clips]
    .filter(c => c.recorded && (c.track ?? 0) === 0 && c.start <= at)
    .sort((a, b) => b.start - a.start)[0] || null;
}

export function recordLivePattern({
  clips = [],
  transitions = [],
  patternId,
  at,
  bpm = 120,
  quantize = 'free',
  crossfadeSecs = 3,
  showDuration = 600,
  idPrefix = 'live',
}) {
  if (!patternId) return { clips, transitions };

  const start = clamp(quantizeTime(at, quantize, bpm), 0, showDuration - MIN_RECORDED_CLIP_DURATION);
  const fade = clamp(crossfadeSecs || 0, 0, Math.max(0, showDuration - start));
  const transitionEnd = clamp(start + fade, start + MIN_RECORDED_CLIP_DURATION, showDuration);
  const prevClip = findPreviousRecordedClip(clips, start);
  const samePattern = prevClip?.patternId === patternId && prevClip.end >= start;
  if (samePattern) return { clips, transitions };

  const stamp = `${idPrefix}_${Math.round(start * 1000)}_${patternId}`;
  const nextClip = {
    id: stamp,
    track: 0,
    patternId,
    start,
    end: showDuration,
    label: patternId,
    recorded: true,
  };

  let nextClips = clips
    .filter(c => !(c.recorded && (c.track ?? 0) === 0 && c.start >= start && c.id !== prevClip?.id))
    .map(c => {
      if (!prevClip || c.id !== prevClip.id) return c;
      return { ...c, end: Math.max(c.start + MIN_RECORDED_CLIP_DURATION, transitionEnd) };
    });

  nextClips = [...nextClips, nextClip].sort((a, b) => (a.track ?? 0) - (b.track ?? 0) || a.start - b.start);

  let nextTransitions = transitions.filter(t => !(t.recorded && t.start >= start));
  if (prevClip && prevClip.patternId !== patternId && fade > 0) {
    nextTransitions = [
      ...nextTransitions,
      {
        id: `${stamp}_xfade`,
        clipA: prevClip.id,
        clipB: nextClip.id,
        type: 'crossfade',
        curve: 'ease-in-out',
        start,
        end: transitionEnd,
        recorded: true,
      },
    ].sort((a, b) => a.start - b.start);
  }

  return { clips: nextClips, transitions: nextTransitions };
}
