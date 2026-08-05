const SOURCE_REVISION = /^[0-9a-f]{40}$/;

function strictRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Studio release marker must be an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'buildId,buildNumber,schemaVersion,sourceRevision') {
    throw new Error('Studio release marker must contain exactly schemaVersion, sourceRevision, buildId, and buildNumber');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('Studio release marker schemaVersion must be 1');
  }
  if (typeof value.sourceRevision !== 'string' || !SOURCE_REVISION.test(value.sourceRevision)) {
    throw new Error('Studio release sourceRevision must be 40 lowercase hexadecimal characters');
  }
  if (value.buildId !== value.sourceRevision.slice(0, 12)) {
    throw new Error('Studio release buildId must be the first 12 characters of sourceRevision');
  }
  // The human-facing identity. Two builds are ordered by comparing two small
  // integers instead of two opaque hashes, so "am I on the newest Studio?" is
  // answerable at a glance from the footer beacon.
  if (!Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1) {
    throw new Error('Studio release buildNumber must be a positive integer');
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceRevision: value.sourceRevision,
    buildId: value.buildId,
    buildNumber: value.buildNumber,
  });
}

export function assertStudioSourceRevision(sourceRevision) {
  if (typeof sourceRevision !== 'string' || !SOURCE_REVISION.test(sourceRevision)) {
    throw new Error('Studio release sourceRevision must be 40 lowercase hexadecimal characters');
  }
  return sourceRevision;
}

export function parseStudioRelease(input) {
  if (typeof input !== 'string') return strictRelease(input);
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Studio release marker is not valid JSON');
  }
  return strictRelease(parsed);
}

export function studioReleaseFromRevision(sourceRevision, buildNumber) {
  return strictRelease({
    schemaVersion: 1,
    sourceRevision,
    buildId: typeof sourceRevision === 'string' ? sourceRevision.slice(0, 12) : '',
    buildNumber,
  });
}

export function formatStudioBuildLabel(release) {
  return `Build ${release.buildNumber}`;
}

export function serializeStudioRelease(release) {
  return `${JSON.stringify(strictRelease(release), null, 2)}\n`;
}

export function getRunningStudioRelease(value) {
  let embedded = value;
  if (embedded === undefined && typeof __LIGHTWEAVER_STUDIO_RELEASE__ !== 'undefined') {
    embedded = __LIGHTWEAVER_STUDIO_RELEASE__;
  }
  if (!embedded) throw new Error('The embedded Studio release identity is unavailable');
  return strictRelease(embedded);
}
