import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('keeps the custom density field hidden until Custom is selected', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.empty-custom-density\[hidden\]\s*\{[^}]*display:\s*none/);
});
