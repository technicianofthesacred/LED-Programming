import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);
const developmentCli = await import('./lightweaver-dev.mjs').catch(() => ({}));
const { resolveDevelopmentSteps } = developmentCli;
const agents = await readFile(new URL('AGENTS.md', repoRoot), 'utf8');
const workflow = await readFile(new URL('docs/development-workflow.md', repoRoot), 'utf8').catch(() => '');

test('repository CLI exposes stable preview and focused browser commands', () => {
  assert.equal(typeof resolveDevelopmentSteps, 'function', 'development CLI resolver must exist');
  assert.deepEqual(resolveDevelopmentSteps('preview'), [{
    command: 'npm',
    args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
  }]);
  assert.deepEqual(resolveDevelopmentSteps('focused', ['tests/card.spec.ts', '--grep', 'rollback']), [{
    command: 'npm',
    args: ['exec', '--', 'playwright', 'test', '--project=chromium', '--workers=1', 'tests/card.spec.ts', '--grep', 'rollback'],
  }]);
});

test('repository CLI keeps checkpoint bounded and release exhaustive', () => {
  assert.deepEqual(resolveDevelopmentSteps('checkpoint'), [
    { command: 'npm', args: ['run', 'test:unit'] },
    { command: 'node', args: ['scripts/ensure-rollup-native.mjs'] },
    { command: 'npm', args: ['run', 'build'] },
  ]);
  assert.deepEqual(resolveDevelopmentSteps('release'), [
    { command: 'npm', args: ['run', 'launch:check'] },
  ]);
  assert.throws(() => resolveDevelopmentSteps('unknown'), /preview, focused, checkpoint, or release/);
});

test('agent policy makes the fast loop the default and release work explicit', () => {
  assert.match(agents, /Default to the glitch loop/i);
  assert.match(agents, /do not bump firmware/i);
  assert.match(agents, /do not flash hardware/i);
  assert.match(agents, /“build” means implement/i);
  assert.match(agents, /visual-feedback list/i);
});

test('workflow explains exact gates, escalation, and destructive firmware boundary', () => {
  for (const required of [
    'Glitch loop',
    'Checkpoint loop',
    'Release loop',
    '3–10 minutes',
    '10–20 minutes',
    'factory image erases',
    'Never flash a configured card',
    'Tests / gate',
    'Studio build',
    'firmware build',
  ]) {
    assert.match(workflow, new RegExp(required, 'i'), `missing workflow requirement: ${required}`);
  }
});
