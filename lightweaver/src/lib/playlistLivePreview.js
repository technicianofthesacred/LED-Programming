import { normalizeCardVisualLook } from './cardVisualLook.js';
import {
  applySavedLookToPatchBoard,
  deriveSectionTargets,
} from './sectionLookModel.js';

export function buildPatternPlaylistPreview(patternId) {
  return {
    ...normalizeCardVisualLook({ patternId }),
    syncZones: true,
  };
}

export function buildSavedLookPlaylistPreviewTargets({
  savedLook = {},
  strips = [],
  patchBoard = null,
} = {}) {
  const board = applySavedLookToPatchBoard({
    patchBoard,
    strips,
    savedLook,
  });

  return deriveSectionTargets({
    strips,
    patchBoard: board,
    defaultLook: savedLook?.defaultLook || {},
  });
}
