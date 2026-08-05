import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Layout screen deep-links its mode through `#screen=layout&mode=<key>`,
// and `parseModeFromHash` silently falls back to the default for anything it
// does not recognise. That makes a wrong mode key invisible: the link still
// navigates, it just lands somewhere else. The Playlist's "Adjust LED count"
// button pointed at a `size` mode that had been removed, and nothing caught it.
//
// This walks the real source instead of a fixture, so a mode key that is
// renamed or retired fails here rather than in someone's hands.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.(?:js|jsx)$/.test(entry) && !entry.endsWith('.test.js')) {
      found.push(path);
    }
  }
  return found;
}

function declaredLayoutModes() {
  const hook = readFileSync(join(SRC, 'components/layout/hooks/useLayoutCanvasInteraction.js'), 'utf8');
  const match = hook.match(/const LAYOUT_MODES = \[([^\]]*)\]/);
  assert.ok(match, 'LAYOUT_MODES must still be a literal array in useLayoutCanvasInteraction.js');
  return match[1].split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('the Layout mode switch offers exactly the modes the hash parser accepts', () => {
  const modes = declaredLayoutModes();
  const switchSource = readFileSync(join(SRC, 'components/layout/shared/ModeSwitch.jsx'), 'utf8');
  const keys = [...switchSource.matchAll(/\{ key: '([^']+)', label: '[^']*' \}/g)].map(m => m[1]);

  assert.deepEqual([...keys].sort(), [...modes].sort());
  assert.ok(modes.length > 0);
});

test('every layout mode deep link in the app points at a mode that exists', () => {
  const modes = declaredLayoutModes();
  const offenders = [];

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const [, mode] of source.matchAll(/screen=layout&mode=([A-Za-z0-9-]+)/g)) {
      if (!modes.includes(mode)) offenders.push(`${file.slice(SRC.length + 1)} -> mode=${mode}`);
    }
  }

  assert.deepEqual(offenders, [], `dead layout deep links (valid modes: ${modes.join(', ')})`);
});

test('the Playlist "Adjust LED count" jump lands on the panel that owns LED counts', () => {
  const playlist = readFileSync(join(SRC, 'v3/lw-playlist.jsx'), 'utf8');
  const match = playlist.match(/const adjustLedCounts = \(\) => \{ window\.location\.hash = '([^']+)'; \};/);
  assert.ok(match, 'the Adjust LED count handler must still be a single hash assignment');

  const mode = new URLSearchParams(match[1]).get('mode');
  assert.ok(declaredLayoutModes().includes(mode), `mode=${mode} is not a real layout mode`);

  // 'draw' is the panel labelled "Wire": it carries the per-strip LED count
  // inputs. 'wire' is "Test & Install" and has no per-strip count field.
  assert.equal(mode, 'draw');
  const drawPanel = readFileSync(join(SRC, 'components/layout/modes/DrawModePanel.jsx'), 'utf8');
  assert.match(drawPanel, /aria-label="New strip LEDs"/);
});
