#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const [packagePath, outputDir] = process.argv.slice(2);

if (!packagePath || !outputDir) {
  console.error('Usage: node scripts/unpack-standalone-package.mjs <package.json> <microSD-output-dir>');
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
if (packageJson.format !== 'standalone-controller-package' || !packageJson.files) {
  throw new Error('Expected a Lightweaver standalone-controller-package export');
}

await mkdir(outputDir, { recursive: true });

for (const [packageFilePath, fileValue] of Object.entries(packageJson.files)) {
  const cleanPath = packageFilePath.replace(/^\/+/, '');
  if (!cleanPath || cleanPath.includes('..') || cleanPath.startsWith('/') || cleanPath.startsWith('~')) {
    throw new Error(`Unsafe package path: ${packageFilePath}`);
  }

  const targetPath = join(outputDir, cleanPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, encodeFileValue(fileValue));
  console.log(`Wrote ${relative(outputDir, targetPath)}`);
}

console.log(`Standalone package unpacked to ${outputDir}`);

function encodeFileValue(value) {
  if (value && typeof value === 'object' && value.encoding === 'base64') {
    return Buffer.from(value.data || '', 'base64');
  }

  if (value && typeof value === 'object') {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  return String(value ?? '');
}
