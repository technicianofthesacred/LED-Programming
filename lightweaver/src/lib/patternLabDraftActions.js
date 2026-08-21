// Naming, save-as-new, delete and undo for Pattern Lab drafts.
//
// Why this is a separate module rather than more state inside
// PatternLabScreen.jsx: every function here is a pure function of
// (draft, drafts) and the destructive cases — a save that could overwrite
// an earlier version, a delete, a pattern switch that discards a working
// draft — are exactly the ones that need a test that does not have to boot
// a browser to run. See todo/plans/patternlab-rebuild.md §5 "Keep, name,
// undo".
//
// Nothing here changes the persisted recipe SHAPE. `name` and `id` are
// already required fields of a normalized recipe (patternLabRecipe.js), so
// drafts saved before any of this existed load unchanged — a draft is
// "already saved" purely because its id is present in the stored list.

import { normalizePatternLabRecipe } from './patternLabRecipe.js';

export const MAX_DRAFT_NAME_LENGTH = 60;

let fallbackCopyId = 0;

function freshDraftId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return `pattern-lab-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint32Array(4));
    return `pattern-lab-${Array.from(bytes, value => value.toString(16).padStart(8, '0')).join('')}`;
  }
  fallbackCopyId += 1;
  return `pattern-lab-${Date.now().toString(36)}-${fallbackCopyId.toString(36)}`;
}

// The owner types this, so it is the one string in Pattern Lab that is not
// derived from a pattern id. Trim it, cap it, and never let it become empty
// — an unnamed draft in a list of drafts is indistinguishable from every
// other unnamed draft, which is the exact complaint this work exists to fix.
export function sanitizeDraftName(value, fallback = 'Untitled design') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DRAFT_NAME_LENGTH);
  return text || fallback;
}

function splitTrailingNumber(name) {
  const match = /^(.*?)\s+(\d+)$/.exec(name);
  if (!match) return [name, 1];
  return [match[1], Number(match[2])];
}

// "Rainbow Flow" saved twice becomes "Rainbow Flow" and "Rainbow Flow 2",
// not two rows both reading "Rainbow Flow". Every save auto-names after the
// source pattern, so without this the drafts list is unreadable the moment
// an owner tries two ideas on one pattern.
export function uniqueDraftName(name, drafts = [], { exceptId = null } = {}) {
  const wanted = sanitizeDraftName(name);
  const taken = new Set(
    (drafts || [])
      .filter(item => item && item.id !== exceptId)
      .map(item => sanitizeDraftName(item.name).toLowerCase()),
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const [stem, start] = splitTrailingNumber(wanted);
  for (let suffix = Math.max(2, start + 1); suffix < start + 1000; suffix += 1) {
    const candidate = sanitizeDraftName(`${stem} ${suffix}`);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return sanitizeDraftName(`${stem} ${Date.now().toString(36)}`);
}

export function findSavedDraft(draft, drafts = []) {
  if (!draft?.id) return null;
  return (drafts || []).find(item => item?.id === draft.id) || null;
}

// What the save row is allowed to offer, and what it must call the target it
// would replace. `canReplace` is false for a draft that has never been
// saved: there is nothing to overwrite, so "Replace" would be a lie.
export function describeSaveOptions(draft, drafts = []) {
  const saved = findSavedDraft(draft, drafts);
  if (!saved) {
    return { canReplace: false, savedName: null, replaceLabel: null, nameChanged: false };
  }
  const savedName = sanitizeDraftName(saved.name);
  return {
    canReplace: true,
    savedName,
    replaceLabel: `Replace “${savedName}”`,
    nameChanged: sanitizeDraftName(draft.name) !== savedName,
  };
}

// A save-as-new must be a genuinely different record: a fresh id, so the
// stored list keeps BOTH versions, and a name that does not collide with the
// version it was copied from. Reusing the id here is precisely the silent
// destruction this function exists to prevent.
export function createSavedCopy(draft, drafts = [], { id = null } = {}) {
  const normalized = normalizePatternLabRecipe(draft);
  const nextId = id || freshDraftId();
  if (nextId === normalized.id) throw new Error('A saved copy must not reuse the original draft id');
  return normalizePatternLabRecipe({
    ...normalized,
    id: nextId,
    name: uniqueDraftName(normalized.name, drafts, { exceptId: nextId }),
  });
}

// The undo of a delete puts the draft back where it was, not at the top of
// the list. A restore that reorders the library is a second surprise on top
// of the one being undone.
export function restoreDraftAtIndex(drafts = [], draft, index) {
  const normalized = normalizePatternLabRecipe(draft);
  const without = (drafts || []).filter(item => item?.id !== normalized.id);
  const position = Number.isInteger(index) ? Math.min(Math.max(index, 0), without.length) : without.length;
  return [...without.slice(0, position), normalized, ...without.slice(position)];
}
