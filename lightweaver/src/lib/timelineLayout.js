export const MIN_TIMELINE_CLIP_DURATION = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clipDuration(clip) {
  return Math.max(0, (clip?.end ?? 0) - (clip?.start ?? 0));
}

function sameTrackClips(clips, clip) {
  const track = clip.track ?? 0;
  return clips
    .filter(c => c.id !== clip.id && (c.track ?? 0) === track)
    .sort((a, b) => a.start - b.start);
}

export function getClipNeighborBounds(clips, clip, showDuration) {
  const sameTrack = sameTrackClips(clips, clip);
  const previous = sameTrack.filter(c => c.start < clip.start).at(-1);
  const next = sameTrack.find(c => c.start > clip.start);
  const previousOverlap = previous ? Math.max(0, previous.end - clip.start) : 0;
  const nextOverlap = next ? Math.max(0, clip.end - next.start) : 0;
  const previousEnd = previous ? previous.end - previousOverlap : 0;
  const nextStart = next ? next.start + nextOverlap : showDuration;

  return {
    previousEnd: clamp(previousEnd, 0, showDuration),
    nextStart: clamp(nextStart, 0, showDuration),
  };
}

export function clampClipMove(clips, clipId, requestedStart, showDuration) {
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return null;

  const duration = clipDuration(clip);
  const { previousEnd, nextStart } = getClipNeighborBounds(clips, clip, showDuration);
  const available = nextStart - previousEnd;
  if (available < duration) {
    const start = clamp(clip.start, 0, Math.max(0, showDuration - duration));
    return { start, end: start + duration };
  }

  const minStart = previousEnd;
  const maxStart = Math.min(showDuration - duration, nextStart - duration);
  const start = clamp(requestedStart, minStart, Math.max(minStart, maxStart));
  return { start, end: start + duration };
}

export function clampClipResize(clips, clipId, edge, requestedValue, showDuration, minDuration = MIN_TIMELINE_CLIP_DURATION) {
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return null;

  const { previousEnd, nextStart } = getClipNeighborBounds(clips, clip, showDuration);
  if (edge === 'start') {
    const start = clamp(requestedValue, previousEnd, clip.end - minDuration);
    return { start, end: clip.end };
  }

  const end = clamp(requestedValue, clip.start + minDuration, nextStart);
  return { start: clip.start, end };
}

export function placeClipInTrackGap(clips, { track = 0, preferredStart = 0, duration = 10, showDuration, minDuration = MIN_TIMELINE_CLIP_DURATION }) {
  const desiredDuration = Math.max(minDuration, duration);
  const startTime = clamp(preferredStart, 0, Math.max(0, showDuration - minDuration));
  const trackClips = clips
    .filter(c => (c.track ?? 0) === track)
    .sort((a, b) => a.start - b.start);

  const gaps = [];
  let cursor = 0;
  for (const clip of trackClips) {
    if (clip.start > cursor) gaps.push({ start: cursor, end: clip.start });
    cursor = Math.max(cursor, clip.end);
  }
  if (cursor < showDuration) gaps.push({ start: cursor, end: showDuration });

  const usableGaps = gaps.filter(gap => gap.end - gap.start >= minDuration);
  if (usableGaps.length === 0) return null;

  const remainingInGap = (gap) => gap.end - clamp(startTime, gap.start, gap.end - minDuration);
  const fullFitGaps = usableGaps.filter(gap => remainingInGap(gap) >= desiredDuration);
  const candidates = fullFitGaps.length > 0
    ? fullFitGaps
    : [...usableGaps].sort((a, b) => remainingInGap(b) - remainingInGap(a));
  const containing = candidates.find(gap => startTime >= gap.start && startTime < gap.end);
  const after = candidates.find(gap => gap.start >= startTime);
  const gap = containing || after || candidates[candidates.length - 1];
  const start = clamp(startTime, gap.start, gap.end - minDuration);
  const end = Math.min(gap.end, start + desiredDuration);

  return { start, end };
}
