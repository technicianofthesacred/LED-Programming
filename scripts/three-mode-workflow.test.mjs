import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, repoRoot), 'utf8').catch(() => '');

const [agents, workboard, development, sprint, bench, prove, benchTemplate, proveTemplate] = await Promise.all([
  read('AGENTS.md'),
  read('LIGHTWEAVER_WORKBOARD.md'),
  read('docs/development-workflow.md'),
  read('docs/workflows/sprint.md'),
  read('docs/workflows/bench.md'),
  read('docs/workflows/prove.md'),
  read('docs/bench-sessions/TEMPLATE.md'),
  read('docs/prove-sessions/TEMPLATE.md'),
]);

test('agent policy infers Sprint and Bench without requiring memorized commands', () => {
  assert.match(agents, /features?.*glitches?.*Sprint/is);
  assert.match(agents, /lights?.*colou?r.*pixels?.*Bench/is);
  assert.match(agents, /do not require Adrian to remember/i);
  assert.match(agents, /ambiguous.*Sprint/is);
});

test('Prove is explicit-only and shipping never silently invokes it', () => {
  assert.match(agents, /“Prove Lightweaver”.*authorization/is);
  assert.match(agents, /check everything.*confirmation/is);
  assert.match(agents, /ship.*does not.*Prove/is);
  assert.match(prove, /never starts automatically/i);
  assert.match(prove, /exact phrase.*Prove Lightweaver/is);
  assert.match(prove, /development freeze/i);
});

test('Sprint uses bounded independent agents and one integrated checkpoint', () => {
  assert.match(sprint, /at most three sub-agents/i);
  assert.match(sprint, /non-overlapping/i);
  assert.match(sprint, /primary agent.*integrator/is);
  assert.match(sprint, /one integrated checkpoint/i);
  assert.match(sprint, /visual-feedback queue/i);
  assert.match(sprint, /balanced.*bounded.*frontier.*firmware/is);
});

test('Bench automates machine work and asks for one physical observation at a time', () => {
  assert.match(bench, /flash.*serial.*API.*browser/is);
  assert.match(bench, /one.*observation.*at a time/is);
  assert.match(bench, /never mark.*hardware.*passed/is);
  assert.match(bench, /Sprint issue/i);
  assert.match(bench, /resume/i);
});

test('workboard is primary-owned and keeps every queue separate', () => {
  assert.match(workboard, /Only the primary agent edits/i);
  for (const heading of [
    'Sprint queue',
    'Active ownership',
    'Visual-feedback queue',
    'Bench queue',
    'Prove readiness',
    'Completed evidence',
  ]) {
    assert.match(workboard, new RegExp(`## ${heading}`, 'i'), `missing workboard section: ${heading}`);
  }
});

test('Bench and Prove templates preserve exact evidence and one resumption point', () => {
  for (const field of [
    'Card ID', 'Firmware build', 'Boot ID', 'Project fingerprint', 'GPIO',
    'Pixel count', 'Machine evidence', 'Human observations', 'Single next step',
  ]) assert.match(benchTemplate, new RegExp(field, 'i'), `missing Bench field: ${field}`);

  for (const field of [
    'Source revision', 'Studio build', 'Firmware build', 'Automated gates',
    'Live proof', 'Hardware matrix', 'Waivers', 'Unresolved risks', 'Single next step',
  ]) assert.match(proveTemplate, new RegExp(field, 'i'), `missing Prove field: ${field}`);
});

test('existing development guide links all three modes as the preferred interface', () => {
  assert.match(development, /\]\(workflows\/sprint\.md\)/);
  assert.match(development, /\]\(workflows\/bench\.md\)/);
  assert.match(development, /\]\(workflows\/prove\.md\)/);
  assert.match(development, /You do not need to remember/i);
});
