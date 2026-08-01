import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assertCardKaleidoscopeSupport } from './cardPushClient.js';
import { buildCardRuntimePackageFromProject } from './cardRuntimeProject.js';
import { createDefaultKaleidoscope } from './kaleidoscope.js';
import { createDefaultProject } from './projectModel.js';
import { compileWiring } from './wiringCompiler.js';

const STUDIO_BUILDERS = [
  {
    file: '../v3/lw-pattern.jsx',
    calls: [
      ['buildCardRuntimePackageFromProject', 1],
      ['prepareCardDeployment', 2],
    ],
  },
  { file: '../v3/lw-settings.jsx', calls: [['prepareCardDeployment', 1]] },
  { file: '../v3/lw-playlist.jsx', calls: [['prepareCardDeployment', 1]] },
];

function builderCalls(source, callee) {
  const calls = [];
  const startToken = `${callee}({`;
  let cursor = 0;
  while ((cursor = source.indexOf(startToken, cursor)) >= 0) {
    let depth = 0;
    let end = cursor + startToken.length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(cursor, end + 1));
    cursor = end + 1;
  }
  return calls;
}

function mappedProject() {
  const project = createDefaultProject();
  project.layout.strips[0].kaleidoscope = createDefaultKaleidoscope(
    project.layout.strips[0].pixelCount,
  );
  return project;
}

test('every primary Studio card package builder uses canonical compiled wiring', () => {
  for (const { file, calls } of STUDIO_BUILDERS) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const [callee, expectedCount] of calls) {
      const found = builderCalls(source, callee);
      assert.equal(found.length, expectedCount, `${file} must keep every ${callee} call under contract`);
      for (const call of found) {
        assert.match(call, /\bcompiledWiring\b/, `${file} ${callee} must use ProjectContext.compiledWiring`);
      }
    }
  }
});

test('mapped Studio runtime packages preserve mappings and trigger the old-card capability gate', () => {
  const project = mappedProject();
  const compiledWiring = compileWiring({
    wiring: project.layout.wiring,
    strips: project.layout.strips,
    groups: project.layout.layerGroups,
  });
  assert.equal(compiledWiring.ok, true);

  const runtimePackage = buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    compiledWiring,
    standaloneController: project.devices.standaloneController,
  });

  assert.equal(runtimePackage.config.kaleidoscopeMappings.length, 1);
  assert.equal(runtimePackage.config.kaleidoscopeMappings[0].id, project.layout.strips[0].id);
  assert.throws(
    () => assertCardKaleidoscopeSupport(runtimePackage, {
      capabilities: { kaleidoscopeReflectionPoints: 0 },
    }),
    error => error?.reason === 'kaleidoscope-unsupported',
  );
});

test('enabled Kaleidoscope metadata fails closed when no wiring can compile it', () => {
  const project = mappedProject();
  assert.throws(
    () => buildCardRuntimePackageFromProject({
      projectId: project.id,
      projectName: project.name,
      strips: project.layout.strips,
      patchBoard: project.layout.patchBoard,
      standaloneController: project.devices.standaloneController,
    }),
    /Kaleidoscope.*wiring/i,
  );
});
