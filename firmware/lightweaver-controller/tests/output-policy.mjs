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
  const match = signature.exec(masked);
  if (!match) throw new Error(`Cannot find ingestion function ${functionName}`);

  const openBrace = masked.indexOf('{', match.index + match[0].length);
  if (openBrace < 0) throw new Error(`Cannot find body for ingestion function ${functionName}`);

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

try {
  execFileSync('c++', ['-std=c++17', testSource, '-o', testBinary], {
    stdio: 'inherit',
  });
  execFileSync(testBinary, { stdio: 'inherit' });
  verifyRawLiveSourceContracts();
  console.log('output-policy tests passed');
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
