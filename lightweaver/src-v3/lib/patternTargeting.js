export function stripOverrideIdsToClearForGlobalSelection(strips = []) {
  if (!Array.isArray(strips) || strips.length !== 1) return [];
  const [strip] = strips;
  return strip?.id && strip.patternId ? [strip.id] : [];
}
