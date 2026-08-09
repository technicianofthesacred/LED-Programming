const BUILD_ID = /^[0-9a-f]{40}$/;

function validBuildNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!validBuildNumber(value.buildNumber) || typeof value.buildId !== 'string' || !BUILD_ID.test(value.buildId)) return null;
  return { buildNumber: value.buildNumber, buildId: value.buildId };
}

function validInstalledCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.buildId !== 'string' || !BUILD_ID.test(value.buildId)) return null;
  if (value.buildNumber === undefined || value.buildNumber === null || value.buildNumber === 0) {
    return { buildNumber: null, buildId: value.buildId };
  }
  if (!validBuildNumber(value.buildNumber)) return null;
  return { buildNumber: value.buildNumber, buildId: value.buildId };
}

function result(state, installedBuildNumber, releaseBuildNumber, label, actionable) {
  return { state, installedBuildNumber, releaseBuildNumber, label, actionable };
}

// This only accepts identities that can prove an exact revision. The footer
// must never turn a loosely formatted card response into a firmware action.
export function classifyFooterFirmwareStatus(installed, verifiedRelease) {
  const release = validRelease(verifiedRelease);
  if (installed === null || installed === undefined) {
    return release
      ? result('disconnected', null, release.buildNumber, `Firmware ${release.buildNumber} available`, false)
      : result('disconnected', null, null, 'Firmware release unavailable', false);
  }

  const card = validInstalledCard(installed);
  if (!card) {
    return result('release-unknown', null, release?.buildNumber ?? null, 'Firmware release unavailable', false);
  }

  if (!release) {
    const label = card.buildNumber === null
      ? 'Card legacy · firmware release unavailable'
      : `Card ${card.buildNumber} · firmware release unavailable`;
    return result('release-unknown', card.buildNumber, null, label, false);
  }

  if (card.buildNumber === null) {
    return result('legacy', null, release.buildNumber, `Card legacy → ${release.buildNumber}`, true);
  }
  if (card.buildNumber > release.buildNumber) {
    return result('development-build', card.buildNumber, release.buildNumber, `Card ${card.buildNumber} · release ${release.buildNumber}`, false);
  }
  if (card.buildNumber < release.buildNumber || card.buildId !== release.buildId) {
    return result('update-available', card.buildNumber, release.buildNumber, `Card ${card.buildNumber} → ${release.buildNumber}`, true);
  }
  return result('current', card.buildNumber, release.buildNumber, `Card ${card.buildNumber} current`, false);
}
