import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const headers = readFileSync(resolve(import.meta.dirname, '../public/_headers'), 'utf8');

assert.match(headers, /^\/\*$/m, 'root deployment headers must apply to every Studio route');
assert.doesNotMatch(headers, /^\/design/m, 'headers must not preserve the removed deployment mount');

assert.doesNotMatch(
  headers,
  /^ \s*X-Frame-Options:/im,
  'Studio must not send X-Frame-Options because the card page embeds it in an iframe for Edit in Studio',
);

const cspLine = headers.split('\n').find(line => /Content-Security-Policy:/i.test(line)) || '';
assert.match(cspLine, /frame-ancestors[^;\n]+https:\/\/led\.mandalacodes\.com/);
assert.match(cspLine, /frame-ancestors[^;\n]+http:\/\/lightweaver\.local:\*/);
assert.match(cspLine, /frame-ancestors[^;\n]+http:\/\/192\.168\.4\.1:\*/);

console.log('pages-headers tests passed');
