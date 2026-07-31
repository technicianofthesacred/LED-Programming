import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAPPER_PROJECT_FORMAT,
  MAPPER_PROJECT_SCHEMA_VERSION,
  describeMapperProject,
  validateMapperProject,
} from '../src/project-format.js';

test('accepts the distinct mapper project envelope', () => {
  const project = {
    format: MAPPER_PROJECT_FORMAT,
    schemaVersion: MAPPER_PROJECT_SCHEMA_VERSION,
    strips: [{ id: 'outer', name: 'Outer', pixelCount: 120 }],
    patterns: [{ id: 'rainbow' }],
  };

  assert.deepEqual(validateMapperProject(project), { ok: true, legacy: false });
  assert.equal(
    describeMapperProject(project),
    '1 section · 120 LEDs · 1 pattern',
  );
});

test('accepts legacy mapper projects only when mapper-specific fields are present', () => {
  const legacy = {
    version: 3,
    strips: [{ id: 'outer', pixelCount: 44 }],
    svgSource: '<svg></svg>',
    activePatternId: 'rainbow',
  };

  assert.deepEqual(validateMapperProject(legacy), { ok: true, legacy: true });
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
