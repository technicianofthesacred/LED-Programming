import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleLibraryPagesRequest } from '../functions/api/library/[[path]].js';

const headers = readFileSync(resolve(import.meta.dirname, '../public/_headers'), 'utf8');

assert.match(headers, /^\/\*$/m, 'root deployment headers must apply to every Studio route');
assert.doesNotMatch(headers, /^\/design/m, 'headers must not preserve the removed deployment mount');

assert.doesNotMatch(
  headers,
  /^ \s*X-Frame-Options:/im,
  'Studio keeps legacy iframe compatibility for already-installed cards',
);

const cspLine = headers.split('\n').find(line => /Content-Security-Policy:/i.test(line)) || '';
assert.match(cspLine, /frame-ancestors[^;\n]+https:\/\/led\.mandalacodes\.com/);
assert.match(cspLine, /frame-ancestors[^;\n]+http:\/\/lightweaver\.local:\*/);
assert.match(cspLine, /frame-ancestors[^;\n]+http:\/\/192\.168\.4\.1:\*/);

const unauthenticatedLibraryResponse = await handleLibraryPagesRequest({
  request: new Request('https://led.mandalacodes.com/api/library/session'),
  env: {},
  params: { path: ['session'] },
});
assert.equal(unauthenticatedLibraryResponse.status, 401, 'the Function must deny a missing Access assertion');
assert.equal(
  unauthenticatedLibraryResponse.headers.get('cache-control'),
  'no-store',
  'even API authentication failures must be explicitly non-cacheable',
);

console.log('pages-headers tests passed');
