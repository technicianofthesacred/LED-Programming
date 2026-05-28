import assert from 'node:assert/strict';
import { PATTERNS } from '../src/lib/patterns-library.js';
import { compile, evalPixel } from '../src/lib/patterns.js';
import { createDefaultProject, migrateProject, PROJECT_VERSION, resolveStartupProject } from '../src/lib/projectModel.js';
import { normalizePalette, renderPixelFrame } from '../src/lib/frameEngine.js';
import {
  easeCrossfade,
  formatMotionSpeed,
  smoothPixelFrame,
} from '../src/lib/motionSmoothing.js';
import { applySymmetry } from '../src/lib/symmetry.js';
import { clampClipMove, clampClipResize, placeClipInTrackGap } from '../src/lib/timelineLayout.js';
import { recordLivePattern } from '../src/lib/liveRecorder.js';
import {
  makeBlackoutFrame,
  makeWledFrameMessage,
  makeWledSegments,
  makeWledProxyUrl,
  makeWledWsUrl,
  requestWledJson,
} from '../src/lib/deviceController.js';
import {
  DEFAULT_WLED_APP_FLASH_ADDRESS,
  validateFlashPlan,
} from '../src/lib/flashPlan.js';
import {
  makeSafeWledTestState,
  pickBestWledDevice,
  sortWledDevices,
  summarizeWledInfo,
} from '../src/lib/wledDiscovery.js';
import {
  buildControllerProfile,
  controllerProfileReadiness,
  estimatePowerBudget,
  makeArtNetNotes,
  makeDhcpReservationNote,
  makeInstallReadinessReport,
  makeKnownGoodRecoveryState,
  makePixelCountProbeState,
  makePixelMarkerState,
  makeWledHostname,
} from '../src/lib/controllerProfiles.js';
import {
  CONTROLLER_COMPATIBILITY_LEVELS,
  auditWledControllerCompatibility,
} from '../src/lib/controllerCompatibility.js';
import {
  LWSEQ_HEADER_BYTES,
  buildStandaloneProfile,
  deriveStandaloneOutputsFromStrips,
  estimateLwseqBytes,
  makeStandalonePackage,
  normalizeStandaloneOutputs,
  toLwseqBytes,
} from '../src/lib/standaloneController.js';
import {
  ADVANCED_ARTNET_TIER_ID,
  PATTERN_TARGETS,
  WLED_BASIC_TIER_ID,
  describePatternCompatibility,
  getRuntimeTier,
  inferPatternTargets,
  recommendRuntimeTier,
} from '../src/lib/runtimeTargets.js';
import {
  buildWledBasicPackage,
  collectWledBasicPatternIds,
  makeWledBasicPresetsJson,
} from '../src/lib/wledBasicExport.js';
import {
  DEFAULT_WLED_PHYSICAL_CONTROLS,
  WLED_ENCODER_FIRMWARE_MODES,
  summarizeWledControlContract,
} from '../src/lib/wledControlContract.js';
import {
  buildWledInstallWizardPlan,
} from '../src/lib/wledInstallWizard.js';
import {
  PATTERN_COMPATIBILITY_GATES,
  auditPatternCompatibility,
  getPatternCompatibilityGate,
  summarizePatternCompatibility,
} from '../src/lib/patternCompatibility.js';
import {
  makePatternStudioSummary,
} from '../src/lib/patternStudio.js';
import {
  shouldRunBackgroundPatternOutput,
} from '../src/lib/backgroundOutput.js';
import {
  shouldRebuildStripPixels,
} from '../src/lib/stripPixels.js';

const palette = normalizePalette(['#123456', '#abcdef', '#ffcc00']);
const duplicateIds = PATTERNS.map(p => p.id).filter((id, i, arr) => arr.indexOf(id) !== i);
assert.deepEqual(duplicateIds, [], 'pattern ids must be unique');

for (const pattern of PATTERNS) {
  const { fn, error } = compile(pattern.code || 'return [0,0,0];');
  assert.equal(error, null, `${pattern.id} should compile`);
  assert.ok(fn, `${pattern.id} should return a compiled function`);
  for (const sample of [
    { index: 0, x: 0, y: 0, t: 0, time: 0, pixelCount: 1, stripProgress: 0 },
    { index: 1, x: 0.25, y: 0.5, t: 0.25, time: 0.1, pixelCount: 8, stripProgress: 0.2 },
    { index: 7, x: 1, y: 1, t: 1.5, time: 0.75, pixelCount: 8, stripProgress: 1 },
  ]) {
    const out = evalPixel(fn, sample.index, sample.x, sample.y, sample.t, sample.time, sample.pixelCount, palette, 0.25, 0.5, {}, 'audit', sample.stripProgress);
    assert.ok(Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b), `${pattern.id} produced invalid RGB`);
  }
}

const defaultProject = createDefaultProject();
assert.equal(defaultProject.version, PROJECT_VERSION);
assert.equal(defaultProject.devices.wledIp, '');
assert.deepEqual(defaultProject.devices.segmentMap, {});
assert.deepEqual(defaultProject.devices.controllerProfiles, []);
assert.equal(defaultProject.devices.activeControllerId, '');
assert.deepEqual(defaultProject.devices.physicalControls, DEFAULT_WLED_PHYSICAL_CONTROLS);
assert.equal(defaultProject.devices.standaloneController.outputs.length, 4);
assert.equal(defaultProject.devices.standaloneController.outputs[0].pin, 16);
assert.equal(defaultProject.devices.standaloneController.controls.blackout, 9);
assert.equal(defaultProject.devices.standaloneController.runtimeMode, 'sequence');
assert.equal(defaultProject.pattern.motionSmoothing, 'soft');

const savedWithLayout = {
  ...createDefaultProject(),
  layout: {
    ...createDefaultProject().layout,
    strips: [{ id: 'saved-strip', pathData: 'M0 0 L10 0', pixelCount: 10, pixels: [{ x: 0, y: 0 }] }],
  },
  pattern: {
    ...createDefaultProject().pattern,
    activePatternId: 'gradient',
  },
};
const emptyLegacyLayout = {
  version: 2,
  strips: [],
  viewBox: '0 0 640 400',
};
assert.equal(
  resolveStartupProject({ savedProject: savedWithLayout, legacyLayoutProject: emptyLegacyLayout }).layout.strips.length,
  1,
  'empty legacy layout autosave must not overwrite the canonical project layout',
);

const recoverableLegacyLayout = {
  version: 2,
  strips: [{ id: 'legacy-strip', pathData: 'M0 0 L20 0', pixelCount: 20 }],
  viewBox: '0 0 640 400',
};
const recoveredStartup = resolveStartupProject({
  savedProject: createDefaultProject(),
  legacyLayoutProject: recoverableLegacyLayout,
});
assert.equal(recoveredStartup.layout.strips[0].id, 'legacy-strip');
assert.equal(recoveredStartup.pattern.activePatternId, 'aurora');

const wledBasicTier = getRuntimeTier(WLED_BASIC_TIER_ID);
assert.equal(wledBasicTier.id, 'wled-basic');
assert.equal(wledBasicTier.requiresPiAtRuntime, false);
assert.ok(wledBasicTier.lookStorage.includes('WLED presets'));
assert.ok(wledBasicTier.capabilities.includes(PATTERN_TARGETS.WLED_CUSTOM_EFFECT));
assert.ok(wledBasicTier.capabilities.includes(PATTERN_TARGETS.WLED_PRESET));

const advancedTier = getRuntimeTier(ADVANCED_ARTNET_TIER_ID);
assert.equal(advancedTier.id, 'advanced-artnet');
assert.equal(advancedTier.requiresPiAtRuntime, 'optional');
assert.ok(advancedTier.capabilities.includes(PATTERN_TARGETS.ARTNET_STREAM));
assert.ok(advancedTier.capabilities.includes(PATTERN_TARGETS.STANDALONE_SEQUENCE));

assert.equal(
  recommendRuntimeTier({ wantsStoredLooks: true, needsExactTimeline: false, needsLiveArtNet: false }).id,
  WLED_BASIC_TIER_ID,
);
assert.equal(
  recommendRuntimeTier({ wantsStoredLooks: true, needsExactTimeline: true, needsLiveArtNet: false }).id,
  ADVANCED_ARTNET_TIER_ID,
);
assert.equal(
  recommendRuntimeTier({ wantsStoredLooks: false, needsExactTimeline: false, needsLiveArtNet: true }).id,
  ADVANCED_ARTNET_TIER_ID,
);

const candleTargets = inferPatternTargets(PATTERNS.find(pattern => pattern.id === 'candle'));
assert.ok(candleTargets.includes(PATTERN_TARGETS.WLED_CUSTOM_EFFECT));
assert.ok(candleTargets.includes(PATTERN_TARGETS.STANDALONE_PROCEDURAL));
assert.equal(
  recommendRuntimeTier({ wantsStoredLooks: true, patternTargets: candleTargets }).id,
  WLED_BASIC_TIER_ID,
);
const candleCompatibility = describePatternCompatibility(PATTERNS.find(pattern => pattern.id === 'candle'));
assert.equal(candleCompatibility.bestTier.id, WLED_BASIC_TIER_ID);
assert.match(candleCompatibility.summary, /stored on WLED/i);

const heartbeatTargets = inferPatternTargets(PATTERNS.find(pattern => pattern.id === 'heartbeat'));
assert.ok(heartbeatTargets.includes(PATTERN_TARGETS.ARTNET_STREAM));
assert.ok(heartbeatTargets.includes(PATTERN_TARGETS.STANDALONE_SEQUENCE));
assert.equal(describePatternCompatibility(PATTERNS.find(pattern => pattern.id === 'heartbeat')).bestTier.id, ADVANCED_ARTNET_TIER_ID);

const heartbeatPattern = PATTERNS.find(pattern => pattern.id === 'heartbeat');
const heartbeatCompiled = compile(heartbeatPattern.code);
const heartbeatPeak = evalPixel(heartbeatCompiled.fn, 0, 0, 0, 0, 0, 43, palette, 0, 0, { hue: 0 }, 'strip-1', 0);
const heartbeatRest = evalPixel(heartbeatCompiled.fn, 0, 0, 0, 0.4, 0.4, 43, palette, 0.4, 0, { hue: 0 }, 'strip-1', 0);
assert.ok(heartbeatPeak.r >= 240 && heartbeatPeak.g <= 3 && heartbeatPeak.b <= 3, 'heartbeat peak should be bright red');
assert.ok(heartbeatRest.r >= 10 && heartbeatRest.g <= 3 && heartbeatRest.b <= 3, 'heartbeat rest should stay dim red instead of disappearing');

assert.equal(shouldRunBackgroundPatternOutput('layout'), true);
assert.equal(shouldRunBackgroundPatternOutput('settings'), true);
assert.equal(shouldRunBackgroundPatternOutput('pattern'), false);
assert.equal(shouldRunBackgroundPatternOutput('live'), false);
assert.equal(shouldRunBackgroundPatternOutput('timeline'), false);

assert.equal(shouldRebuildStripPixels({ pathData: 'M 0 0 L 10 0', pixelCount: 43, pixels: Array.from({ length: 41 }) }), true);
assert.equal(shouldRebuildStripPixels({ pathData: 'M 0 0 L 10 0', pixelCount: 43, pixels: Array.from({ length: 43 }) }), false);
assert.equal(shouldRebuildStripPixels({ pathData: 'M 0 0 L 10 0', pixelCount: 43, pixels: [] }), true);

const compatibilityAudit = auditPatternCompatibility(PATTERNS);
assert.equal(compatibilityAudit.length, PATTERNS.length);
assert.equal(compatibilityAudit.every(item => item.patternId && item.gate && item.allowedRuntimes.length > 0), true);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'candle')).gate, PATTERN_COMPATIBILITY_GATES.WLED_STOCK);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'ember')).gate, PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'bass-pulse')).gate, PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'strobe-bpm')).gate, PATTERN_COMPATIBILITY_GATES.BEAT_SOURCE);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'mandelbrot')).gate, PATTERN_COMPATIBILITY_GATES.COMPUTER_RENDER);
assert.ok(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'bass-pulse')).allowedRuntimes.includes('computer-live'));
assert.ok(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'bass-pulse')).allowedRuntimes.includes('artnet'));
assert.ok(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'ember')).allowedRuntimes.includes('wled-custom'));
const compatibilitySummary = summarizePatternCompatibility(compatibilityAudit);
assert.equal(Object.values(compatibilitySummary.gates).reduce((sum, count) => sum + count, 0), PATTERNS.length);
assert.ok(compatibilitySummary.gates[PATTERN_COMPATIBILITY_GATES.WLED_STOCK] >= 12);
assert.ok(compatibilitySummary.gates[PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE] >= 10);
assert.ok(compatibilitySummary.gates[PATTERN_COMPATIBILITY_GATES.COMPUTER_RENDER] >= 1);

const basicPatternIds = collectWledBasicPatternIds({
  activePatternId: 'candle',
  showClips: [{ patternId: 'heartbeat' }, { patternId: 'aurora' }],
  strips: [{ patternId: 'twinkle' }],
  minBankSize: 4,
});
assert.deepEqual(basicPatternIds.slice(0, 4), ['candle', 'aurora', 'twinkle', 'breathe']);
assert.equal(basicPatternIds.includes('heartbeat'), false);
assert.deepEqual(collectWledBasicPatternIds({ patternIds: ['plasma', 'mandelbrot'] }), ['plasma']);

const wledBasicPackage = buildWledBasicPackage({
  projectName: 'Bench Piece',
  activePatternId: 'candle',
  showClips: [{ patternId: 'aurora' }, { patternId: 'heartbeat' }],
  strips: [
    { id: 'outer', name: 'Outer', pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
    { id: 'inner', name: 'Inner', patternId: 'twinkle', pixels: [{ x: 0.5, y: 0.5 }] },
  ],
  palette: ['#ffb15c', '#271006', '#ffd7a0'],
  duration: 120,
  loop: true,
});
assert.equal(wledBasicPackage.format, 'wled-basic-package');
assert.equal(wledBasicPackage.runtimeTier, WLED_BASIC_TIER_ID);
assert.equal(wledBasicPackage.presets[0].patternId, 'candle');
assert.equal(wledBasicPackage.presets[0].effectName, 'Candle');
assert.equal(wledBasicPackage.presets[0].segments.length, 2);
assert.equal(wledBasicPackage.presets[0].segments[0].n, 'Outer');
assert.equal(wledBasicPackage.presets[0].segments[1].start, 2);
assert.equal(wledBasicPackage.playlistPresetId, wledBasicPackage.presets.length + 1);
assert.deepEqual(wledBasicPackage.presetsJson[String(wledBasicPackage.playlistPresetId)].playlist.ps, wledBasicPackage.presets.map(preset => preset.presetId));
assert.equal(wledBasicPackage.customEffectPorts.some(pattern => pattern.patternId === 'twinkle'), false);
assert.equal(buildWledBasicPackage({
  projectName: 'Port Piece',
  activePatternId: 'ember',
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
}).customEffectPorts.some(pattern => pattern.patternId === 'ember'), true);
const browserFirstPackage = buildWledBasicPackage({
  projectName: 'Browser First Piece',
  activePatternId: 'ember',
  showClips: [
    { patternId: 'calm' },
    { patternId: 'bloom' },
    { patternId: 'wave' },
    { patternId: 'smoke' },
    { patternId: 'galaxy' },
    { patternId: 'zen' },
    { patternId: 'comet' },
  ],
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
});
assert.ok(browserFirstPackage.presets.length >= 8, 'browser-first WLED package needs at least 8 runnable stock presets');
assert.ok(browserFirstPackage.customEffectPorts.some(pattern => pattern.patternId === 'ember'));
assert.equal(browserFirstPackage.presets.every(preset => preset.compatibility === 'stock-wled-preset'), true);
assert.equal(wledBasicPackage.unsupportedPatterns.some(pattern => pattern.patternId === 'heartbeat'), true);
assert.equal(wledBasicPackage.unsupportedPatterns.find(pattern => pattern.patternId === 'heartbeat').gate, PATTERN_COMPATIBILITY_GATES.BEAT_SOURCE);
assert.equal(wledBasicPackage.compatibilityAudit.length >= wledBasicPackage.presets.length, true);
assert.equal(wledBasicPackage.gateSummary.gates[PATTERN_COMPATIBILITY_GATES.WLED_STOCK] >= wledBasicPackage.presets.length, true);
assert.ok(wledBasicPackage.install.applyViaJsonApi.includes('POST /json/state'));
assert.ok(wledBasicPackage.install.restorePresetsJson.includes('/edit'));

const candleStudio = makePatternStudioSummary(PATTERNS.find(pattern => pattern.id === 'candle'), {
  params: { flicker: 0.42 },
  palette: ['#ffb15c', '#271006', '#ffd7a0'],
  targetRuntime: 'wled-basic',
});
assert.equal(candleStudio.compatibility.gate, PATTERN_COMPATIBILITY_GATES.WLED_STOCK);
assert.equal(candleStudio.installability, 'ready');
assert.ok(candleStudio.qualityScore >= 80);
assert.equal(candleStudio.controls.paramCount > 0, true);
assert.equal(candleStudio.nextActions[0].id, 'save-wled-preset');

const emberStudio = makePatternStudioSummary(PATTERNS.find(pattern => pattern.id === 'ember'), {
  targetRuntime: 'wled-basic',
});
assert.equal(emberStudio.compatibility.gate, PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT);
assert.equal(emberStudio.installability, 'port-required');
assert.ok(emberStudio.nextActions.some(action => action.id === 'port-custom-effect'));

const bassStudio = makePatternStudioSummary(PATTERNS.find(pattern => pattern.id === 'bass-pulse'), {
  targetRuntime: 'wled-basic',
});
assert.equal(bassStudio.installability, 'runtime-only');
assert.ok(bassStudio.nextActions.some(action => action.id === 'gate-advanced'));

const customOnlyPattern = {
  id: 'gallery-idle-custom',
  name: 'Gallery Idle Custom',
  runtimeTargets: [PATTERN_TARGETS.WLED_CUSTOM_EFFECT],
};
const customPackage = buildWledBasicPackage({
  projectName: 'Custom Basic',
  patterns: [customOnlyPattern],
  patternIds: ['gallery-idle-custom'],
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(customPackage.presets.length, 0);
assert.deepEqual(customPackage.customEffectPorts.map(item => item.patternId), ['gallery-idle-custom']);

const presetJson = makeWledBasicPresetsJson({
  presets: wledBasicPackage.presets.slice(0, 2),
  playlistName: 'Bench Cycle',
  playlistPresetId: 10,
  presetDurationSeconds: 12,
  transitionMs: 900,
  repeat: 0,
});
assert.equal(presetJson['10'].n, 'Bench Cycle');
assert.deepEqual(presetJson['10'].playlist.dur, [120, 120]);
assert.deepEqual(presetJson['10'].playlist.transition, [9, 9]);
const migratedV1 = migrateProject({
  version: 1,
  name: 'Legacy',
  strips: [{ id: 's1', name: 'Strip 1', pixelCount: 2, pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
  showClips: [{ id: 'c', track: 0, patternId: 'aurora', start: 0, end: 1 }],
});
assert.equal(migratedV1.version, PROJECT_VERSION);
assert.equal(migratedV1.layout.strips.length, 1);
assert.equal(migratedV1.show.clips.length, 1);
const migratedV3 = migrateProject({
  version: PROJECT_VERSION,
  name: 'Hardware',
  devices: { wledIp: '192.168.4.22', segmentMap: { s1: 2 } },
});
assert.equal(migratedV3.devices.wledIp, '192.168.4.22');
assert.deepEqual(migratedV3.devices.segmentMap, { s1: 2 });
assert.deepEqual(migratedV3.devices.controllerProfiles, []);
assert.deepEqual(migratedV3.devices.physicalControls, DEFAULT_WLED_PHYSICAL_CONTROLS);
assert.equal(migratedV3.devices.standaloneController.outputs.length, 4);
assert.equal(migratedV3.pattern.symSettings.guide.mode, 'fold');
assert.equal(migrateProject({ version: PROJECT_VERSION, pattern: { motionSmoothing: 'silk' } }).pattern.motionSmoothing, 'silk');
assert.equal(migrateProject({ version: PROJECT_VERSION, pattern: { motionSmoothing: 'invalid' } }).pattern.motionSmoothing, 'soft');
assert.equal(migrateProject({ version: 2, motionSmoothing: 'off' }).pattern.motionSmoothing, 'off');
assert.equal(migrateProject({
  version: PROJECT_VERSION,
  devices: {
    standaloneController: {
      outputs: [{ id: 'outer', name: 'Outer', pin: 32, pixels: 144 }],
      controls: { blackout: 12 },
    },
  },
}).devices.standaloneController.controls.blackout, 12);

const guideAxis = { x1: 0.5, y1: 0, x2: 0.5, y2: 1 };
const guideFold = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } });
assert.equal(guideFold.x, 0.5);
assert.equal(guideFold.y, 0.4);
assert.equal(guideFold.progress, 0.5);
const guideReflectLeft = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'reflect', axis: guideAxis } });
assert.equal(guideReflectLeft.x, 0.5);
assert.equal(guideReflectLeft.y, 0.4);
const guideReflectRight = applySymmetry(0.75, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'reflect', axis: guideAxis } });
assert.equal(guideReflectRight.x, 0.5);
assert.equal(guideReflectRight.y, 0.4);
const guideSplit = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'split', axis: guideAxis } });
assert.equal(guideSplit.split, true);

const guideProgressFn = compile('return rgb(stripProgress, 0, 0);').fn;
const guideProgressFrame = renderPixelFrame({
  t: 0,
  strips: [{
    id: 'guide-strip',
    pts: [
      { x: 0, y: 0.5, p: 0 },
      { x: 0.5, y: 0.5, p: 0.5 },
      { x: 1, y: 0.5, p: 1 },
    ],
  }],
  activeFn: guideProgressFn,
  symSettings: { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } },
});
assert.deepEqual(guideProgressFrame.pixels.map(px => px.r), [255, 0, 255]);

const guideIndexFn = compile('return rgb(index / max(pixelCount - 1, 1), 0, 0);').fn;
const guideIndexFrame = renderPixelFrame({
  t: 0,
  strips: [{
    id: 'guide-index-strip',
    pts: [
      { x: 0, y: 0.5, p: 0 },
      { x: 0.5, y: 0.5, p: 0.5 },
      { x: 1, y: 0.5, p: 1 },
    ],
  }],
  activeFn: guideIndexFn,
  symSettings: { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } },
});
assert.deepEqual(guideIndexFrame.pixels.map(px => px.r), [255, 0, 255]);

const timelineClips = [
  { id: 'a', track: 0, patternId: 'aurora', start: 0, end: 10 },
  { id: 'b', track: 0, patternId: 'ember', start: 12, end: 22 },
  { id: 'c', track: 1, patternId: 'wave', start: 8, end: 18 },
];
assert.deepEqual(clampClipMove(timelineClips, 'a', 8, 40), { start: 2, end: 12 });
assert.deepEqual(clampClipMove(timelineClips, 'b', 1, 40), { start: 10, end: 20 });
assert.deepEqual(clampClipMove(timelineClips, 'c', 2, 40), { start: 2, end: 12 });
assert.deepEqual(clampClipResize(timelineClips, 'a', 'end', 16, 40), { start: 0, end: 12 });
assert.deepEqual(clampClipResize(timelineClips, 'b', 'start', 4, 40), { start: 10, end: 22 });
assert.deepEqual(
  placeClipInTrackGap(timelineClips, { track: 0, preferredStart: 9, duration: 30, showDuration: 40 }),
  { start: 22, end: 40 },
);
const overlappingTimelineClips = [
  { id: 'a', track: 0, patternId: 'calm', start: 0, end: 10 },
  { id: 'b', track: 0, patternId: 'aurora', start: 8, end: 18 },
];
assert.deepEqual(clampClipMove(overlappingTimelineClips, 'a', 4, 40), { start: 0, end: 10 });
assert.deepEqual(clampClipResize(overlappingTimelineClips, 'a', 'end', 14, 40), { start: 0, end: 10 });

const liveFirst = recordLivePattern({
  clips: [],
  transitions: [],
  patternId: 'aurora',
  at: 3.1,
  crossfadeSecs: 2,
  showDuration: 60,
});
assert.equal(liveFirst.clips.length, 1);
assert.deepEqual(liveFirst.clips[0], {
  id: 'live_3100_aurora',
  track: 0,
  patternId: 'aurora',
  start: 3.1,
  end: 60,
  label: 'aurora',
  recorded: true,
});
assert.deepEqual(liveFirst.transitions, []);

const liveSecond = recordLivePattern({
  clips: liveFirst.clips,
  transitions: liveFirst.transitions,
  patternId: 'ember',
  at: 10,
  crossfadeSecs: 3,
  showDuration: 60,
});
assert.equal(liveSecond.clips.find(c => c.patternId === 'aurora').end, 13);
assert.equal(liveSecond.clips.find(c => c.patternId === 'ember').start, 10);
assert.equal(liveSecond.clips.find(c => c.patternId === 'ember').end, 60);
assert.deepEqual(liveSecond.transitions, [{
  id: 'live_10000_ember_xfade',
  clipA: 'live_3100_aurora',
  clipB: 'live_10000_ember',
  type: 'crossfade',
  curve: 'ease-in-out',
  start: 10,
  end: 13,
  recorded: true,
}]);

const liveBeat = recordLivePattern({
  clips: [],
  transitions: [],
  patternId: 'wave',
  at: 10.31,
  bpm: 120,
  quantize: 'beat',
  crossfadeSecs: 1,
  showDuration: 60,
});
assert.equal(liveBeat.clips[0].start, 10.5);

const liveSameMoment = recordLivePattern({
  clips: liveFirst.clips,
  transitions: liveFirst.transitions,
  patternId: 'ember',
  at: 3.1,
  crossfadeSecs: 2,
  showDuration: 60,
});
assert.equal(liveSameMoment.clips.length, 2);
assert.equal(liveSameMoment.transitions.length, 1);
assert.equal(liveSameMoment.transitions[0].clipA, 'live_3100_aurora');
assert.equal(liveSameMoment.transitions[0].clipB, 'live_3100_ember');

const frame = renderPixelFrame({
  t: 0.2,
  strips: [{
    id: 's1',
    pts: [{ x: 0, y: 0, p: 0 }, { x: 1, y: 0, p: 1 }],
  }],
  patternId: 'aurora',
  paletteNorm: palette,
});
assert.equal(frame.pixels.length, 2);
assert.equal(frame.stripFrames.length, 1);
frame.pixels.forEach(px => {
  assert.ok(Number.isFinite(px.r) && Number.isFinite(px.g) && Number.isFinite(px.b));
});

assert.deepEqual(
  smoothPixelFrame([{ r: 100, g: 50, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'off', dt: 1 / 60 }),
  [{ r: 100, g: 50, b: 0 }],
);
const softFrame = smoothPixelFrame([{ r: 100, g: 0, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'soft', dt: 1 / 60 });
assert.ok(softFrame[0].r > 0 && softFrame[0].r < 100, 'soft smoothing moves toward target without overshoot');
const silkFrame = smoothPixelFrame([{ r: 100, g: 0, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'silk', dt: 1 / 60 });
assert.ok(silkFrame[0].r > 0 && silkFrame[0].r < softFrame[0].r, 'silk smoothing is slower than soft');
assert.deepEqual(
  smoothPixelFrame([{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }], [{ r: 0, g: 0, b: 0 }], { mode: 'silk', dt: 1 / 60 }),
  [{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }],
);
assert.equal(easeCrossfade(0, 'ease-in-out'), 0);
assert.equal(easeCrossfade(1, 'ease-in-out'), 1);
assert.equal(easeCrossfade(-1, 'ease-in-out'), 0);
assert.equal(easeCrossfade(2, 'ease-in-out'), 1);
assert.equal(easeCrossfade(0.5, 'linear'), 0.5);
assert.ok(easeCrossfade(0.25, 'ease-in-out') < 0.25);
assert.ok(easeCrossfade(0.75, 'ease-in-out') > 0.75);
assert.equal(formatMotionSpeed(0.03), '0.03x');
assert.equal(formatMotionSpeed(1), '1.0x');

assert.deepEqual(makeBlackoutFrame(2), [{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }]);
assert.deepEqual(makeBlackoutFrame(-1), []);
assert.deepEqual(makeWledFrameMessage([{ r: 1.2, g: 2.8, b: 300 }]).seg[0].i, ['0103FF']);
assert.deepEqual(makeWledFrameMessage([{ r: -5, g: Number.NaN, b: 12.4 }]).seg[0].i, ['00000C']);
assert.throws(
  () => makeWledFrameMessage([{ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }], { maxPixels: 1 }),
  /max 1/,
);
assert.deepEqual(makeWledSegments([{ id: 'a', pixels: [1, 2] }, { id: 'b', pixelCount: 3 }], { b: 4 }), [
  { id: 0, start: 0, stop: 2, on: true },
  { id: 4, start: 2, stop: 5, on: true },
]);
assert.deepEqual(makeWledSegments([{ id: 'z', pixelCount: 0 }, { id: 'a', pixelCount: 2 }, { id: 'b', pixels: [1, 2, 3] }], { z: 9, a: 2, b: 3 }), [
  { id: 9, start: 0, stop: 0, on: true },
  { id: 2, start: 0, stop: 2, on: true },
  { id: 3, start: 2, stop: 5, on: true },
]);

assert.equal(makeWledProxyUrl('http://192.168.1.50/json', 'state'), '/api/wled/state?ip=192.168.1.50');
assert.equal(makeWledWsUrl('192.168.1.50', { preferProxy: false }), 'ws://192.168.1.50/ws');
assert.equal(
  makeWledWsUrl('192.168.1.50', { locationObj: { protocol: 'https:', host: 'lightweaver.local' } }),
  'wss://lightweaver.local/api/wled/ws?ip=192.168.1.50',
);
assert.equal(DEFAULT_WLED_APP_FLASH_ADDRESS, '0x10000');
assert.deepEqual(validateFlashPlan({ address: '0x10000', eraseAll: false }), { address: 0x10000 });
assert.throws(
  () => validateFlashPlan({ address: '0x10000', eraseAll: true }),
  /single WLED app binary cannot be flashed after erasing all flash/,
);
assert.deepEqual(
  summarizeWledInfo({
    name: 'WLED',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    ip: '192.168.18.66',
    mac: 'aca704e2ece0',
    freeheap: 230000,
    psram: 8300000,
    wifi: { signal: 86 },
    leds: { count: 30, fps: 2 },
  }, { ip: '192.168.18.66', source: 'probe' }),
  {
    name: 'WLED',
    ip: '192.168.18.66',
    source: 'probe',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    mac: 'aca704e2ece0',
    leds: 30,
    fps: 2,
    signal: 86,
    freeheap: 230000,
    psram: 8300000,
    uptime: null,
    healthy: true,
  },
);
assert.equal(
  pickBestWledDevice([
    { ip: '192.168.18.10', source: 'scan', healthy: true },
    { ip: '192.168.18.66', source: 'default', healthy: true },
  ], '192.168.18.66').ip,
  '192.168.18.66',
);
assert.deepEqual(
  sortWledDevices([
    { ip: '192.168.18.10', source: 'scan', signal: 45, healthy: true },
    { ip: '192.168.18.11', source: 'mdns', signal: 80, healthy: true },
    { ip: '192.168.18.12', source: 'scan', healthy: false },
  ]).map(d => d.ip),
  ['192.168.18.11', '192.168.18.10', '192.168.18.12'],
);
assert.deepEqual(makeSafeWledTestState('blue'), {
  on: true,
  bri: 32,
  transition: 0,
  seg: [{ id: 0, fx: 0, col: [[0, 80, 255], [0, 0, 0], [0, 0, 0]] }],
});
const profile = buildControllerProfile({
  name: 'WLED',
  ver: '0.15.4',
  release: 'ESP32-S3_16MB_opi',
  arch: 'ESP32-S3',
  ip: '192.168.18.66',
  mac: 'aca704e2ece0',
  flash: 16,
  psram: 8300000,
  leds: { count: 30 },
}, {
  led: { type: 'WS2815', length: 240, dataPin: 16, colorOrder: 'GRB', maxBrightness: 180 },
  power: { voltage: 12, psuAmps: 10, milliampsPerPixel: 12 },
  artnet: { startUniverse: 0, fps: 40 },
});
assert.equal(profile.id, 'aca704e2ece0');
assert.equal(profile.physicalControls.encoder.enabled, true);
assert.equal(profile.physicalControls.encoder.firmware, WLED_ENCODER_FIRMWARE_MODES.ROTARY_USERMOD);
assert.deepEqual(profile.physicalControls.encoder.pins, { a: 4, b: 5, press: 0 });
assert.equal(makeWledHostname(profile), 'lightweaver-e2ece0.local');
assert.equal(makeDhcpReservationNote(profile), 'Reserve MAC ac:a7:04:e2:ec:e0 as 192.168.18.66.');
assert.deepEqual(estimatePowerBudget(profile), {
  maxAmps: 2.03,
  safeAmps: 8,
  headroomAmps: 5.97,
  status: 'ok',
});
assert.match(makeArtNetNotes(profile), /Universe start: 0/);
assert.match(makeArtNetNotes(profile), /Channels: 720/);
assert.equal(controllerProfileReadiness(profile).ready, false);
assert.deepEqual(makeKnownGoodRecoveryState(), makeSafeWledTestState('amber'));
assert.deepEqual(makePixelMarkerState(5, 4).seg[0].i, ['000000', '000000', '000000', '000000', 'FF4000']);
assert.deepEqual(makePixelCountProbeState(40, 39), {
  pixelCount: 40,
  markerIndex: 39,
  state: makePixelMarkerState(40, 39),
});
assert.deepEqual(makePixelCountProbeState(40, 60), {
  pixelCount: 40,
  markerIndex: 39,
  state: makePixelMarkerState(40, 39),
});
assert.deepEqual(makePixelCountProbeState(40.4, 38.6), {
  pixelCount: 40,
  markerIndex: 39,
  state: makePixelMarkerState(40, 39),
});
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /Lightweaver Install Readiness/);
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /aca704e2ece0/);
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /Physical Controls/);
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /Rotate: brightness/);

const controllerAudit = auditWledControllerCompatibility({
  info: {
    name: 'WLED',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    ip: '192.168.18.66',
    fxcount: 187,
    palcount: 71,
    time: '1970-1-2, 04:44:22',
    leds: { count: 30, maxseg: 32 },
  },
  state: {
    AudioReactive: { on: false },
    seg: [{ id: 0, start: 0, stop: 30, fx: 0, pal: 0 }],
  },
  cfg: {
    hw: { led: { total: 30, ins: [{ len: 30, pin: [16], order: 0, type: 22 }] } },
    if: { live: { en: true, port: 5568, dmx: { uni: 1, addr: 1, mode: 4 } } },
  },
  presets: { 0: {} },
  ledMap: null,
  expected: {
    pixelCount: 240,
    segmentCount: 4,
    requiresLedMap: true,
    requiresArtNet: true,
    usesAudioPatterns: true,
  },
});
assert.equal(controllerAudit.summary.status, 'needs-configuration');
assert.equal(controllerAudit.actual.ledCount, 30);
assert.equal(controllerAudit.actual.effectCount, 187);
assert.equal(controllerAudit.findings.find(item => item.id === 'firmware').level, CONTROLLER_COMPATIBILITY_LEVELS.READY);
assert.equal(controllerAudit.findings.find(item => item.id === 'led-count').level, CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG);
assert.equal(controllerAudit.findings.find(item => item.id === 'presets').level, CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_INSTALL);
assert.equal(controllerAudit.findings.find(item => item.id === 'led-map').level, CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG);
assert.equal(controllerAudit.findings.find(item => item.id === 'artnet').level, CONTROLLER_COMPATIBILITY_LEVELS.READY);
assert.equal(controllerAudit.findings.find(item => item.id === 'clock').level, CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG);
assert.equal(controllerAudit.findings.find(item => item.id === 'audio-source').level, CONTROLLER_COMPATIBILITY_LEVELS.RUNTIME_ONLY);
assert.equal(controllerAudit.runtimeGates.wledBasic.status, 'needs-install');
assert.equal(controllerAudit.runtimeGates.advancedArtNet.status, 'needs-configuration');

const blockedWizardPlan = buildWledInstallWizardPlan({
  controllerAudit,
  wledPackage: wledBasicPackage,
  backupSaved: false,
});
assert.equal(blockedWizardPlan.status, 'blocked');
assert.equal(blockedWizardPlan.canInstall, false);
assert.ok(blockedWizardPlan.blockers.includes('led-count'));
assert.equal(blockedWizardPlan.steps.find(step => step.id === 'backup').state, 'open');
assert.equal(blockedWizardPlan.steps.find(step => step.id === 'geometry').state, 'blocked');

const unauditedWizardPlan = buildWledInstallWizardPlan({
  controllerAudit: null,
  wledPackage: wledBasicPackage,
  backupSaved: true,
});
assert.equal(unauditedWizardPlan.status, 'blocked');
assert.equal(unauditedWizardPlan.canInstall, false);
assert.ok(unauditedWizardPlan.blockers.includes('controller-audit'));
assert.equal(unauditedWizardPlan.nextAction.id, 'run-controller-audit');

const readyControllerAudit = auditWledControllerCompatibility({
  info: {
    name: 'Lightweaver Bench',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    ip: '192.168.18.66',
    fxcount: 187,
    palcount: 71,
    time: '2026-5-25, 12:00:00',
    leds: { count: 3, maxseg: 32 },
  },
  state: { seg: [{ id: 0, start: 0, stop: 3 }] },
  cfg: { hw: { led: { total: 3, ins: [{ len: 3, pin: [16] }] } }, if: { live: { en: true, dmx: { uni: 1, addr: 1, mode: 4 } } } },
  presets: { 0: {} },
  expected: { pixelCount: 3, segmentCount: 1, requiresArtNet: false, requiresLedMap: false },
});
const readyWizardPlan = buildWledInstallWizardPlan({
  controllerAudit: readyControllerAudit,
  wledPackage: wledBasicPackage,
  backupSaved: true,
});
assert.equal(readyWizardPlan.status, 'ready-to-apply');
assert.equal(readyWizardPlan.canInstall, true);
assert.equal(readyWizardPlan.steps.find(step => step.id === 'package').state, 'ready');
assert.equal(readyWizardPlan.packageSummary.presets, wledBasicPackage.presets.length);
assert.equal(readyWizardPlan.packageSummary.customEffectPorts, wledBasicPackage.customEffectPorts.length);

const controlledBasicPackage = buildWledBasicPackage({
  projectName: 'Controlled Bench',
  activePatternId: 'candle',
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
  physicalControls: profile.physicalControls,
});
assert.equal(controlledBasicPackage.controlContract.encoder.enabled, true);
assert.equal(controlledBasicPackage.controlContract.encoder.press.helperPresetId, controlledBasicPackage.playlistPresetId + 1);
assert.equal(
  controlledBasicPackage.presetsJson[String(controlledBasicPackage.controlContract.encoder.press.helperPresetId)].ps,
  '1~ 8~',
);
assert.match(summarizeWledControlContract(controlledBasicPackage.controlContract), /WLED firmware/);

const orderedControlPackage = buildWledBasicPackage({
  projectName: 'Ordered Press Cycle',
  activePatternId: 'fire',
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
  physicalControls: {
    encoder: {
      enabled: true,
      rotateDirection: 'clockwise-dimmer',
      patternCycleIds: ['aurora', 'candle', 'breathe'],
    },
  },
});
assert.deepEqual(orderedControlPackage.presets.map(preset => preset.patternId), ['aurora', 'candle', 'breathe']);
assert.equal(orderedControlPackage.controlContract.controls.encoder.rotateDirection, 'clockwise-dimmer');
assert.equal(orderedControlPackage.controlContract.controls.encoder.patternCycleIds.length, 3);
assert.equal(
  orderedControlPackage.presetsJson[String(orderedControlPackage.controlContract.encoder.press.helperPresetId)].ps,
  '1~ 3~',
);

const controlledWizardPlan = buildWledInstallWizardPlan({
  controllerAudit: readyControllerAudit,
  wledPackage: controlledBasicPackage,
  backupSaved: true,
});
assert.equal(controlledWizardPlan.packageSummary.physicalControls.encoder, true);
assert.equal(controlledWizardPlan.packageSummary.physicalControls.helperPresetId, controlledBasicPackage.controlContract.encoder.press.helperPresetId);
assert.equal(controlledWizardPlan.steps.find(step => step.id === 'physical-controls').state, 'ready');
assert.match(controlledWizardPlan.steps.find(step => step.id === 'physical-controls').detail, /press preset/);

const standaloneOutputs = normalizeStandaloneOutputs([
  { id: 'outer', pin: 16, pixels: 260 },
  { id: 'inner', pin: 17, pixels: 180 },
  { id: '', pin: 18, pixels: -5 },
  { id: 'unused', pin: null, pixels: 0 },
  { id: 'ignored', pin: 21, pixels: 50 },
]);
assert.deepEqual(standaloneOutputs, [
  { id: 'outer', name: 'Outer', pin: 16, pixels: 260 },
  { id: 'inner', name: 'Inner', pin: 17, pixels: 180 },
]);
assert.deepEqual(deriveStandaloneOutputsFromStrips([
  { id: 'outer-zone', name: 'Outer Zone', pixels: [{}, {}, {}] },
  { id: 'inner-zone', name: 'Inner Zone', pixelCount: 2 },
], [
  { id: 'out1', pin: 16, pixels: 0 },
  { id: 'out2', pin: 17, pixels: 0 },
]), [
  { id: 'outer-zone', name: 'Outer Zone', pin: 16, pixels: 3 },
  { id: 'inner-zone', name: 'Inner Zone', pin: 17, pixels: 2 },
]);
assert.deepEqual(deriveStandaloneOutputsFromStrips([
  { id: 's1', pixelCount: 10 },
  { id: 's2', pixelCount: 10 },
  { id: 's3', pixelCount: 10 },
  { id: 's4', pixelCount: 10 },
  { id: 's5', pixelCount: 10 },
]), [
  { id: 'out1', name: 'Output 1', pin: 16, pixels: 20 },
  { id: 'out2', name: 'Output 2', pin: 17, pixels: 10 },
  { id: 'out3', name: 'Output 3', pin: 18, pixels: 10 },
  { id: 'out4', name: 'Output 4', pin: 21, pixels: 10 },
]);
assert.deepEqual(estimateLwseqBytes({ pixels: 440, fps: 24, duration: 10 }), {
  headerBytes: LWSEQ_HEADER_BYTES,
  payloadBytes: 316800,
  totalBytes: 316800 + LWSEQ_HEADER_BYTES,
});

const standaloneProfile = buildStandaloneProfile({
  projectName: 'Spiral 01',
  runtimeMode: 'procedural',
  outputs: standaloneOutputs,
  looks: [{ id: 'ember', label: 'Ember', mode: 'procedural', preset: 'ember', fps: 24 }],
});
assert.equal(standaloneProfile.piece.id, 'spiral-01');
assert.equal(standaloneProfile.runtimeMode, 'procedural');
assert.equal(standaloneProfile.outputs.length, 2);
assert.equal(standaloneProfile.controls.encoder.press, 6);
assert.equal(standaloneProfile.startupLook, 'ember');
assert.equal(standaloneProfile.looks[0].preset, 'ember');

const lwseq = toLwseqBytes([
  [{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }],
  [{ r: 7, g: 8, b: 9 }, { r: 10, g: 11, b: 12 }],
], { fps: 24, outputs: [{ id: 'main', pin: 16, pixels: 2 }] });
assert.equal(lwseq.byteLength, LWSEQ_HEADER_BYTES + 12);
assert.equal(String.fromCharCode(...lwseq.slice(0, 6)), 'LWSEQ1');
assert.deepEqual([...lwseq.slice(LWSEQ_HEADER_BYTES)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const standalonePackage = makeStandalonePackage({
  projectName: 'Spiral 01',
  outputs: [{ id: 'main', pin: 16, pixels: 1 }],
  sequenceFilename: '001-ember.lwseq',
  frames: [[{ r: 1, g: 2, b: 3 }]],
  fps: 24,
});
assert.equal(standalonePackage.files['/lightweaver.json'].piece.name, 'Spiral 01');
assert.equal(standalonePackage.files['/sequences/001-ember.lwseq'].encoding, 'base64');
assert.equal(standalonePackage.files['/sequences/001-ember.lwseq'].bytes, LWSEQ_HEADER_BYTES + 3);

const proceduralPackage = makeStandalonePackage({
  projectName: 'Spiral 01',
  runtimeMode: 'procedural',
  outputs: [{ id: 'main', pin: 16, pixels: 12 }],
  proceduralPreset: 'aurora',
  frames: [[{ r: 255, g: 0, b: 0 }]],
});
assert.equal(proceduralPackage.files['/lightweaver.json'].runtimeMode, 'procedural');
assert.equal(proceduralPackage.files['/lightweaver.json'].looks[0].mode, 'procedural');
assert.equal(proceduralPackage.files['/lightweaver.json'].looks[0].preset, 'aurora');
assert.equal(Object.keys(proceduralPackage.files).length, 1);

const presetPackage = makeStandalonePackage({
  projectName: 'Spiral 01',
  runtimeMode: 'preset',
  outputs: [{ id: 'main', pin: 16, pixels: 12 }],
  preset: 'warm-white',
});
assert.equal(presetPackage.files['/lightweaver.json'].runtimeMode, 'preset');
assert.equal(presetPackage.files['/lightweaver.json'].looks[0].mode, 'preset');
assert.equal(presetPackage.files['/lightweaver.json'].looks[0].preset, 'warm-white');
assert.equal(Object.keys(presetPackage.files).length, 1);

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

{
  const calls = [];
  const data = await requestWledJson('192.168.1.51', 'state', {
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method });
      return jsonResponse(200, { on: true });
    },
  });
  assert.deepEqual(data, { on: true });
  assert.equal(calls[0].url, '/api/wled/state?ip=192.168.1.51');
}

{
  const calls = [];
  const data = await requestWledJson('192.168.1.52', 'info', {
    fetchImpl: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? textResponse(200, '<!doctype html><div>Vite fallback</div>')
        : jsonResponse(200, { ver: '0.15.4' });
    },
  });
  assert.deepEqual(data, { ver: '0.15.4' });
  assert.deepEqual(calls, ['/api/wled/info?ip=192.168.1.52', 'http://192.168.1.52/json/info']);
}

{
  let calls = 0;
  await assert.rejects(
    () => requestWledJson('192.168.1.53', 'state', {
      method: 'POST',
      body: { on: false },
      fetchImpl: async () => {
        calls++;
        return jsonResponse(500, { error: 'state rejected' });
      },
    }),
    /HTTP 500/,
  );
  assert.equal(calls, 1, 'Pi API WLED failures should not be hidden by direct fallback');
}

{
  await assert.rejects(
    () => requestWledJson('192.168.1.54', 'state', {
      method: 'POST',
      body: { on: true },
      preferProxy: false,
      fetchImpl: async () => jsonResponse(503, { error: 'offline' }),
    }),
    /HTTP 503/,
  );
}

console.log('project-frame-audit passed');
