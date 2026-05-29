import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, '../src/LightweaverStorage.cpp'), 'utf8');

assert.equal(
  /RuntimeConfig\s+parsed\s*;/.test(source),
  false,
  'saveRuntimeConfigJson must not allocate a full RuntimeConfig on the loopTask stack',
);

const resetMatch = source.match(/void\s+resetConfig\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
assert.ok(resetMatch, 'resetConfig implementation should be present');
assert.equal(
  /RuntimeConfig\s*\(/.test(resetMatch[1]),
  false,
  'resetConfig must reset fields in place instead of assigning a temporary RuntimeConfig',
);
