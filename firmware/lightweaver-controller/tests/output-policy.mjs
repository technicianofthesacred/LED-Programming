import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const testSource = resolve(import.meta.dirname, 'output-policy.cpp');
const tempDir = mkdtempSync(join(tmpdir(), 'lightweaver-output-policy-'));
const testBinary = join(tempDir, 'output-policy');

const adapterContracts = [
  {
    name: 'Art-Net',
    path: resolve(import.meta.dirname, '../src/LightweaverArtnet.cpp'),
    functionName: 'decodePacket',
    rawRgb: [/(?<target>\w+)\s*\[\s*(?<pixel>\w+)\s*\]\s*=\s*CRGB\s*\(\s*(?<channels>\w+)\s*\[\s*(?<channel>\w+)\s*\]\s*,\s*\k<channels>\s*\[\s*\k<channel>\s*\+\s*1\s*\]\s*,\s*\k<channels>\s*\[\s*\k<channel>\s*\+\s*2\s*\]\s*\)/],
    write: /\b\w+\s*\[[^\]]+\]\s*=\s*CRGB\s*\(/,
  },
  {
    name: 'WLED realtime UDP',
    path: resolve(import.meta.dirname, '../src/LightweaverWledRealtime.cpp'),
    functionName: 'handleWledRealtime',
    rawRgb: [/(?<target>\w+)\s*\[\s*(?<pixel>\w+)\s*\]\.r\s*=\s*(?<channels>\w+)\s*\[\s*0\s*\][\s\S]*?\k<target>\s*\[\s*\k<pixel>\s*\]\.g\s*=\s*\k<channels>\s*\[\s*1\s*\][\s\S]*?\k<target>\s*\[\s*\k<pixel>\s*\]\.b\s*=\s*\k<channels>\s*\[\s*2\s*\]/],
    write: /\b\w+\s*\[[^\]]+\]\.r\s*=/,
  },
  {
    name: 'WLED WebSocket',
    path: resolve(import.meta.dirname, '../src/LightweaverWledWebSocket.cpp'),
    functionName: 'applyState',
    rawRgb: [
      /\b\w+\s*\[[^\]]+\]\s*=\s*CRGB\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/,
      /\b\w+\s*\[[^\]]+\]\s*=\s*CRGB\s*\(\s*(?<channels>\w+)\s*\[\s*0\s*\][^,]*,\s*\k<channels>\s*\[\s*1\s*\][^,]*,\s*\k<channels>\s*\[\s*2\s*\][^)]*\)/,
    ],
    write: /\b\w+\s*\[[^\]]+\]\s*=\s*CRGB\s*\(/,
  },
  {
    name: 'WLED JSON API',
    path: resolve(import.meta.dirname, '../src/LightweaverWledJsonApi.cpp'),
    functionName: 'handleStatePost',
    rawRgb: [
      /\b\w+\s*\[[^\]]+\]\s*=\s*CRGB\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/,
      /\b\w+\s*\[[^\]]+\]\s*=\s*CRGB\s*\(\s*(?<channels>\w+)\s*\[\s*0\s*\][^,]*,\s*\k<channels>\s*\[\s*1\s*\][^,]*,\s*\k<channels>\s*\[\s*2\s*\][^)]*\)/,
    ],
    write: /\b\w+\s*\[[^\]]+\]\s*=\s*CRGB\s*\(/,
  },
];

function maskCommentsAndStrings(source) {
  const masked = [...source];
  let state = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        masked[i] = masked[i + 1] = ' ';
        state = 'line-comment';
        i += 1;
      } else if (char === '/' && next === '*') {
        masked[i] = masked[i + 1] = ' ';
        state = 'block-comment';
        i += 1;
      } else if (char === '"' || char === "'") {
        masked[i] = ' ';
        state = char === '"' ? 'string' : 'char';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      else masked[i] = ' ';
    } else if (state === 'block-comment') {
      masked[i] = char === '\n' ? '\n' : ' ';
      if (char === '*' && next === '/') {
        masked[i + 1] = ' ';
        state = 'code';
        i += 1;
      }
    } else {
      masked[i] = char === '\n' ? '\n' : ' ';
      if (char === '\\') {
        if (i + 1 < source.length) masked[i + 1] = ' ';
        i += 1;
      } else if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) {
        state = 'code';
      }
    }
  }
  return masked.join('');
}

function extractFunction(source, functionName) {
  const masked = maskCommentsAndStrings(source);
  const signature = new RegExp(`\\b${functionName}\\s*\\(`);
  let searchFrom = 0;
  let openBrace = -1;
  while (searchFrom < masked.length) {
    const match = signature.exec(masked.slice(searchFrom));
    if (!match) throw new Error(`Cannot find function definition ${functionName}`);
    const signatureEnd = searchFrom + match.index + match[0].length;
    const candidateBrace = masked.indexOf('{', signatureEnd);
    const declarationEnd = masked.indexOf(';', signatureEnd);
    if (candidateBrace >= 0 && (declarationEnd < 0 || candidateBrace < declarationEnd)) {
      openBrace = candidateBrace;
      break;
    }
    searchFrom = declarationEnd + 1;
  }
  if (openBrace < 0) throw new Error(`Cannot find body for function ${functionName}`);

  let depth = 0;
  for (let i = openBrace; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') depth -= 1;
    if (depth === 0) return masked.slice(openBrace + 1, i);
  }
  throw new Error(`Unterminated ingestion function ${functionName}`);
}

function verifyRawLiveSourceContracts() {
  const violations = [];
  const forbiddenScaling = /\b(?:manualBrightness|brightnessScale|brightScale|nscale8)\b/;

  for (const contract of adapterContracts) {
    const source = readFileSync(contract.path, 'utf8');
    const ingestion = extractFunction(source, contract.functionName);
    if (forbiddenScaling.test(ingestion)) {
      violations.push(`${contract.name}: applies ingestion-time brightness scaling`);
    }
    if (!contract.rawRgb.every((pattern) => pattern.test(ingestion))) {
      violations.push(`${contract.name}: does not copy raw R/G/B channels unchanged`);
    }

    const claimIndex = ingestion.indexOf('frameSourceClaim(');
    const writeIndex = ingestion.search(contract.write);
    if (claimIndex < 0 || writeIndex < 0 || claimIndex > writeIndex) {
      violations.push(`${contract.name}: must claim frame ownership before its first pixel write`);
    }
    const markIndex = ingestion.indexOf('frameSourceMarkExternal(', writeIndex);
    if (writeIndex < 0 || markIndex < writeIndex) {
      violations.push(`${contract.name}: must mark accepted frames as external after writing`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`Raw live-source contract violations:\n- ${violations.join('\n- ')}`);
  }
}

function verifyBrightnessSetterContracts() {
  const main = readFileSync(resolve(import.meta.dirname, '../src/main.cpp'), 'utf8');
  const masterSetter = extractFunction(main, 'runtimeSetBrightness');
  const zoneSetter = extractFunction(main, 'runtimeSetBrightnessZ');
  const physicalControls = extractFunction(main, 'handleControlEvent');

  assert.match(masterSetter, /value01\s*<\s*0\.02f/, 'master brightness should retain its 2% lower bound');
  assert.match(masterSetter, /value01\s*>\s*1\.0f/, 'master brightness should retain its 100% upper bound');
  assert.match(masterSetter, /manualBrightness\s*=\s*value01/, 'master brightness should write manualBrightness');
  assert.doesNotMatch(masterSetter, /applyToZones\s*\(/, 'master brightness must not also change zone brightness');

  assert.match(zoneSetter, /value01\s*<\s*0\.02f/, 'zone brightness should retain its 2% lower bound');
  assert.match(zoneSetter, /value01\s*>\s*1\.0f/, 'zone brightness should retain its 100% upper bound');
  assert.match(zoneSetter, /applyToZones\s*\(\s*targetId/, 'zone brightness should use the normal zone targeting rules');
  assert.match(zoneSetter, /z\.brightness\s*=\s*value01/, 'zone brightness should write only the selected zone brightness');
  assert.doesNotMatch(
    zoneSetter,
    /manualBrightness/,
    'zone brightness must never change master brightness, including for an empty target',
  );

  assert.match(
    physicalControls,
    /manualBrightness\s*=\s*applyRotaryBrightness\s*\(\s*manualBrightness/,
    'physical rotary brightness should adjust the master brightness',
  );
  assert.doesNotMatch(physicalControls, /applyToZones\s*\(/, 'physical rotary brightness must not change zone brightness');
  assert.doesNotMatch(physicalControls, /runtimeSetBrightnessZ\s*\(/, 'physical rotary brightness must not route through zone brightness');
}

function verifyOutputFunnelContracts() {
  const main = readFileSync(resolve(import.meta.dirname, '../src/main.cpp'), 'utf8');
  assert.match(main, /void\s+transmitPhysicalLeds\s*\(/,
    'firmware should define a sole low-level physical transmitter');
  assert.match(main, /void\s+clearPhysicalLeds\s*\(/,
    'firmware should define a diagnostics-aware physical safety clear');
  const brightness = extractFunction(main, 'computeBrightnessByte');
  const copy = extractFunction(main, 'copyLogicalToPhysicalLeds');
  const normalShow = extractFunction(main, 'showLeds');
  const physicalPush = extractFunction(main, 'pushPhysicalLeds');
  const physicalTransmit = extractFunction(main, 'transmitPhysicalLeds');
  const physicalClear = extractFunction(main, 'clearPhysicalLeds');
  const runtimeLoop = extractFunction(main, 'loop');

  assert.match(brightness, /OutputBrightnessInputs\s+input\s*\{\s*\}/,
    'runtime brightness should be composed through OutputBrightnessInputs');
  for (const assignment of [
    /input\.brightnessLimit\s*=\s*brightnessLimit/,
    /input\.lookBrightness\s*=/,
    /input\.fadeScale\s*=\s*fadeScale/,
    /input\.knob\s*=/,
    /input\.manualBrightness\s*=\s*manualBrightness/,
    /input\.blackedOut\s*=\s*blackedOut/,
  ]) {
    assert.match(brightness, assignment, 'runtime brightness should populate every policy input');
  }
  assert.match(
    brightness,
    /composeOutputBrightness\s*\(\s*input\s*,\s*frameSourceIsStreaming\s*\(\s*\)\s*\?\s*OUTPUT_EXTERNAL\s*:\s*OUTPUT_LOCAL\s*\)/,
    'streaming frames should use the external output class and local frames the local class',
  );

  assert.match(copy, /outputColorPipeline\.transform\s*\(\s*leds\s*\[\s*i\s*\]\s*,\s*ledColorOrderCode\s*\)/,
    'logical pixels should pass through the configured output color pipeline');
  assert.doesNotMatch(copy, /leds\s*\[\s*i\s*\]\s*=/,
    'the physical copy seam must not mutate the logical canvas');

  assert.match(normalShow, /pushPhysicalLeds\s*\(\s*computeBrightnessByte\s*\(\s*\)/,
    'normal showLeds should compose brightness before entering the physical funnel');
  assert.match(physicalPush, /copyLogicalToPhysicalLeds\s*\(\s*\)/,
    'the shared physical funnel should own the logical-to-physical copy');
  assert.match(physicalPush, /transmitPhysicalLeds\s*\(\s*brightnessByte\s*,\s*sourceClass\s*\)/,
    'normal output should delegate to the sole physical transmitter after copying');
  assert.match(physicalTransmit, /FastLED\.setBrightness\s*\(\s*brightnessByte\s*\)/,
    'the sole physical transmitter should own FastLED brightness');
  assert.match(physicalTransmit, /lastOutputBrightnessByte\s*=\s*brightnessByte/,
    'the sole physical transmitter should update brightness diagnostics');
  assert.match(physicalTransmit, /lastOutputSourceClass\s*=\s*sourceClass/,
    'the sole physical transmitter should update source diagnostics');
  assert.match(physicalTransmit, /FastLED\.show\s*\(\s*\)/,
    'the sole physical transmitter should own the physical show call');
  assert.match(physicalTransmit, /recordPhysicalShow\s*\(\s*\)/,
    'the sole physical transmitter should count successful physical shows');
  assert.equal((main.match(/FastLED\.show\s*\(\s*\)/g) || []).length, 1,
    'firmware should contain exactly one FastLED.show() site');

  assert.doesNotMatch(main, /FastLED\.clear\s*\(\s*true\s*\)/,
    'safety clears must not transmit outside the physical output funnel');
  assert.match(physicalClear, /fill_solid\s*\(\s*physicalLeds\s*,[^,]+,\s*CRGB::Black\s*\)/,
    'safety clears should black only the physical buffer');
  assert.doesNotMatch(physicalClear, /\bleds\s*\[/,
    'safety clears must preserve the logical canvas');
  assert.match(physicalClear, /transmitPhysicalLeds\s*\(\s*0\s*,\s*OUTPUT_LOCAL\s*\)/,
    'safety clears should transmit black at zero brightness through the diagnostics funnel');

  assert.match(main, /void\s+showLeds\s*\(\s*uint8_t\s+brightnessByte\s*\)/,
    'special output modes should use an explicit-brightness show overload');
  assert.match(main, /showLeds\s*\(\s*220\s*\)/,
    'identify should preserve its explicit brightness through the shared funnel');
  assert.match(main, /showLeds\s*\(\s*uint8_t\s*\(\s*clampUnit\s*\(\s*brightnessLimit\s*\)\s*\*\s*255\.0f\s*\)\s*\)/,
    'AP recovery should preserve its brightness-limit output through the shared funnel');

  assert.match(main, /outputColorPipeline\.configure\s*\(\s*config\.outputColor\s*\)/,
    'runtime config should configure the shared output color pipeline');
  assert.match(main, /FastLED\.setDither\s*\(\s*false\s*\)/,
    'temporal dithering should start disabled');
  assert.match(main, /measuredOutputFps\s*>=\s*50/,
    'temporal dithering should enable only at 50 measured physical shows per second');
  assert.match(main, /measuredOutputFps\s*<\s*40/,
    'temporal dithering should disable below 40 measured physical shows per second');
  assert.match(runtimeLoop, /updateOutputTelemetry\s*\(\s*now\s*\)/,
    'the existing runtime loop should publish zero FPS and disable dithering when physical shows stop');
}

try {
  execFileSync('c++', ['-std=c++17', testSource, '-o', testBinary], {
    stdio: 'inherit',
  });
  execFileSync(testBinary, { stdio: 'inherit' });
  verifyBrightnessSetterContracts();
  verifyRawLiveSourceContracts();
  verifyOutputFunnelContracts();
  console.log('output-policy tests passed');
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
