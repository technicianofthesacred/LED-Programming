import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStudioRelease, serializeStudioRelease } from '../src/lib/studioRelease.js';

const REVISION = 'b'.repeat(40);

test('Vite embeds and emits one exact Studio release identity', async t => {
  const prior = process.env.LIGHTWEAVER_SOURCE_REVISION;
  process.env.LIGHTWEAVER_SOURCE_REVISION = REVISION;
  t.after(() => {
    if (prior === undefined) delete process.env.LIGHTWEAVER_SOURCE_REVISION;
    else process.env.LIGHTWEAVER_SOURCE_REVISION = prior;
  });

  const { default: config } = await import(`../vite.config.js?studio-release-test=${Date.now()}`);
  const embedded = parseStudioRelease(JSON.parse(config.define.__LIGHTWEAVER_STUDIO_RELEASE__));
  assert.equal(embedded.sourceRevision, REVISION);

  const plugin = config.plugins.find(candidate => candidate?.name === 'lightweaver-studio-release');
  assert.ok(plugin, 'Vite must install the Studio release asset plugin');
  let emitted = null;
  plugin.generateBundle.call({ emitFile: asset => { emitted = asset; } });
  assert.deepEqual(emitted, {
    type: 'asset',
    fileName: 'studio-release.json',
    source: serializeStudioRelease(embedded),
  });
});
