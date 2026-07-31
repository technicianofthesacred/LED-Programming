import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAPPER_MAX_PATH_DATA_CHARS,
  MAPPER_MAX_PATTERN_FILE_BYTES,
  MAPPER_MAX_PROJECT_JSON_BYTES,
  MAPPER_MAX_SVG_SOURCE_BYTES,
  MAPPER_MAX_STRIPS,
  MAPPER_MAX_TOTAL_LEDS,
  MAPPER_PROJECT_FORMAT,
  MAPPER_PROJECT_SCHEMA_VERSION,
  describeMapperProject,
  isMapperTextWithinLimit,
  validateMapperProject,
} from '../src/project-format.js';

test('accepts the distinct mapper project envelope', () => {
  const project = {
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
    strips: [{ id: 'outer', name: 'Outer', pathData: 'M0 0 L100 0', pixelCount: 120 }],
    patterns: [{ id: 'rainbow' }],
  };

  const validation = validateMapperProject(project);
  assert.equal(validation.ok, true);
  assert.equal(validation.legacy, false);
  assert.equal(validation.project.strips[0].name, 'Outer');
  assert.equal(validation.project.patterns[0].id, 'rainbow');
  assert.notEqual(validation.project, project);
  assert.notEqual(validation.project.strips, project.strips);
  assert.equal(
    describeMapperProject(validation.project),
    '1 section · 120 LEDs · 1 pattern',
  );
});

test('accepts legacy mapper projects only when mapper-specific fields are present', () => {
  const legacy = {
    version: 3,
    strips: [{ id: ' outer ', pathData: ' M0 0 L20 0 ', pixelCount: 44 }],
    svgSource: '<svg></svg>',
    activePatternId: 'rainbow',
  };

  const validation = validateMapperProject(legacy);
  assert.equal(validation.ok, true);
  assert.equal(validation.legacy, true);
  assert.equal(validation.project.strips[0].id, ' outer ');
  assert.equal(validation.project.strips[0].pathData, 'M0 0 L20 0');
  assert.equal(validation.project.strips[0].pixelCount, 44);
});

test('rejects a Studio v3 project instead of silently treating it as a mapper project', () => {
  const studioProject = {
    version: 3,
    name: 'Gallery piece',
    physicalLayout: { strips: [] },
    looks: [],
  };

  assert.deepEqual(validateMapperProject(studioProject), {
    ok: false,
    reason: 'This is a Lightweaver Studio project, not an LED Mapper project.',
  });
});

test('rejects unknown formats and future mapper schema versions', () => {
  assert.equal(validateMapperProject({ format: 'other.tool', schemaVersion: 1 }).ok, false);
  assert.equal(
    validateMapperProject({
      format: MAPPER_PROJECT_FORMAT,
      schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION + 1,
      strips: [],
    }).ok,
    false,
  );
});

test('rejects null, primitive, and array strip entries', () => {
  const base = {
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
  };

  for (const strip of [null, 'outer', 42, []]) {
    const result = validateMapperProject({ ...base, strips: [strip] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /section 1.*object/i);
  }
});

test('rejects strips with missing or invalid ids', () => {
  const base = {
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
  };
  const valid = { id: 'outer', pathData: 'M0 0 L100 0', pixelCount: 120 };

  for (const id of [undefined, null, '', '   ', 42]) {
    const result = validateMapperProject({ ...base, strips: [{ ...valid, id }] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /section 1.*id/i);
  }
});

test('rejects strips with missing or invalid path data', () => {
  const base = {
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
  };
  const valid = { id: 'outer', pathData: 'M0 0 L100 0', pixelCount: 120 };

  for (const pathData of [undefined, null, '', '   ', 42]) {
    const result = validateMapperProject({ ...base, strips: [{ ...valid, pathData }] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /section 1.*path/i);
  }
});

test('rejects strips with missing or invalid LED counts', () => {
  const base = {
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
  };
  const valid = { id: 'outer', pathData: 'M0 0 L100 0', pixelCount: 120 };

  for (const pixelCount of [undefined, null, 0, -1, 1.5, '120', Number.NaN]) {
    const result = validateMapperProject({ ...base, strips: [{ ...valid, pixelCount }] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /section 1.*LED count/i);
  }
});

test('rejects duplicate strip ids', () => {
  const result = validateMapperProject({
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
    strips: [
      { id: 'outer', pathData: 'M0 0 L100 0', pixelCount: 120 },
      { id: 'outer', pathData: 'M0 10 L100 10', pixelCount: 80 },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /duplicate.*outer/i);
});

test('enforces strip, per-strip LED, total LED, and path-data import limits', () => {
  const base = {
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
  };
  const makeStrip = (index, pixelCount = 1, pathData = `M0 ${index} L100 ${index}`) => ({
    id: `strip-${index}`,
    pathData,
    pixelCount,
  });

  const boundary = validateMapperProject({
    ...base,
    strips: Array.from({ length: 4 }, (_, index) => makeStrip(index, 4096)),
  });
  assert.equal(boundary.ok, true, boundary.reason);
  assert.equal(boundary.project.strips.reduce((sum, strip) => sum + strip.pixelCount, 0), 16384);

  const tooManyStrips = validateMapperProject({
    ...base,
    strips: Array.from({ length: MAPPER_MAX_STRIPS + 1 }, (_, index) => makeStrip(index)),
  });
  assert.equal(tooManyStrips.ok, false);
  assert.match(tooManyStrips.reason, /too many sections|section limit/i);

  const tooManyOnOneStrip = validateMapperProject({
    ...base,
    strips: [makeStrip(0, 4097)],
  });
  assert.equal(tooManyOnOneStrip.ok, false);
  assert.match(tooManyOnOneStrip.reason, /4096|LED count/i);

  const tooManyTotal = validateMapperProject({
    ...base,
    strips: Array.from(
      { length: Math.ceil(MAPPER_MAX_TOTAL_LEDS / 4096) + 1 },
      (_, index) => makeStrip(index, 4096),
    ),
  });
  assert.equal(tooManyTotal.ok, false);
  assert.match(tooManyTotal.reason, /total.*LED|LED.*total/i);

  const oversizedPath = validateMapperProject({
    ...base,
    strips: [makeStrip(0, 1, `M0 0 ${'L1 1 '.repeat(Math.ceil(MAPPER_MAX_PATH_DATA_CHARS / 5))}`)],
  });
  assert.equal(oversizedPath.ok, false);
  assert.match(oversizedPath.reason, /path.*large|path.*limit/i);
});

test('allowlists and bounds imported project, strip, and pattern fields', () => {
  const payload = '<img src=x onerror="window.__mapperImportExecuted += 1">';
  const result = validateMapperProject({
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
    attackerControlledProjectField: payload,
    strips: [{
      id: 'outer',
      name: payload.repeat(20),
      pathData: 'M0 0 L100 0',
      pixelCount: 12,
      color: 'url(javascript:alert(1))',
      attackerControlledStripField: payload,
    }],
    patterns: [{
      id: 'safe-pattern',
      name: payload.repeat(20),
      desc: payload,
      preview: 'url(javascript:alert(1))',
      code: 'return { r: 0, g: 0, b: 0 };',
      attackerControlledPatternField: payload,
    }],
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.project.attackerControlledProjectField, undefined);
  assert.equal(result.project.strips[0].attackerControlledStripField, undefined);
  assert.equal(result.project.patterns[0].attackerControlledPatternField, undefined);
  assert.ok(result.project.strips[0].name.length <= 160);
  assert.equal(result.project.strips[0].color, '#06d6a0');
  assert.ok(result.project.patterns[0].name.length <= 160);
  assert.equal(result.project.patterns[0].preview, undefined);
});

test('raw text size limits accept their exact boundary and reject the next byte', () => {
  for (const limit of [
    MAPPER_MAX_SVG_SOURCE_BYTES,
    MAPPER_MAX_PATTERN_FILE_BYTES,
    MAPPER_MAX_PROJECT_JSON_BYTES,
  ]) {
    assert.equal(isMapperTextWithinLimit('x'.repeat(limit), limit), true);
    assert.equal(isMapperTextWithinLimit('x'.repeat(limit + 1), limit), false);
    assert.equal(
      isMapperTextWithinLimit(`${'x'.repeat(limit - 1)}é`, limit),
      false,
      'UTF-8 byte size must be enforced, not only JavaScript character count',
    );
  }
});
