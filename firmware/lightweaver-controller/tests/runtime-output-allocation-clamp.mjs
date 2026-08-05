// No write in copyLogicalToPhysicalLeds may leave the boot allocation.
//
// applyRuntimeConfig() used to clamp only totalPixels, which reads like a
// safety net and is not one: copyLogicalToPhysicalLeds bounds its loop on the
// LOGICAL index but writes physicalLeds[start + segment.count - 1 - offset] on
// a reversed segment, and setupLedOutputs hands FastLED the raw slice
// physicalLeds + start for output.pixels entries. Both of those indices come
// from the output and segment lengths, so an oversized output applied before
// the pending reboot ran off the end of the heap allocation while totalPixels
// looked safe.
//
// The harness compiles the SHIPPED text of clampRuntimeOutputsToAllocation,
// computeColorOrderCode and copyLogicalToPhysicalLeds — sliced straight out of
// main.cpp — so it proves the invariant on the code that runs, not on a
// restatement of it.
//
// Optional argv[2] points the slice at a different main.cpp, which is how the
// pre-fix overflow was demonstrated.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const mainPath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'src/main.cpp');
const main = readFileSync(mainPath, 'utf8');

function sliceFunction(source, signature) {
  // The signature may be a prefix (parameters elided), and main.cpp declares
  // most of these ahead of their definitions, so accept only the occurrence
  // whose parameter list is followed by a body rather than a semicolon.
  for (let at = source.indexOf(signature); at !== -1; at = source.indexOf(signature, at + 1)) {
    let parens = 0;
    let cursor = at;
    for (; cursor < source.length; cursor++) {
      if (source[cursor] === '(') parens++;
      else if (source[cursor] === ')' && --parens === 0) break;
    }
    const bodyStart = source.slice(cursor + 1).search(/\S/) + cursor + 1;
    if (source[bodyStart] !== '{') continue;
    let depth = 0;
    for (let index = bodyStart; index < source.length; index++) {
      if (source[index] === '{') depth++;
      else if (source[index] === '}' && --depth === 0) return source.slice(at, index + 1);
    }
    throw new Error(`unbalanced braces in ${signature}`);
  }
  throw new Error(`could not find the definition of ${signature}`);
}

// computeColorOrderCode comes along because copyLogicalToPhysicalLeds calls it
// on every frame; it is pure and carries no globals of its own.
const extracted = [
  sliceFunction(main, 'void clampRuntimeOutputsToAllocation()'),
  sliceFunction(main, 'uint8_t computeColorOrderCode(const String& order)'),
  sliceFunction(main, 'void copyLogicalToPhysicalLeds()'),
].join('\n\n');

const temp = mkdtempSync(resolve(os.tmpdir(), 'lw-output-clamp-'));
try {
  writeFileSync(resolve(temp, 'extracted-output-clamp.inc'), `${extracted}\n`);
  const binary = resolve(temp, 'runtime-output-allocation-clamp');
  execFileSync('c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror',
    '-I', temp,
    '-I', resolve(import.meta.dirname, 'host-stubs'),
    '-I', resolve(root, 'src'),
    resolve(import.meta.dirname, 'runtime-output-allocation-clamp.cpp'),
    '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// applyRuntimeConfig must actually use the clamp — the invariant is worthless
// if the one caller that changes the live geometry skips it.
const applyRuntimeConfig = sliceFunction(main, 'void applyRuntimeConfig(const RuntimeConfig& config)');
assert.match(applyRuntimeConfig, /clampRuntimeOutputsToAllocation\(\);/,
  'applyRuntimeConfig must fit the live geometry to the boot allocation');
assert.doesNotMatch(applyRuntimeConfig, /totalPixels = allocatedPixels;/,
  'clamping totalPixels alone was the misleading half-measure this replaced');
assert.match(applyRuntimeConfig, /uint32_t requestedPixels/,
  'the requested total must be accumulated in 32 bits or four maximum-width outputs wrap');

console.log('runtime-output-allocation-clamp tests passed');
