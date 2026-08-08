import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const screenSources = await Promise.all([
  '../v3/lw-pattern.jsx',
  '../v3/lw-playlist.jsx',
  '../v3/lw-show.jsx',
].map(async file => ({ file, source: await readFile(new URL(file, import.meta.url), 'utf8') })));

test('Patterns, Playlist, and Show consult the centralized live-control authority before output', () => {
  for (const { file, source } of screenSources) {
    const authorityName = file.includes('show')
      ? 'createLiveControlAuthorityGate'
      : 'decideLiveControlProjectAuthority';
    assert.match(source, new RegExp(authorityName), `${file} must import and call the centralized authority`);
    assert.ok(
      source.split(authorityName).length >= 3,
      `${file} must import and invoke the centralized authority`,
    );
  }
});

test('Playlist routes Reset Live through project-aware readback verification', () => {
  const playlist = screenSources.find(item => item.file.includes('playlist')).source;
  assert.match(playlist, /resetLiveOutputOnCard\([\s\S]*?studioProject:\s*runtimePackage/);
});

test('Show keeps its active animation stream behind the transition-aware authority gate', () => {
  const show = screenSources.find(item => item.file.includes('show')).source;
  assert.match(show, /createLiveControlAuthorityGate/);
  assert.match(show, /authorityGateRef\.current\.canSend\(\)/);
  assert.match(show, /authorityGateRef\.current\.update/);
});
