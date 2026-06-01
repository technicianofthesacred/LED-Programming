import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');
const wled = readFileSync(resolve(here, '../src/LightweaverWledJsonApi.cpp'), 'utf8');

for (const [name, source] of [
  ['LightweaverWeb.cpp', web],
  ['LightweaverWledJsonApi.cpp', wled],
]) {
  const corsStart = source.indexOf('void sendCors()');
  assert.notEqual(corsStart, -1, `${name} should define sendCors`);
  const corsEnd = source.indexOf('}', corsStart);
  const corsBody = source.slice(corsStart, corsEnd);
  assert.match(
    corsBody,
    /Access-Control-Allow-Private-Network"\s*,\s*"true"/,
    `${name} should allow Chrome private-network preflights from the public Studio`,
  );
}

for (const route of ['/api/status', '/api/firmware-info', '/api/patterns', '/api/zones']) {
  assert.ok(
    web.includes(`server.on("${route}", HTTP_OPTIONS, handleOptions)`),
    `${route} should answer PNA OPTIONS preflight before public Studio GET requests`,
  );
}

for (const route of ['/json/info', '/json/effects', '/json/palettes', '/json']) {
  assert.ok(
    wled.includes(`server.on("${route}", HTTP_OPTIONS, handleOptions)`),
    `${route} should answer PNA OPTIONS preflight before public Studio GET requests`,
  );
}

console.log('private-network-cors tests passed');
