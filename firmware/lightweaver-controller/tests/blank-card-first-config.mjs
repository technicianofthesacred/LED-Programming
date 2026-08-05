// A blank card must not stage its first config.
//
// runtimeConfigJsonChangesWiring() drives the candidate/probation dance in
// handleConfigPost. That dance protects a KNOWN-GOOD layout from a bad rewire.
// A card with zero outputs has none, and staging strands it permanently:
// activating a candidate requires commandReady, which a zero-output card never
// reaches because the factory beacon owns the render loop. The card would sit
// holding an unapplied config forever and the owner could never light a strip.
//
// This runs the SHIPPED function body on the host rather than pattern-matching
// the source: the runner slices runtimeConfigJsonChangesWiring out of
// LightweaverStorage.cpp and compiles it into blank-card-first-config.cpp,
// which supplies the RuntimeConfig fixtures and stubs the strict validator.
//
// Optional argv[2] points the slice at a different LightweaverStorage.cpp,
// which is how the pre-fix failure was demonstrated.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const storagePath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'src/LightweaverStorage.cpp');
const storage = readFileSync(storagePath, 'utf8');

// Slice one whole function definition out of a translation unit by matching
// braces from its signature. Fails loudly if the function is renamed — the
// contract this test guards is the function itself, not its neighbours.
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

const changesWiring = sliceFunction(storage, 'bool runtimeConfigJsonChangesWiring(');

const temp = mkdtempSync(resolve(os.tmpdir(), 'lw-blank-first-config-'));
try {
  writeFileSync(resolve(temp, 'extracted-changes-wiring.inc'), `${changesWiring}\n`);
  const binary = resolve(temp, 'blank-card-first-config');
  execFileSync('c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror',
    '-I', temp,
    '-I', resolve(import.meta.dirname, 'host-stubs'),
    '-I', resolve(root, 'src'),
    resolve(import.meta.dirname, 'blank-card-first-config.cpp'),
    '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// The WHY belongs in the firmware, not only here: the next reader of this
// guard has to know it is a deliberate exemption and not a missing check.
const guard = changesWiring.slice(0, changesWiring.indexOf('parsed->outputCount != current.outputCount'));
assert.match(guard, /if \(current\.outputCount == 0\)/,
  'the blank-card exemption must be decided before the wiring diff runs');
assert.match(guard, /known-good|candidate|probation/i,
  'the blank-card exemption must say WHY staging is skipped');

// The other half of the contract Studio is written against: with no wiring
// change reported, handleConfigPost saves, applies and answers requiresReboot.
const web = readFileSync(resolve(root, 'src/LightweaverWeb.cpp'), 'utf8');
const handleConfigPost = sliceFunction(web, 'void handleConfigPost()');
assert.match(handleConfigPost, /if \(wiringChanged\) \{[\s\S]*stageRuntimeConfigJson/,
  'a card that already has outputs must still stage a wiring change');
assert.match(handleConfigPost, /saveRuntimeConfigJson[\s\S]*runtimeApplySavedConfig\(\);[\s\S]*runtimeMarkRestartPending\(\);/,
  'the no-wiring-change path must save, apply and mark the restart pending');
assert.match(handleConfigPost, /\\"ok\\":true[\s\S]*\\"requiresReboot\\":true/,
  '/api/config must answer the ordinary applied shape when nothing is staged');

console.log('blank-card-first-config tests passed');
