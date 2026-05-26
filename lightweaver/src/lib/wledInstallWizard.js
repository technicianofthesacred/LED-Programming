import { CONTROLLER_COMPATIBILITY_LEVELS } from './controllerCompatibility.js';

export const WLED_INSTALL_WIZARD_STATUS = Object.freeze({
  BLOCKED: 'blocked',
  NEEDS_BACKUP: 'needs-backup',
  READY_TO_APPLY: 'ready-to-apply',
  EMPTY_PACKAGE: 'empty-package',
});

const GEOMETRY_BLOCKERS = new Set(['firmware', 'led-count', 'segments', 'led-map']);
const NON_CRITICAL_WARNINGS = new Set(['identity', 'clock', 'audio-source']);

export function buildWledInstallWizardPlan({
  controllerAudit = null,
  wledPackage = null,
  backupSaved = false,
} = {}) {
  const findings = controllerAudit?.findings || [];
  const hasControllerAudit = Boolean(controllerAudit);
  const blockers = [
    ...(hasControllerAudit ? [] : ['controller-audit']),
    ...findInstallBlockers(findings),
  ];
  const warnings = findings
    .filter(item => NON_CRITICAL_WARNINGS.has(item.id))
    .filter(item => item.level !== CONTROLLER_COMPATIBILITY_LEVELS.READY)
    .map(item => item.id);
  const packageSummary = summarizePackage(wledPackage);
  const hasRunnablePackage = packageSummary.presets > 0;
  const status = chooseStatus({ blockers, backupSaved, hasRunnablePackage });

  return {
    status,
    canInstall: status === WLED_INSTALL_WIZARD_STATUS.READY_TO_APPLY,
    blockers,
    warnings,
    packageSummary,
    steps: makeSteps({ blockers, warnings, backupSaved, packageSummary, hasRunnablePackage }),
    nextAction: makeNextAction({ status, blockers, backupSaved, hasRunnablePackage }),
  };
}

function findInstallBlockers(findings) {
  return findings
    .filter(item => GEOMETRY_BLOCKERS.has(item.id))
    .filter(item => ![CONTROLLER_COMPATIBILITY_LEVELS.READY, CONTROLLER_COMPATIBILITY_LEVELS.INFO].includes(item.level))
    .map(item => item.id);
}

function summarizePackage(wledPackage) {
  return {
    presets: Array.isArray(wledPackage?.presets) ? wledPackage.presets.length : 0,
    customEffectPorts: Array.isArray(wledPackage?.customEffectPorts) ? wledPackage.customEffectPorts.length : 0,
    unsupportedPatterns: Array.isArray(wledPackage?.unsupportedPatterns) ? wledPackage.unsupportedPatterns.length : 0,
    playlistPresetId: wledPackage?.playlistPresetId || null,
    presetStart: wledPackage?.presetStart || null,
    ledCount: wledPackage?.project?.ledCount || 0,
  };
}

function chooseStatus({ blockers, backupSaved, hasRunnablePackage }) {
  if (!hasRunnablePackage) return WLED_INSTALL_WIZARD_STATUS.EMPTY_PACKAGE;
  if (blockers.length > 0) return WLED_INSTALL_WIZARD_STATUS.BLOCKED;
  if (!backupSaved) return WLED_INSTALL_WIZARD_STATUS.NEEDS_BACKUP;
  return WLED_INSTALL_WIZARD_STATUS.READY_TO_APPLY;
}

function makeSteps({ blockers, warnings, backupSaved, packageSummary, hasRunnablePackage }) {
  const geometryBlocked = blockers.some(id => ['firmware', 'led-count', 'segments', 'led-map'].includes(id));
  return [
    {
      id: 'controller',
      label: 'Controller compatibility',
      state: blockers.includes('controller-audit') ? 'open' : blockers.includes('firmware') ? 'blocked' : 'ready',
      detail: blockers.includes('controller-audit')
        ? 'Run the controller audit before applying stored looks.'
        : blockers.includes('firmware')
        ? 'Connect to a compatible ESP32 WLED controller.'
        : 'WLED firmware is compatible with the Basic installer path.',
    },
    {
      id: 'geometry',
      label: 'Pixel geometry',
      state: geometryBlocked ? 'blocked' : 'ready',
      detail: geometryBlocked
        ? 'Resolve LED count, segment, or ledmap findings before writing presets.'
        : 'LED count and segment geometry are install-safe.',
    },
    {
      id: 'backup',
      label: 'Preset backup',
      state: backupSaved ? 'ready' : 'open',
      detail: backupSaved
        ? 'A controller snapshot or preset backup has been recorded.'
        : 'Back up /presets.json before overwriting stored looks.',
    },
    {
      id: 'package',
      label: 'WLED Basic package',
      state: hasRunnablePackage ? 'ready' : 'blocked',
      detail: hasRunnablePackage
        ? `${packageSummary.presets} preset(s), playlist ${packageSummary.playlistPresetId || 'pending'}, ${packageSummary.customEffectPorts} custom port(s), ${packageSummary.unsupportedPatterns} gated pattern(s).`
        : 'The package has no immediately runnable WLED presets.',
    },
    {
      id: 'warnings',
      label: 'Operator polish',
      state: warnings.length ? 'open' : 'ready',
      detail: warnings.length
        ? `Resolve or accept non-critical findings: ${warnings.join(', ')}.`
        : 'Identity, clock, and runtime warnings are clear.',
    },
  ];
}

function makeNextAction({ status, blockers, backupSaved, hasRunnablePackage }) {
  if (!hasRunnablePackage) {
    return {
      id: 'choose-wled-patterns',
      label: 'Choose WLED-ready looks',
      detail: 'Add at least one WLED stock pattern to the Basic package.',
    };
  }
  if (blockers.includes('controller-audit')) {
    return {
      id: 'run-controller-audit',
      label: 'Run controller audit',
      detail: 'Check firmware, geometry, presets, and controller state before install.',
    };
  }
  if (blockers.includes('led-count')) {
    return {
      id: 'fix-led-count',
      label: 'Set final LED count',
      detail: 'Update WLED LED Preferences to match the artwork before installing.',
    };
  }
  if (blockers.includes('segments')) {
    return {
      id: 'fix-segments',
      label: 'Write segment geometry',
      detail: 'Push Lightweaver strip bounds to WLED segments or simplify to one full-piece segment.',
    };
  }
  if (blockers.includes('led-map')) {
    return {
      id: 'upload-ledmap',
      label: 'Upload ledmap.json',
      detail: 'Install a Lightweaver LED map or disable spatial WLED effects for this controller.',
    };
  }
  if (blockers.length > 0) {
    return {
      id: 'resolve-blockers',
      label: 'Resolve controller blockers',
      detail: blockers.join(', '),
    };
  }
  if (!backupSaved || status === WLED_INSTALL_WIZARD_STATUS.NEEDS_BACKUP) {
    return {
      id: 'backup-presets',
      label: 'Back up presets',
      detail: 'Save the existing WLED preset file before applying Lightweaver looks.',
    };
  }
  return {
    id: 'apply-package',
    label: 'Apply WLED Basic package',
    detail: 'Install presets and playlist to the connected controller.',
  };
}
