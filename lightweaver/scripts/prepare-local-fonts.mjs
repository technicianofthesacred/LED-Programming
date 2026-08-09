#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(projectDirectory, 'public', 'fonts');
const files = [
  ['node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2', 'general-sans-latin.woff2'],
  ['node_modules/@fontsource/spline-sans-mono/files/spline-sans-mono-latin-400-normal.woff2', 'spline-sans-mono-400.woff2'],
  ['node_modules/@fontsource/spline-sans-mono/files/spline-sans-mono-latin-500-normal.woff2', 'spline-sans-mono-500.woff2'],
  ['node_modules/@fontsource/spline-sans-mono/files/spline-sans-mono-latin-600-normal.woff2', 'spline-sans-mono-600.woff2'],
];

await mkdir(destination, { recursive: true });
for (const [source, name] of files) await copyFile(resolve(projectDirectory, source), resolve(destination, name));
