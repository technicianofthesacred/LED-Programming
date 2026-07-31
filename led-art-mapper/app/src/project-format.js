export const MAPPER_PROJECT_FORMAT = 'lightweaver.mapper-project';
export const MAPPER_PROJECT_SCHEMA_VERSION = 3;
export const MAPPER_MAX_PROJECT_JSON_BYTES = 5 * 1024 * 1024;
export const MAPPER_MAX_SVG_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAPPER_MAX_PATTERN_FILE_BYTES = 64 * 1024;
export const MAPPER_MAX_STRIPS = 256;
export const MAPPER_MAX_LEDS_PER_STRIP = 4096;
export const MAPPER_MAX_TOTAL_LEDS = 16384;
export const MAPPER_MAX_PATH_DATA_CHARS = 64 * 1024;
export const MAPPER_MAX_TOTAL_PATH_DATA_CHARS = 1024 * 1024;

const MAX_TEXT_CHARS = 160;
const MAX_ID_CHARS = 128;
const MAX_PATTERNS = 256;
const MAX_PATTERN_CODE_CHARS = MAPPER_MAX_PATTERN_FILE_BYTES;
const MAX_TOTAL_PATTERN_CODE_CHARS = 2 * 1024 * 1024;
const MAX_SVG_ELEMENTS = 10000;
const MAX_GROUPS = 256;
const MAX_SCENES = 256;
const MAX_CONNECTIONS = 512;
const DEFAULT_STRIP_COLOR = '#06d6a0';
const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SAFE_SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask',
  'title', 'desc', 'text', 'tspan',
]);
const SAFE_SVG_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'id', 'class', 'data-name',
  'viewbox', 'preserveaspectratio', 'transform',
  'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'display', 'visibility',
  'clip-path', 'mask',
  'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'fr',
  'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor',
  'href', 'xlink:href', 'style',
]);
const SAFE_SVG_STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'display', 'visibility', 'clip-path', 'mask',
  'stop-color', 'stop-opacity',
  'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor',
]);

function sanitizeMapperStrips(strips) {
  if (!Array.isArray(strips)) {
    return { ok: false, reason: 'This LED Mapper project has no valid section list.' };
  }
  if (strips.length > MAPPER_MAX_STRIPS) {
    return { ok: false, reason: `This LED Mapper project exceeds the ${MAPPER_MAX_STRIPS}-section limit.` };
  }

  const ids = new Set();
  const sanitized = [];
  let totalLeds = 0;
  let totalPathDataChars = 0;
  for (let index = 0; index < strips.length; index += 1) {
    const strip = strips[index];
    const section = `Section ${index + 1}`;
    if (!strip || typeof strip !== 'object' || Array.isArray(strip)) {
      return { ok: false, reason: `${section} must be an object.` };
    }

    const id = sanitizeId(strip.id);
    if (!id) return { ok: false, reason: `${section} has an invalid id.` };

    const pathData = typeof strip.pathData === 'string' ? strip.pathData.trim() : '';
    if (!pathData) return { ok: false, reason: `${section} has invalid path data.` };
    if (pathData.length > MAPPER_MAX_PATH_DATA_CHARS) {
      return { ok: false, reason: `${section} path data exceeds the import size limit.` };
    }
    totalPathDataChars += pathData.length;
    if (totalPathDataChars > MAPPER_MAX_TOTAL_PATH_DATA_CHARS) {
      return { ok: false, reason: 'Combined section path data exceeds the import size limit.' };
    }

    if (
      !Number.isSafeInteger(strip.pixelCount)
      || strip.pixelCount <= 0
      || strip.pixelCount > MAPPER_MAX_LEDS_PER_STRIP
    ) {
      return { ok: false, reason: `${section} has an invalid LED count.` };
    }
    totalLeds += strip.pixelCount;
    if (totalLeds > MAPPER_MAX_TOTAL_LEDS) {
      return { ok: false, reason: `Project total LED count exceeds ${MAPPER_MAX_TOTAL_LEDS}.` };
    }

    if (ids.has(id)) {
      return { ok: false, reason: `Duplicate section id "${id}" is not allowed.` };
    }
    ids.add(id);
    const sanitizedStrip = {
      id,
      name: boundedText(strip.name, `Section ${index + 1}`),
      pathData,
      pixelCount: strip.pixelCount,
      color: sanitizeColor(strip.color, DEFAULT_STRIP_COLOR),
    };
    copyBoolean(sanitizedStrip, strip, 'visible');
    copyBoolean(sanitizedStrip, strip, 'reversed');
    copyFiniteNumber(sanitizedStrip, strip, 'speed', 0, 8);
    copyFiniteNumber(sanitizedStrip, strip, 'brightness', 0, 1);
    copyFiniteNumber(sanitizedStrip, strip, 'hueShift', -180, 180);
    copyFiniteNumber(sanitizedStrip, strip, 'svgLength', 0, 1e9);
    copyFiniteNumber(sanitizedStrip, strip, 'offsetX', -1e6, 1e6);
    copyFiniteNumber(sanitizedStrip, strip, 'offsetY', -1e6, 1e6);
    copyFiniteNumber(sanitizedStrip, strip, 'emitAngle', -360, 360);
    copyFiniteNumber(sanitizedStrip, strip, 'ledsPerMeter', 1, 1000);
    if (strip.patternId === null) sanitizedStrip.patternId = null;
    else if (typeof strip.patternId === 'string' && strip.patternId.length <= MAX_ID_CHARS) {
      sanitizedStrip.patternId = strip.patternId;
    }
    sanitized.push(sanitizedStrip);
  }

  return { ok: true, strips: sanitized };
}

function sanitizePatterns(patterns, fieldName) {
  if (patterns === undefined) return { ok: true, patterns: undefined };
  if (!Array.isArray(patterns) || patterns.length > MAX_PATTERNS) {
    return { ok: false, reason: `${fieldName} has an invalid or oversized pattern list.` };
  }

  const ids = new Set();
  const sanitized = [];
  let totalCodeChars = 0;
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) {
      return { ok: false, reason: `${fieldName} pattern ${index + 1} must be an object.` };
    }
    const id = sanitizeId(pattern.id);
    if (!id) return { ok: false, reason: `${fieldName} pattern ${index + 1} has an invalid id.` };
    if (ids.has(id)) return { ok: false, reason: `Duplicate pattern id "${id}" is not allowed.` };
    ids.add(id);

    const code = pattern.code === undefined
      ? 'return { r: 0, g: 0, b: 0 };'
      : typeof pattern.code === 'string' ? pattern.code : '';
    if (!code || code.length > MAX_PATTERN_CODE_CHARS) {
      return { ok: false, reason: `${fieldName} pattern ${index + 1} has invalid or oversized code.` };
    }
    totalCodeChars += code.length;
    if (totalCodeChars > MAX_TOTAL_PATTERN_CODE_CHARS) {
      return { ok: false, reason: `${fieldName} pattern code exceeds the import size limit.` };
    }

    const cleanPattern = {
      id,
      name: boundedText(pattern.name, id),
      code,
    };
    if (typeof pattern.desc === 'string') cleanPattern.desc = boundedText(pattern.desc, '', 500);
    if (typeof pattern.category === 'string') cleanPattern.category = boundedText(pattern.category, '', 80);
    if (isSafeCssPreview(pattern.preview)) cleanPattern.preview = pattern.preview;
    sanitized.push(cleanPattern);
  }
  return { ok: true, patterns: sanitized };
}

function sanitizeProjectFields(project, strips) {
  const sanitized = {
    ...(project.format === MAPPER_PROJECT_FORMAT
      ? { format: MAPPER_PROJECT_FORMAT, schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION }
      : {}),
    version: Number.isSafeInteger(project.version) ? project.version : 3,
    strips,
  };

  if (project.svgSource === null) sanitized.svgSource = null;
  else if (project.svgSource !== undefined) {
    if (
      typeof project.svgSource !== 'string'
      || !isMapperTextWithinLimit(project.svgSource, MAPPER_MAX_SVG_SOURCE_BYTES)
    ) {
      return { ok: false, reason: 'SVG artwork exceeds the project import size limit.' };
    }
    sanitized.svgSource = project.svgSource;
  }

  const fullPatterns = sanitizePatterns(project.patterns, 'Project');
  if (!fullPatterns.ok) return fullPatterns;
  if (fullPatterns.patterns !== undefined) sanitized.patterns = fullPatterns.patterns;
  const customPatterns = sanitizePatterns(project.customPatterns, 'Custom');
  if (!customPatterns.ok) return customPatterns;
  if (customPatterns.patterns !== undefined) sanitized.customPatterns = customPatterns.patterns;

  copySafeId(sanitized, project, 'activePatternId');
  copySafeId(sanitized, project, 'activeSceneId');
  if (Array.isArray(project.palette) && project.palette.length === 6) {
    const palette = project.palette.map(color => sanitizeColor(color, ''));
    if (palette.every(Boolean)) sanitized.palette = palette;
  }
  copyFiniteNumber(sanitized, project, 'bpm', 20, 600);
  copyFiniteNumber(sanitized, project, 'masterSpeed', 0, 4);
  copyFiniteNumber(sanitized, project, 'masterBrightness', 0, 1);
  copyFiniteNumber(sanitized, project, 'masterSaturation', 0, 1);
  copyFiniteNumber(sanitized, project, 'gammaValue', 1, 4);
  copyFiniteNumber(sanitized, project, 'crossfadeDuration', 0, 5000);
  copyBoolean(sanitized, project, 'gammaEnabled');
  if (typeof project.ledTypeId === 'string') sanitized.ledTypeId = boundedText(project.ledTypeId, '', 64);
  if (typeof project.wledIp === 'string') sanitized.wledIp = boundedText(project.wledIp, '', 255);

  sanitized.groups = sanitizeGroups(project.groups, new Set(strips.map(strip => strip.id)));
  sanitized.connections = sanitizeConnections(project.connections, new Set(strips.map(strip => strip.id)));
  sanitized.scenes = sanitizeScenes(project.scenes);
  sanitized.artworkLayerState = sanitizeArtworkLayerState(project.artworkLayerState);
  sanitized.patternParams = sanitizePatternParams(project.patternParams);
  return { ok: true, project: sanitized };
}

function sanitizeGroups(groups, stripIds) {
  if (!Array.isArray(groups)) return [];
  return groups.slice(0, MAX_GROUPS).flatMap((group, index) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return [];
    const id = sanitizeId(group.id);
    if (!id) return [];
    const clean = {
      id,
      name: boundedText(group.name, `Group ${index + 1}`),
      stripIds: Array.isArray(group.stripIds)
        ? [...new Set(group.stripIds.filter(stripId => stripIds.has(stripId)))].slice(0, MAPPER_MAX_STRIPS)
        : [],
      color: sanitizeColor(group.color, DEFAULT_STRIP_COLOR),
    };
    copyBoolean(clean, group, 'collapsed');
    copyBoolean(clean, group, 'visible');
    copyFiniteNumber(clean, group, 'speed', 0, 8, true);
    copyFiniteNumber(clean, group, 'brightness', 0, 1, true);
    copyFiniteNumber(clean, group, 'hueShift', -180, 180, true);
    if (group.patternId === null) clean.patternId = null;
    else if (sanitizeId(group.patternId)) clean.patternId = group.patternId;
    return [clean];
  });
}

function sanitizeConnections(connections, stripIds) {
  if (!Array.isArray(connections)) return [];
  return connections.slice(0, MAX_CONNECTIONS).flatMap(connection => (
    connection
    && typeof connection === 'object'
    && !Array.isArray(connection)
    && stripIds.has(connection.fromId)
    && stripIds.has(connection.toId)
      ? [{ fromId: connection.fromId, toId: connection.toId }]
      : []
  ));
}

function sanitizeScenes(scenes) {
  if (!Array.isArray(scenes)) return [];
  return scenes.slice(0, MAX_SCENES).flatMap((scene, index) => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return [];
    const id = sanitizeId(scene.id);
    if (!id) return [];
    const clean = {
      id,
      name: boundedText(scene.name, `Scene ${index + 1}`),
      masterSpeed: boundedNumber(scene.masterSpeed, 0, 4, 1),
      masterBrightness: boundedNumber(scene.masterBrightness, 0, 1, 1),
      masterSaturation: boundedNumber(scene.masterSaturation, 0, 1, 1),
      crossfadeDuration: boundedNumber(scene.crossfadeDuration, 0, 5000, 1000),
      bpm: boundedNumber(scene.bpm, 20, 600, 120),
      palette: ['#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#ff9f1c'],
      strips: sanitizeSceneAdjustments(scene.strips),
      groups: sanitizeSceneAdjustments(scene.groups),
    };
    if (Array.isArray(scene.palette) && scene.palette.length === 6) {
      const palette = scene.palette.map(color => sanitizeColor(color, ''));
      if (palette.every(Boolean)) clean.palette = palette;
    }
    return [clean];
  });
}

function sanitizeSceneAdjustments(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, MAPPER_MAX_STRIPS).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const id = sanitizeId(entry.id);
    if (!id) return [];
    const clean = { id };
    copyBoolean(clean, entry, 'visible');
    copyBoolean(clean, entry, 'reversed');
    copyFiniteNumber(clean, entry, 'speed', 0, 8, true);
    copyFiniteNumber(clean, entry, 'brightness', 0, 1, true);
    copyFiniteNumber(clean, entry, 'hueShift', -180, 180, true);
    if (entry.patternId === null) clean.patternId = null;
    else if (sanitizeId(entry.patternId)) clean.patternId = entry.patternId;
    return [clean];
  });
}

function sanitizeArtworkLayerState(layers) {
  if (!Array.isArray(layers)) return [];
  return layers.slice(0, MAX_SVG_ELEMENTS).flatMap(layer => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return [];
    const layerId = sanitizeId(layer.layerId);
    if (!layerId) return [];
    return [{
      layerId,
      _hidden: layer._hidden === true,
      _color: sanitizeColor(layer._color, DEFAULT_STRIP_COLOR),
    }];
  });
}

function sanitizePatternParams(patternParams) {
  if (!patternParams || typeof patternParams !== 'object' || Array.isArray(patternParams)) return {};
  const clean = Object.create(null);
  for (const [patternId, params] of Object.entries(patternParams).slice(0, MAX_PATTERNS)) {
    if (!sanitizeId(patternId) || DANGEROUS_OBJECT_KEYS.has(patternId)) continue;
    if (!params || typeof params !== 'object' || Array.isArray(params)) continue;
    const cleanParams = Object.create(null);
    for (const [name, value] of Object.entries(params).slice(0, 64)) {
      if (
        DANGEROUS_OBJECT_KEYS.has(name)
        || !/^\w{1,64}$/.test(name)
        || !Number.isFinite(value)
      ) continue;
      cleanParams[name] = value;
    }
    clean[patternId] = cleanParams;
  }
  return clean;
}

function boundedText(value, fallback, maxChars = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return fallback;
  return value
    .normalize('NFC')
    .replace(CONTROL_CHARACTERS, ' ')
    .slice(0, maxChars);
}

function sanitizeId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_CHARS) return '';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '';
  if (DANGEROUS_OBJECT_KEYS.has(value)) return '';
  return value;
}

function sanitizeColor(value, fallback) {
  return typeof value === 'string' && SAFE_COLOR.test(value) ? value.toLowerCase() : fallback;
}

function isSafeCssPreview(value) {
  return typeof value === 'string'
    && value.length <= 1024
    && !/[<>"';\\]/.test(value)
    && !/(?:url\s*\(|expression\s*\(|javascript:|@import)/i.test(value);
}

function copyBoolean(target, source, key) {
  if (typeof source[key] === 'boolean') target[key] = source[key];
}

function copyFiniteNumber(target, source, key, min, max, allowNull = false) {
  if (allowNull && source[key] === null) {
    target[key] = null;
    return;
  }
  if (Number.isFinite(source[key])) target[key] = Math.min(max, Math.max(min, source[key]));
}

function boundedNumber(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function copySafeId(target, source, key) {
  const value = sanitizeId(source[key]);
  if (value) target[key] = value;
}

export function validateMapperProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return { ok: false, reason: 'This file does not contain an LED Mapper project.' };
  }

  let legacy = false;
  if (project.format === MAPPER_PROJECT_FORMAT) {
    if (project.schemaVersion !== MAPPER_PROJECT_SCHEMA_VERSION) {
      return {
        ok: false,
        reason: `This LED Mapper project uses unsupported schema version ${String(project.schemaVersion)}.`,
      };
    }
  } else if (project.format) {
    return { ok: false, reason: `This file belongs to another tool (${project.format}).` };
  } else if (project.physicalLayout || project.looks || project.standaloneController) {
    return {
      ok: false,
      reason: 'This is a Lightweaver Studio project, not an LED Mapper project.',
    };
  } else {
    const looksLikeLegacyMapper =
      project.version === 3 &&
      Array.isArray(project.strips) &&
      Object.hasOwn(project, 'svgSource') &&
      (Object.hasOwn(project, 'activePatternId') || Array.isArray(project.palette));
    if (!looksLikeLegacyMapper) {
      return { ok: false, reason: 'This file is not a recognized LED Mapper project.' };
    }
    legacy = true;
  }

  const stripValidation = sanitizeMapperStrips(project.strips);
  if (!stripValidation.ok) return stripValidation;
  const sanitizedProject = sanitizeProjectFields(project, stripValidation.strips);
  if (!sanitizedProject.ok) return sanitizedProject;
  return {
    ok: true,
    legacy,
    project: sanitizedProject.project,
  };
}

export function preflightMapperProjectGeometry(project, documentImpl = globalThis.document) {
  if (!documentImpl?.createElementNS || !Array.isArray(project?.strips)) {
    return { ok: false, reason: 'SVG path geometry validation is unavailable.' };
  }

  const svgValidation = sanitizeMapperSvgSource(project.svgSource, documentImpl);
  if (!svgValidation.ok) return svgValidation;
  const sanitizedProject = svgValidation.svgSource === undefined
    ? project
    : { ...project, svgSource: svgValidation.svgSource };

  for (let index = 0; index < sanitizedProject.strips.length; index += 1) {
    const strip = sanitizedProject.strips[index];
    const path = documentImpl.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', strip.pathData);
    try {
      const length = path.getTotalLength();
      if (!Number.isFinite(length) || length <= 0) throw new Error('Path has no measurable length');
      for (const offset of [0, length / 2, length]) {
        const point = path.getPointAtLength(offset);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          throw new Error('Path returned an invalid point');
        }
      }
    } catch {
      return {
        ok: false,
        reason: `Section ${index + 1} does not contain a usable SVG path.`,
      };
    }
  }

  return { ok: true, project: sanitizedProject };
}

export function isMapperTextWithinLimit(value, maxBytes) {
  if (typeof value !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) return false;
  if (value.length > maxBytes) return false;
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

export function sanitizeMapperSvgSource(svgSource, documentImpl = globalThis.document) {
  if (svgSource === undefined || svgSource === null || svgSource === '') {
    return { ok: true, svgSource };
  }
  if (
    typeof svgSource !== 'string'
    || !isMapperTextWithinLimit(svgSource, MAPPER_MAX_SVG_SOURCE_BYTES)
  ) {
    return { ok: false, reason: 'SVG artwork exceeds the 2 MB import limit.' };
  }
  const DOMParserImpl = documentImpl.defaultView?.DOMParser ?? globalThis.DOMParser;
  const XMLSerializerImpl = documentImpl.defaultView?.XMLSerializer ?? globalThis.XMLSerializer;
  if (!DOMParserImpl || !XMLSerializerImpl) {
    return { ok: false, reason: 'SVG artwork validation is unavailable.' };
  }
  if ((svgSource.match(/</g)?.length ?? 0) > MAX_SVG_ELEMENTS * 2) {
    return { ok: false, reason: `SVG artwork exceeds the ${MAX_SVG_ELEMENTS}-element limit.` };
  }

  const parsed = new DOMParserImpl().parseFromString(svgSource, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) {
    return { ok: false, reason: 'SVG artwork is not valid XML.' };
  }
  const root = parsed.documentElement;
  if (root?.localName?.toLowerCase() !== 'svg') {
    return { ok: false, reason: 'SVG artwork has no valid SVG root.' };
  }
  const elements = [root, ...root.querySelectorAll('*')];
  if (elements.length > MAX_SVG_ELEMENTS) {
    return { ok: false, reason: `SVG artwork exceeds the ${MAX_SVG_ELEMENTS}-element limit.` };
  }

  for (const element of elements) {
    const elementName = element.localName.toLowerCase();
    if (!SAFE_SVG_ELEMENTS.has(elementName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const attributeName = attribute.name.toLowerCase();
      if (
        attributeName.startsWith('on')
        || !SAFE_SVG_ATTRIBUTES.has(attributeName)
        || attribute.value.length > MAPPER_MAX_PATH_DATA_CHARS
      ) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (attributeName === 'href' || attributeName === 'xlink:href') {
        if (!/^#[A-Za-z_][\w:.-]*$/.test(attribute.value.trim())) {
          element.removeAttributeNode(attribute);
        }
        continue;
      }
      if (attributeName === 'style') {
        const sanitizedStyle = sanitizeSvgStyle(attribute.value);
        if (sanitizedStyle) element.setAttribute('style', sanitizedStyle);
        else element.removeAttributeNode(attribute);
        continue;
      }
      if (['fill', 'stroke', 'clip-path', 'mask'].includes(attributeName)) {
        if (!isSafeSvgPaintValue(attribute.value)) element.removeAttributeNode(attribute);
      }
    }
  }

  const sanitizedSvgSource = new XMLSerializerImpl().serializeToString(root);
  if (!isMapperTextWithinLimit(sanitizedSvgSource, MAPPER_MAX_SVG_SOURCE_BYTES)) {
    return { ok: false, reason: 'Sanitized SVG artwork exceeds the 2 MB import limit.' };
  }
  return { ok: true, svgSource: sanitizedSvgSource };
}

function sanitizeSvgStyle(style) {
  const declarations = [];
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SAFE_SVG_STYLE_PROPERTIES.has(property) || !isSafeSvgPaintValue(value)) continue;
    declarations.push(`${property}:${value}`);
  }
  return declarations.join(';');
}

function isSafeSvgPaintValue(value) {
  if (
    !value
    || value.length > 512
    || /(?:javascript:|expression\s*\(|@import|https?:|data:)/i.test(value)
  ) return false;
  const urls = [...value.matchAll(/url\s*\(([^)]*)\)/gi)];
  return urls.every(match => /^#[-\w:.]+$/.test(match[1].trim().replace(/^['"]|['"]$/g, '')));
}

export function describeMapperProject(project) {
  const strips = Array.isArray(project?.strips) ? project.strips : [];
  const patterns = Array.isArray(project?.patterns)
    ? project.patterns
    : Array.isArray(project?.customPatterns) ? project.customPatterns : [];
  const pixels = strips.reduce((total, strip) => (
    total + Math.max(0, Number(strip?.pixelCount) || 0)
  ), 0);

  return [
    `${strips.length} section${strips.length === 1 ? '' : 's'}`,
    `${pixels} LED${pixels === 1 ? '' : 's'}`,
    `${patterns.length} pattern${patterns.length === 1 ? '' : 's'}`,
  ].join(' · ');
}
