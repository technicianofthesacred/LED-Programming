export const CONTROLLER_COMPATIBILITY_LEVELS = Object.freeze({
  READY: 'ready',
  INFO: 'info',
  NEEDS_CONFIG: 'needs-config',
  NEEDS_INSTALL: 'needs-install',
  RUNTIME_ONLY: 'runtime-only',
  BLOCKED: 'blocked',
});

export function auditWledControllerCompatibility({
  info = {},
  state = {},
  cfg = {},
  presets = null,
  ledMap = null,
  expected = {},
} = {}) {
  const actual = summarizeController(info, state, cfg, presets, ledMap);
  const expectedPixelCount = positiveInt(expected.pixelCount);
  const expectedSegmentCount = positiveInt(expected.segmentCount);
  const findings = [
    auditFirmware(actual),
    auditLedCount(actual, expectedPixelCount),
    auditSegments(actual, expectedSegmentCount),
    auditPresets(actual, expected),
    auditLedMap(actual, expected),
    auditArtNet(actual, expected),
    auditClock(actual),
    auditIdentity(actual),
    auditAudioSource(actual, expected),
  ].filter(Boolean);

  return {
    actual,
    expected: {
      pixelCount: expectedPixelCount || null,
      segmentCount: expectedSegmentCount || null,
      requiresLedMap: Boolean(expected.requiresLedMap),
      requiresArtNet: Boolean(expected.requiresArtNet),
      usesAudioPatterns: Boolean(expected.usesAudioPatterns),
    },
    findings,
    summary: summarizeFindings(findings),
    runtimeGates: makeRuntimeGates(findings),
  };
}

function summarizeController(info, state, cfg, presets, ledMap) {
  const output = firstLedOutput(cfg);
  const segments = Array.isArray(state?.seg) ? state.seg : [];
  const presetEntries = normalizePresetEntries(presets);
  const live = cfg?.if?.live || {};
  const dmx = live?.dmx || {};
  const ledCount = positiveInt(info?.leds?.count) || positiveInt(cfg?.hw?.led?.total) || positiveInt(output?.len);

  return {
    online: Boolean(info?.ver || info?.arch || info?.ip),
    name: String(info?.name || cfg?.id?.name || ''),
    ip: String(info?.ip || ''),
    version: String(info?.ver || ''),
    release: String(info?.release || ''),
    arch: String(info?.arch || ''),
    mac: String(info?.mac || ''),
    ledCount,
    maxSegments: positiveInt(info?.leds?.maxseg),
    segmentCount: segments.length,
    effectCount: positiveInt(info?.fxcount),
    paletteCount: positiveInt(info?.palcount),
    time: String(info?.time || ''),
    fsUsedKb: Number(info?.fs?.u || 0),
    fsTotalKb: Number(info?.fs?.t || 0),
    output: {
      pin: Array.isArray(output?.pin) ? output.pin : [],
      length: positiveInt(output?.len),
      type: output?.type ?? null,
      order: output?.order ?? null,
      reversed: Boolean(output?.rev),
    },
    realtime: {
      enabled: live.en === true,
      port: positiveInt(live.port),
      universe: positiveInt(dmx.uni),
      address: positiveInt(dmx.addr),
      mode: dmx.mode ?? null,
    },
    presets: {
      count: presetEntries.length,
      installedCount: presetEntries.filter(entry => entry.installed).length,
      entries: presetEntries,
    },
    ledMap: summarizeLedMap(ledMap),
    audioReactiveOn: state?.AudioReactive?.on === true,
  };
}

function auditFirmware(actual) {
  if (!actual.online) {
    return finding(
      'firmware',
      'Controller reachable',
      CONTROLLER_COMPATIBILITY_LEVELS.BLOCKED,
      'No WLED /json/info response was available.',
      'Connect to the controller IP before exporting or installing.',
    );
  }
  if (!actual.version || !/ESP32/i.test(actual.arch)) {
    return finding(
      'firmware',
      'WLED ESP32 firmware',
      CONTROLLER_COMPATIBILITY_LEVELS.BLOCKED,
      `Detected ${actual.version || 'unknown firmware'} ${actual.arch || 'unknown architecture'}.`,
      'Flash or select the ESP32-S3 WLED controller for Lightweaver Basic.',
    );
  }
  return finding(
    'firmware',
    'WLED ESP32 firmware',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    `WLED ${actual.version} is running on ${actual.arch}.`,
    'Keep this as the Basic WLED runtime unless this piece is intentionally moved to custom firmware.',
  );
}

function auditLedCount(actual, expectedPixelCount) {
  if (!actual.ledCount) {
    return finding(
      'led-count',
      'LED count',
      CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG,
      'The controller did not report a configured LED count.',
      'Set the final LED count in WLED LED Preferences before saving presets.',
    );
  }
  if (expectedPixelCount && actual.ledCount !== expectedPixelCount) {
    return finding(
      'led-count',
      'LED count',
      CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG,
      `WLED is configured for ${actual.ledCount} LEDs, but this audit expected ${expectedPixelCount}.`,
      'Update WLED LED Preferences to the artwork pixel count, then rerun pixel marker tests.',
    );
  }
  if (!expectedPixelCount && actual.ledCount <= 30) {
    return finding(
      'led-count',
      'LED count',
      CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG,
      `WLED is still at the ${actual.ledCount}-LED bench count.`,
      'Treat this as bench-only until the final artwork pixel count is configured.',
    );
  }
  return finding(
    'led-count',
    'LED count',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    `WLED is configured for ${actual.ledCount} LEDs.`,
    'Use this count for WLED presets, Art-Net channel math, and power estimates.',
  );
}

function auditSegments(actual, expectedSegmentCount) {
  if (expectedSegmentCount && actual.segmentCount < expectedSegmentCount) {
    return finding(
      'segments',
      'Segments',
      CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG,
      `WLED currently has ${actual.segmentCount} segment(s), but the piece expects ${expectedSegmentCount}.`,
      'Create WLED segments or let the Basic installer write segment bounds from Lightweaver strips.',
    );
  }
  if (actual.segmentCount <= 1) {
    return finding(
      'segments',
      'Segments',
      CONTROLLER_COMPATIBILITY_LEVELS.INFO,
      'The controller is using one full-strip segment.',
      'This is acceptable for whole-piece Basic looks; zone-specific looks need segment export.',
    );
  }
  return finding(
    'segments',
    'Segments',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    `The controller reports ${actual.segmentCount} segment(s).`,
    'Verify segment names and bounds against the laser-cut zones before installation.',
  );
}

function auditPresets(actual, expected) {
  if (expected.requiresLightweaverPresets === false) return null;
  if (actual.presets.installedCount === 0) {
    return finding(
      'presets',
      'Stored looks',
      CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_INSTALL,
      'No named WLED presets or playlists are installed yet.',
      'Back up /presets.json, then install the Lightweaver WLED Basic package.',
    );
  }
  return finding(
    'presets',
    'Stored looks',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    `${actual.presets.installedCount} preset/playlist entr${actual.presets.installedCount === 1 ? 'y is' : 'ies are'} installed.`,
    'Confirm the playlist order matches the desired visitor-facing cycle.',
  );
}

function auditLedMap(actual, expected) {
  if (!expected.requiresLedMap) return null;
  if (!actual.ledMap.available) {
    return finding(
      'led-map',
      'LED map',
      CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG,
      'No WLED ledmap.json was found.',
      'Export and upload ledmap.json if the piece needs 2D/spatial WLED effects.',
    );
  }
  return finding(
    'led-map',
    'LED map',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    `WLED ledmap.json is available with ${actual.ledMap.length || 'unknown'} mapped entries.`,
    'Verify the map ordering against Lightweaver before relying on spatial effects.',
  );
}

function auditArtNet(actual, expected) {
  if (!expected.requiresArtNet) return null;
  if (!actual.realtime.enabled) {
    return finding(
      'artnet',
      'Art-Net / E1.31 realtime input',
      CONTROLLER_COMPATIBILITY_LEVELS.RUNTIME_ONLY,
      'WLED realtime input is disabled.',
      'Enable the intended Art-Net or E1.31 input mode in WLED Sync settings and reboot if WLED requires it.',
    );
  }
  return finding(
    'artnet',
    'Art-Net / E1.31 realtime input',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    `Realtime input is enabled on port ${actual.realtime.port || 'unknown'}, universe ${actual.realtime.universe || 'unknown'}, address ${actual.realtime.address || 'unknown'}, mode ${actual.realtime.mode ?? 'unknown'}.`,
    'For Advanced Art-Net, confirm Madrix sends the same protocol, universe, and channel layout.',
  );
}

function auditClock(actual) {
  if (/^1970\b/.test(actual.time)) {
    return finding(
      'clock',
      'Clock / schedules',
      CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG,
      `WLED time is ${actual.time}, which indicates no valid wall-clock sync.`,
      'Enable NTP or avoid time-of-day schedules for this controller.',
    );
  }
  if (!actual.time) return null;
  return finding(
    'clock',
    'Clock / schedules',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    `WLED reports time ${actual.time}.`,
    'Time-based presets can be used if the install network keeps time sync available.',
  );
}

function auditIdentity(actual) {
  if (!actual.name || /^wled$/i.test(actual.name)) {
    return finding(
      'identity',
      'Controller identity',
      CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG,
      `The controller is still named ${actual.name || 'WLED'}.`,
      'Rename it with the Lightweaver piece name and reserve the MAC/IP for effortless reconnection.',
    );
  }
  return finding(
    'identity',
    'Controller identity',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    `The controller is named ${actual.name}.`,
    'Use the same identity in the phone UI, DHCP reservation, and install notes.',
  );
}

function auditAudioSource(actual, expected) {
  if (!expected.usesAudioPatterns) return null;
  if (!actual.audioReactiveOn) {
    return finding(
      'audio-source',
      'Audio-reactive looks',
      CONTROLLER_COMPATIBILITY_LEVELS.RUNTIME_ONLY,
      'Audio-reactive processing is not active on WLED.',
      'Gate audio patterns to Lightweaver live rendering, Art-Net, or an explicit audio-reactive WLED setup.',
    );
  }
  return finding(
    'audio-source',
    'Audio-reactive looks',
    CONTROLLER_COMPATIBILITY_LEVELS.READY,
    'Audio-reactive processing is active.',
    'Confirm microphone/line input levels before installing audio-driven looks.',
  );
}

function makeRuntimeGates(findings) {
  const byId = Object.fromEntries(findings.map(item => [item.id, item]));
  const ledReady = byId['led-count']?.level === CONTROLLER_COMPATIBILITY_LEVELS.READY;
  const firmwareReady = byId.firmware?.level === CONTROLLER_COMPATIBILITY_LEVELS.READY;
  const presetsReady = byId.presets?.level === CONTROLLER_COMPATIBILITY_LEVELS.READY;
  const artnetReady = !byId.artnet || byId.artnet.level === CONTROLLER_COMPATIBILITY_LEVELS.READY;

  return {
    wledBasic: {
      status: firmwareReady && ledReady && presetsReady ? 'ready' : presetsReady ? 'needs-configuration' : 'needs-install',
      blockers: findings
        .filter(item => ['firmware', 'led-count', 'presets', 'segments', 'led-map', 'identity'].includes(item.id))
        .filter(item => ![CONTROLLER_COMPATIBILITY_LEVELS.READY, CONTROLLER_COMPATIBILITY_LEVELS.INFO].includes(item.level))
        .map(item => item.id),
    },
    advancedArtNet: {
      status: firmwareReady && ledReady && artnetReady ? 'ready' : 'needs-configuration',
      blockers: findings
        .filter(item => ['firmware', 'led-count', 'artnet'].includes(item.id))
        .filter(item => item.level !== CONTROLLER_COMPATIBILITY_LEVELS.READY)
        .map(item => item.id),
    },
  };
}

function summarizeFindings(findings) {
  const counts = {};
  for (const item of findings) {
    counts[item.level] = (counts[item.level] || 0) + 1;
  }
  let status = 'ready';
  if (counts[CONTROLLER_COMPATIBILITY_LEVELS.BLOCKED]) status = 'blocked';
  else if (
    counts[CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG] ||
    counts[CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_INSTALL] ||
    counts[CONTROLLER_COMPATIBILITY_LEVELS.RUNTIME_ONLY]
  ) status = 'needs-configuration';
  return { status, counts };
}

function finding(id, label, level, observed, shift) {
  return { id, label, level, observed, shift };
}

function firstLedOutput(cfg) {
  const outputs = cfg?.hw?.led?.ins;
  return Array.isArray(outputs) && outputs.length ? outputs[0] : {};
}

function normalizePresetEntries(presets) {
  if (!presets || typeof presets !== 'object') return [];
  return Object.entries(presets)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([id, value]) => {
      const name = String(value.n || '');
      const hasState = Array.isArray(value.seg) || Boolean(value.on != null || value.bri != null);
      const hasPlaylist = Boolean(value.playlist);
      return {
        id,
        name,
        hasState,
        hasPlaylist,
        installed: id !== '0' && Boolean(name || hasState || hasPlaylist),
      };
    });
}

function summarizeLedMap(ledMap) {
  if (!ledMap) return { available: false, length: 0 };
  const map = Array.isArray(ledMap) ? ledMap : ledMap.map;
  return {
    available: Array.isArray(map) && map.length > 0,
    length: Array.isArray(map) ? map.length : 0,
  };
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
