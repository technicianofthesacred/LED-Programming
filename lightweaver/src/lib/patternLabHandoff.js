import { hexToCardColor, normalizeCardVisualLook } from './cardVisualLook.js';
import {
  MAX_PATTERN_LAB_LWSEQ_BYTES,
  canonicalPatternLabBakeJson,
} from './lwseqBake.js';
import {
  PATTERN_LAB_COMPATIBILITY_CLASSIFICATIONS,
  PATTERN_LAB_COMPATIBILITY_VERSION,
} from './patternLabCompatibility.js';
import { resolvePatternLabMacros } from './patternLabMacros.js';
import { normalizePatternLabRecipe } from './patternLabRecipe.js';
import { isBuiltInPattern } from './patternRegistry.js';
import { MAX_SAVED_LOOKS, normalizeSavedLooks } from './sectionLookModel.js';
import {
  LWSEQ_HEADER_BYTES,
  buildStandaloneProfile,
  normalizeStandaloneOutputs,
} from './standaloneController.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEQUENCE_FILE_PATTERN = /^\/sequences\/[a-z0-9]+(?:-[a-z0-9]+)*\.lwseq$/;
const MAX_ID_LENGTH = 80;
const MAX_LABEL_LENGTH = 160;
const REQUIRED_BUDGET_KEYS = Object.freeze([
  'pixelCount',
  'fps',
  'operationsPerFrame',
  'stateBytes',
  'framebufferBytes',
  'nativeConfigBytes',
  'lwseqBytes',
  'microSdBytes',
]);
const BUDGET_STATUSES = new Set(['unknown', 'invalid', 'too-low', 'over-limit', 'fits']);

export const MAX_PATTERN_LAB_SEQUENCE_ASSETS = 12;

function clone(value) {
  return structuredClone(value);
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, maximum) {
  return String(value || '').trim().slice(0, maximum);
}

function slug(value, fallback = 'pattern-lab-asset') {
  return boundedString(value || fallback, MAX_ID_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function blocked(code, message, detail = null) {
  return {
    kind: 'blocked',
    reasons: [{ code, message, ...(detail ? { detail: boundedString(detail, 300) } : {}) }],
  };
}

function validCompatibility(value) {
  return record(value)
    && value.version === PATTERN_LAB_COMPATIBILITY_VERSION
    && PATTERN_LAB_COMPATIBILITY_CLASSIFICATIONS.includes(value.classification)
    && record(value.descriptor)
    && typeof value.descriptor.id === 'string'
    && value.descriptor.id.length > 0
    && value.descriptor.id.length <= MAX_ID_LENGTH
    && Number.isSafeInteger(value.descriptor.version)
    && value.descriptor.version > 0
    && record(value.budgets)
    && REQUIRED_BUDGET_KEYS.every(key => validBudget(value.budgets[key], key === 'microSdBytes'))
    && Array.isArray(value.reasons)
    && value.reasons.every(reason => record(reason)
      && typeof reason.code === 'string'
      && reason.code.length > 0
      && typeof reason.message === 'string'
      && reason.message.length > 0)
    && Array.isArray(value.actions)
    && value.actions.every(action => record(action)
      && typeof action.id === 'string'
      && action.id.length > 0
      && typeof action.label === 'string'
      && action.label.length > 0
      && typeof action.kind === 'string'
      && action.kind.length > 0);
}

function validBudget(value, storage = false) {
  if (!record(value)
    || typeof value.known !== 'boolean'
    || typeof value.ok !== 'boolean'
    || !BUDGET_STATUSES.has(value.status)) return false;
  const used = storage ? value.required : value.used;
  const limit = storage ? value.available : value.limit;
  return (used === null || (Number.isSafeInteger(used) && used >= 0))
    && Number.isSafeInteger(limit)
    && limit >= 0
    && value.known === (used !== null)
    && value.ok === (value.status === 'fits');
}

function lookFromRecipe(recipe) {
  const technical = resolvePatternLabMacros(recipe);
  const paletteColor = recipe.palette[Math.min(recipe.palette.length - 1, Math.floor(recipe.palette.length / 2))];
  const color = hexToCardColor(paletteColor);
  const defaultLook = normalizeCardVisualLook({
    patternId: recipe.base.patternId,
    brightness: technical.energy.brightness,
    speed: technical.movement.speedMultiplier,
    hueShift: Math.round(technical.color.warmth * 18),
    customHue: color.customHue,
    customSaturation: Math.round(technical.color.saturation * 255),
  });
  const sectionLooks = Object.fromEntries((recipe.targets || [])
    .filter(target => target?.kind === 'section' && String(target.id || '').trim())
    .map(target => [slug(target.id), defaultLook]));
  return normalizeSavedLooks([{
    id: slug(recipe.name),
    label: boundedString(recipe.name, MAX_LABEL_LENGTH),
    defaultLook,
    sectionLooks,
    updatedAt: 0,
  }])[0];
}

function uniqueId(preferred, used) {
  const base = slug(preferred);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate) || isBuiltInPattern(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function validPositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function normalizeManifest(value) {
  if (!record(value)
    || value.format !== 'lightweaver-lwseq-sidecar'
    || value.version !== 1
    || value.hashAlgorithm !== 'SHA-256'
    || !SHA256_PATTERN.test(value.recipeSha256)
    || !SHA256_PATTERN.test(value.layoutPhysicalOrderSha256)
    || !(value.audioLanesSha256 === null || SHA256_PATTERN.test(value.audioLanesSha256))
    || !validPositiveInteger(value.fps, 24)
    || !validPositiveInteger(value.frameCount, 24 * 60 * 15)
    || !validPositiveInteger(value.pixelCount, 4096)
    || !Number.isSafeInteger(value.seed)
    || !SHA256_PATTERN.test(value.lwseqSha256)) {
    return null;
  }
  return {
    format: 'lightweaver-lwseq-sidecar',
    version: 1,
    hashAlgorithm: 'SHA-256',
    recipeSha256: value.recipeSha256,
    layoutPhysicalOrderSha256: value.layoutPhysicalOrderSha256,
    audioLanesSha256: value.audioLanesSha256,
    fps: value.fps,
    frameCount: value.frameCount,
    pixelCount: value.pixelCount,
    seed: value.seed,
    lwseqSha256: value.lwseqSha256,
  };
}

function normalizeAssetOutputs(value, expectedPixels) {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 4
    || value.some(output => !record(output)
      || typeof output.id !== 'string'
      || output.id.length < 1
      || output.id.length > MAX_ID_LENGTH
      || typeof output.name !== 'string'
      || output.name.length < 1
      || output.name.length > MAX_LABEL_LENGTH
      || !Number.isSafeInteger(output.pin)
      || !validPositiveInteger(output.pixels, 1024))) return null;
  const outputs = normalizeStandaloneOutputs(value).map(output => ({
    id: slug(output.id, 'output'),
    name: boundedString(output.name, MAX_LABEL_LENGTH),
    pin: output.pin,
    pixels: output.pixels,
  }));
  if (outputs.length !== value.length
    || outputs.reduce((sum, output) => sum + output.pixels, 0) !== expectedPixels) return null;
  return outputs;
}

function sequenceLook(asset) {
  return {
    id: asset.id,
    label: asset.label,
    mode: 'sequence',
    file: asset.file,
    fps: asset.manifest.fps,
    loop: true,
  };
}

function normalizeSequenceAsset(value) {
  if (!record(value) || value.version !== 1 || value.format !== 'lwseq') return null;
  const id = slug(value.id, '');
  const label = boundedString(value.label, MAX_LABEL_LENGTH);
  const manifest = normalizeManifest(value.manifest);
  if (!id || !label || !manifest) return null;
  const file = boundedString(value.file, 160);
  const sidecarFile = boundedString(value.sidecarFile, 170);
  const byteLength = Number(value.byteLength);
  const expectedBytes = LWSEQ_HEADER_BYTES + manifest.pixelCount * manifest.frameCount * 3;
  const recipeId = boundedString(value.recipe?.id, MAX_ID_LENGTH);
  const recipeName = boundedString(value.recipe?.name, MAX_LABEL_LENGTH);
  const outputs = normalizeAssetOutputs(value.outputs, manifest.pixelCount);
  if (id !== value.id
    || !SEQUENCE_FILE_PATTERN.test(file)
    || sidecarFile !== `${file}.json`
    || value.assetRef !== `sha256:${manifest.lwseqSha256}`
    || byteLength !== expectedBytes
    || byteLength > MAX_PATTERN_LAB_LWSEQ_BYTES
    || !recipeId
    || !recipeName
    || value.recipe?.sha256 !== manifest.recipeSha256
    || !outputs) return null;
  const asset = {
    version: 1,
    id,
    label,
    format: 'lwseq',
    assetRef: value.assetRef,
    file,
    sidecarFile,
    byteLength,
    recipe: { id: recipeId, name: recipeName, sha256: manifest.recipeSha256 },
    outputs,
    manifest,
  };
  asset.look = sequenceLook(asset);
  return asset;
}

export function normalizePatternLabSequenceAssets(values = []) {
  if (!Array.isArray(values)) return [];
  const normalized = [];
  const used = new Set();
  for (const value of values) {
    let asset = null;
    try {
      asset = normalizeSequenceAsset(value);
    } catch {
      asset = null;
    }
    if (!asset || used.has(asset.id)) continue;
    used.add(asset.id);
    normalized.push(asset);
    if (normalized.length === MAX_PATTERN_LAB_SEQUENCE_ASSETS) break;
  }
  return normalized;
}

async function sha256Hex(bytes) {
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.subtle?.digest) throw new Error('Secure SHA-256 hashing is unavailable');
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function assertHeader(bytes, manifest, outputCount) {
  if (bytes.byteLength !== LWSEQ_HEADER_BYTES + manifest.pixelCount * manifest.frameCount * 3) {
    throw new RangeError('LWSEQ byte length does not match its sidecar');
  }
  if (String.fromCharCode(...bytes.subarray(0, 6)) !== 'LWSEQ1') throw new TypeError('LWSEQ header is missing');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint16(8, true) !== 1
    || header.getUint16(10, true) !== outputCount
    || header.getUint32(12, true) !== manifest.pixelCount
    || header.getUint32(16, true) !== manifest.frameCount
    || header.getUint16(20, true) !== manifest.fps
    || header.getUint16(22, true) !== 3) {
    throw new TypeError('LWSEQ header does not match its canonical bake metadata');
  }
}

function staleRecipeError() {
  const error = new Error('The baked sequence belongs to a different Pattern Lab recipe.');
  error.code = 'bake-stale-recipe';
  return error;
}

async function validateBakeResult(bakeResult, normalizedRecipe) {
  if (!record(bakeResult)) throw new TypeError('A complete Pattern Lab bake result is required');
  if (!(bakeResult.bytes instanceof Uint8Array)
    || !record(bakeResult.sidecar)
    || typeof bakeResult.sidecarJson !== 'string'
    || !record(bakeResult.recipe)
    || !record(bakeResult.estimate)) {
    throw new TypeError('The Pattern Lab bake result is incomplete');
  }
  const normalizedBakedRecipe = normalizePatternLabRecipe(bakeResult.recipe);
  const expectedRecipeJson = canonicalPatternLabBakeJson(normalizedRecipe);
  if (canonicalPatternLabBakeJson(normalizedBakedRecipe) !== expectedRecipeJson) throw staleRecipeError();
  const manifest = normalizeManifest(bakeResult.sidecar);
  if (!manifest || canonicalPatternLabBakeJson(manifest) !== bakeResult.sidecarJson) {
    throw new TypeError('The Pattern Lab bake sidecar is not canonical');
  }
  const outputs = normalizeAssetOutputs(bakeResult.outputs, manifest.pixelCount);
  if (!outputs) throw new TypeError('The Pattern Lab bake outputs are incomplete');
  assertHeader(bakeResult.bytes, manifest, outputs.length);
  const expectedBytes = bakeResult.bytes.byteLength;
  if (bakeResult.estimate.totalBytes !== expectedBytes
    || bakeResult.estimate.headerBytes !== LWSEQ_HEADER_BYTES
    || bakeResult.estimate.payloadBytes !== expectedBytes - LWSEQ_HEADER_BYTES
    || bakeResult.estimate.pixelCount !== manifest.pixelCount
    || bakeResult.estimate.frameCount !== manifest.frameCount
    || bakeResult.estimate.fps !== manifest.fps
    || typeof bakeResult.estimate.durationSeconds !== 'number'
    || !Number.isFinite(bakeResult.estimate.durationSeconds)
    || bakeResult.estimate.durationSeconds <= 0
    || bakeResult.estimate.durationSeconds > 15 * 60
    || Math.round(bakeResult.estimate.durationSeconds * manifest.fps) !== manifest.frameCount
    || typeof bakeResult.estimate.estimatedRenderMilliseconds !== 'number'
    || !Number.isFinite(bakeResult.estimate.estimatedRenderMilliseconds)
    || bakeResult.estimate.estimatedRenderMilliseconds < 0
    || !Number.isSafeInteger(bakeResult.estimate.maxBytes)
    || bakeResult.estimate.maxBytes < expectedBytes
    || bakeResult.estimate.maxBytes > MAX_PATTERN_LAB_LWSEQ_BYTES
    || manifest.seed !== normalizedRecipe.seed) {
    throw new TypeError('The Pattern Lab bake estimate does not match its sidecar');
  }
  const [recipeSha256, lwseqSha256] = await Promise.all([
    sha256Hex(new TextEncoder().encode(expectedRecipeJson)),
    sha256Hex(bakeResult.bytes),
  ]);
  if (recipeSha256 !== manifest.recipeSha256) throw staleRecipeError();
  if (lwseqSha256 !== manifest.lwseqSha256) throw new TypeError('The Pattern Lab LWSEQ hash does not match its sidecar');
  return { bytes: bakeResult.bytes, manifest, outputs };
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function makeSequenceResult({ normalizedRecipe, verified, controller, id }) {
  const label = boundedString(normalizedRecipe.name, MAX_LABEL_LENGTH) || 'Pattern Lab sequence';
  const file = `/sequences/${id}.lwseq`;
  const sidecarFile = `${file}.json`;
  const asset = normalizeSequenceAsset({
    version: 1,
    id,
    label,
    format: 'lwseq',
    assetRef: `sha256:${verified.manifest.lwseqSha256}`,
    file,
    sidecarFile,
    byteLength: verified.bytes.byteLength,
    recipe: {
      id: boundedString(normalizedRecipe.id, MAX_ID_LENGTH),
      name: label,
      sha256: verified.manifest.recipeSha256,
    },
    outputs: verified.outputs,
    manifest: verified.manifest,
  });
  if (!asset) throw new TypeError('The Pattern Lab sequence metadata is invalid');
  const profile = buildStandaloneProfile({
    projectName: label,
    runtimeMode: 'sequence',
    outputs: verified.outputs,
    controls: controller?.controls,
    led: controller?.led,
    looks: [asset.look],
  });
  profile.runtimeMode = 'sd-sequence';
  const sequenceFile = {
    encoding: 'base64',
    bytes: verified.bytes.byteLength,
    data: bytesToBase64(verified.bytes),
  };
  const packageValue = {
    app: 'Lightweaver',
    format: 'standalone-controller-package',
    version: 1,
    files: {
      '/lightweaver.json': profile,
      [file]: sequenceFile,
      [sidecarFile]: `${canonicalPatternLabBakeJson(verified.manifest)}\n`,
    },
  };
  return {
    kind: 'sequence',
    package: packageValue,
    manifest: clone(verified.manifest),
    asset,
    look: clone(asset.look),
  };
}

export async function createPatternLabHandoff({
  recipe,
  compatibility,
  bakeResult = null,
  controller = null,
  cancelled = false,
  exportError = null,
} = {}) {
  if (cancelled) return blocked('cancelled', 'Use in Project was canceled.');
  if (exportError) return blocked('export-failed', 'The Pattern Lab export did not finish.', exportError.message || exportError);
  if (compatibility == null) {
    return blocked('compatibility-missing', 'Run card compatibility before using this pattern in the project.');
  }
  if (!validCompatibility(compatibility)) {
    return blocked('compatibility-invalid', 'The card compatibility result is malformed or from an unsupported version.');
  }
  let normalized;
  try {
    normalized = normalizePatternLabRecipe(recipe);
  } catch (error) {
    return blocked('recipe-invalid', 'The Pattern Lab recipe is invalid.', error.message || error);
  }

  if (compatibility.classification === 'live-on-card') {
    if (normalized.base.kind !== 'lightweaver-pattern' || !isBuiltInPattern(normalized.base.patternId)) {
      return blocked('look-unsupported', 'This recipe cannot become a native card look.');
    }
    if (normalized.evolution?.enabled === true || normalized.layers.length > 0) {
      return blocked('look-unsupported', 'Evolution and layered Pattern Lab recipes must remain baked sequences.');
    }
    const existing = normalizeSavedLooks(controller?.looks);
    if (existing.length >= MAX_SAVED_LOOKS) {
      return blocked('look-capacity', `The card already has the maximum of ${MAX_SAVED_LOOKS} saved looks.`);
    }
    const look = lookFromRecipe(normalized);
    look.id = uniqueId(look.label || look.id, new Set(existing.map(item => item.id)));
    return { kind: 'look', look };
  }

  if (compatibility.classification === 'bake-to-card') {
    const existing = normalizePatternLabSequenceAssets(controller?.sequenceAssets);
    if (existing.length >= MAX_PATTERN_LAB_SEQUENCE_ASSETS) {
      return blocked('sequence-capacity', `The project already has the maximum of ${MAX_PATTERN_LAB_SEQUENCE_ASSETS} sequence assets.`);
    }
    if (!bakeResult) return blocked('bake-required', 'Bake the complete sequence before adding it to the project.');
    try {
      const verified = await validateBakeResult(bakeResult, normalized);
      const id = uniqueId(normalized.name, new Set(existing.map(asset => asset.id)));
      return makeSequenceResult({ normalizedRecipe: normalized, verified, controller, id });
    } catch (error) {
      if (error?.code === 'bake-stale-recipe') {
        return blocked('bake-stale-recipe', 'Bake this exact recipe again before adding it to the project.');
      }
      return blocked('bake-invalid', 'The baked sequence result is incomplete or invalid.', error.message || error);
    }
  }

  const reasons = compatibility.reasons.length
    ? clone(compatibility.reasons)
    : [{ code: 'unsupported', message: 'This recipe does not have a safe project handoff yet.' }];
  return { kind: 'blocked', reasons };
}

function base64ToBytes(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length % 4 !== 0) return null;
  let bytes;
  try {
    if (typeof Buffer !== 'undefined') bytes = new Uint8Array(Buffer.from(value, 'base64'));
    else {
      const binary = atob(value);
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    }
  } catch {
    return null;
  }
  return bytesToBase64(bytes) === value ? bytes : null;
}

async function validSequenceResult(result) {
  try {
    if (!record(result) || !record(result.package) || !record(result.manifest)) return null;
    const asset = normalizeSequenceAsset(result.asset);
    if (!asset
      || canonicalPatternLabBakeJson(result.manifest) !== canonicalPatternLabBakeJson(asset.manifest)
      || canonicalPatternLabBakeJson(result.look) !== canonicalPatternLabBakeJson(asset.look)
      || result.package.app !== 'Lightweaver'
      || result.package.format !== 'standalone-controller-package'
      || result.package.version !== 1
      || !record(result.package.files)
      || !record(result.package.files['/lightweaver.json'])) return null;
    const binary = result.package.files[asset.file];
    const profile = result.package.files['/lightweaver.json'];
    const profileLook = Array.isArray(profile.looks) ? profile.looks[0] : null;
    const profileOutputs = normalizeAssetOutputs(profile.outputs, asset.manifest.pixelCount);
    if (!record(binary)
      || binary.encoding !== 'base64'
      || binary.bytes !== asset.byteLength
      || typeof binary.data !== 'string'
      || result.package.files[asset.sidecarFile] !== `${canonicalPatternLabBakeJson(asset.manifest)}\n`
      || profile.version !== 1
      || profile.runtimeMode !== 'sd-sequence'
      || profile.startupLook !== asset.id
      || !record(profileLook)
      || profileLook.id !== asset.id
      || profileLook.label !== asset.label
      || profileLook.mode !== 'sequence'
      || profileLook.file !== asset.file
      || profileLook.fps !== asset.manifest.fps
      || profileLook.loop !== true
      || !profileOutputs
      || canonicalPatternLabBakeJson(profileOutputs) !== canonicalPatternLabBakeJson(asset.outputs)) return null;
    const bytes = base64ToBytes(binary.data);
    if (!bytes
      || bytes.byteLength !== asset.byteLength
      || await sha256Hex(bytes) !== asset.manifest.lwseqSha256) return null;
    return asset;
  } catch {
    return null;
  }
}

export async function applyPatternLabHandoff(controller = {}, result = {}) {
  if (!result || result.kind === 'blocked') return controller;
  const source = clone(controller || {});
  if (result.kind === 'look') {
    const existing = normalizeSavedLooks(source.looks);
    if (existing.length >= MAX_SAVED_LOOKS) return controller;
    const normalized = normalizeSavedLooks([result.look])[0];
    if (!normalized || existing.some(look => look.id === normalized.id) || isBuiltInPattern(normalized.id)) return controller;
    return {
      ...source,
      defaultLook: clone(normalized.defaultLook),
      activeLookId: normalized.id,
      looks: [normalized, ...existing],
    };
  }
  if (result.kind === 'sequence') {
    const existing = normalizePatternLabSequenceAssets(source.sequenceAssets);
    if (existing.length >= MAX_PATTERN_LAB_SEQUENCE_ASSETS) return controller;
    const asset = await validSequenceResult(result);
    if (!asset || existing.some(item => item.id === asset.id)) return controller;
    return {
      ...source,
      activeSequenceAssetId: asset.id,
      sequenceAssets: [asset, ...existing],
    };
  }
  return controller;
}
