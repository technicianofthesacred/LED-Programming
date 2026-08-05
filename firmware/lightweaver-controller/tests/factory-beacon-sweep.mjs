// The blank-card beacon must pulse every port it registered, and only those.
//
// LW_APPROVED_OUTPUT_GPIO_COUNT went from 4 to 15 when the pin menu widened.
// setupFactoryBeaconOutputs() skips any approved GPIO a control claims, and the
// STOCK control assignment claims 4/5/6/7 — the first four entries of the menu.
// showFactoryBeaconFrame() stepped over the whole menu regardless, so those four
// steps filled a buffer region no FastLED controller drives: a freshly flashed
// card was dark for the first 12 seconds of every sweep. That is precisely the
// "this card is dead, pull the power" misdiagnosis the beacon exists to prevent.
//
// This runs the SHIPPED function bodies on the host rather than pattern-matching
// the source: the runner slices setupFactoryBeaconOutputs and
// showFactoryBeaconFrame out of main.cpp into factory-beacon-sweep.cpp, which
// supplies the clock, the buffer and the FastLED registration stub, then asserts
// the lit set equals the registered set over a full sweep.
//
// Optional argv[2] points the slice at a different main.cpp, which is how the
// pre-fix failure was demonstrated.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const mainPath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'src/main.cpp');
const main = readFileSync(mainPath, 'utf8');

// Slice one whole function definition out of a translation unit by matching
// braces from its signature, skipping the forward declaration.
function sliceFunction(source, signature) {
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

const extracted = [
  sliceFunction(main, 'bool setupFactoryBeaconOutputs('),
  sliceFunction(main, 'void showFactoryBeaconFrame('),
].join('\n\n');

// The stock control assignment is the premise of the first scenario below. If
// the defaults ever move, this test's "the first four menu entries are claimed"
// case stops describing the card Adrian actually flashes.
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');
const resetControls = sliceFunction(storage, 'void resetControls(');
for (const [field, pin] of [['encoderA', 4], ['encoderB', 5], ['encoderPressAlt', 6], ['previous', 7]]) {
  assert.match(resetControls, new RegExp(`controls\\.${field}\\s*=\\s*${pin};`),
    `the stock control assignment must still claim GPIO ${pin}`);
}

const temp = mkdtempSync(resolve(os.tmpdir(), 'lw-factory-beacon-sweep-'));
try {
  writeFileSync(resolve(temp, 'extracted-factory-beacon.inc'), `${extracted}\n`);
  const binary = resolve(temp, 'factory-beacon-sweep');
  execFileSync('c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror',
    '-I', temp,
    '-I', resolve(import.meta.dirname, 'host-stubs'),
    '-I', resolve(root, 'src'),
    resolve(import.meta.dirname, 'factory-beacon-sweep.cpp'),
    '-o', binary,
  ], { stdio: 'inherit' });

  // Scenario 1: the card as flashed — stock controls claim 4/5/6/7, which are
  // the first four entries of the approved output menu.
  execFileSync(binary, ['4', '5', '6', '7'], { stdio: 'inherit' });
  // Scenario 2: every approved GPIO free (controls moved off the menu).
  execFileSync(binary, [], { stdio: 'inherit' });
  // Scenario 3: a claimed pin in the MIDDLE of the menu, so the step list has
  // to follow the runtime control assignment rather than skip a fixed prefix.
  execFileSync(binary, ['21'], { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// The sweep is the worst-case wait before an owner calls a blank card dead, so
// widening the pin menu again has to be a decision, not a silent regression.
assert.match(main, /constexpr uint32_t LW_FACTORY_BEACON_MAX_SWEEP_MS = (\d+);/,
  'the beacon must declare a ceiling for its total sweep length');
assert.match(
  main,
  /static_assert\(LW_APPROVED_OUTPUT_GPIO_COUNT \* LW_FACTORY_BEACON_STEP_MS <=\s*LW_FACTORY_BEACON_MAX_SWEEP_MS,/,
  'widening the pin menu past the sweep ceiling must fail the build',
);

console.log('factory-beacon-sweep tests passed');
