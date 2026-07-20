import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stylesheets = [
  new URL('../src/v3/v3-styles.css', import.meta.url),
  new URL('../src-v3/main.css', import.meta.url),
];

for (const stylesheet of stylesheets) {
  const css = await readFile(stylesheet, 'utf8');
  assert.match(css, /input\[type=number\]\s*\{[^}]*appearance:\s*textfield/s,
    `${stylesheet.pathname} keeps numeric fields free of native spinners`);
  assert.match(css, /input\[type=number\]::-(webkit-inner|webkit-outer)-spin-button/,
    `${stylesheet.pathname} neutralizes Chromium's native spinner buttons`);
}
