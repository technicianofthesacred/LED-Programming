import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const types = fs.readFileSync(path.join(root, 'src/LightweaverTypes.h'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/LightweaverStorage.cpp'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');

assert.match(
  types,
  /String\s+pieceId\b/,
  'runtime config should store a stable Studio project id separately from the display name',
);

assert.match(
  storage,
  /config\.pieceId\s*=\s*String\(doc\["piece"\]\["id"\]/,
  'storage parser should load piece.id from card runtime packages',
);

assert.match(
  main,
  /doc\["piece"\]\["id"\]\s*=\s*runtimeConfig\.pieceId/,
  'firmware-info should expose the stored piece id for wrong-project write guards',
);

assert.match(
  main,
  /doc\["piece"\]\["name"\]\s*=\s*runtimeConfig\.pieceName/,
  'firmware-info should expose the stored piece name for human-readable mismatch errors',
);

console.log('project-identity-contract tests passed');
