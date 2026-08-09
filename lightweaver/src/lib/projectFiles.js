import { validateProjectEnvelope } from './projectRepository.js';

// Canonical Lightweaver project file naming + import filters.
//
// The Studio has historically produced several download names
// (`lightweaver-project-<date>.json`, `<name>.lw.json`, …). This module is the
// single source of truth: every project export should be named with
// `canonicalProjectFileName(projectName)` and every project file input should
// accept `PROJECT_IMPORT_ACCEPT` (permissive, so older exports still open).

export const CANONICAL_PROJECT_EXTENSION = '.lw.json';
export const COMPLETE_EDITABLE_PROJECT_LABEL = 'Complete editable project';
export const INSTALLED_CONFIGURATION_LABEL = 'Installed configuration';

// Permissive on purpose: `.lwproj.json` and plain `.json` are legacy export
// names that must keep loading forever.
export const PROJECT_IMPORT_ACCEPT = '.lw.json,.lwproj.json,.json';

const FALLBACK_BASENAME = 'lightweaver';

export function slugifyProjectName(projectName) {
  return String(projectName || '')
    .trim()
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function canonicalProjectFileName(projectName) {
  const slug = slugifyProjectName(projectName);
  return `${slug || FALLBACK_BASENAME}${CANONICAL_PROJECT_EXTENSION}`;
}

export function serializeProjectFile(envelope) {
  return JSON.stringify(envelope, null, 2);
}

export function parseProjectFile(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : structuredClone(text);
  // Delayed imports are unnecessary here: project files are already consumed
  // from the main Studio graph, and envelope validation must happen before UI
  // replacement confirmation is offered.
  return validateProjectEnvelope(parsed);
}
