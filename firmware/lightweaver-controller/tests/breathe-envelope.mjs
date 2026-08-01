import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { resolveBreatheScale } from '../../../lightweaver/src/lib/breatheEnvelope.js';

test('firmware breathe envelope matches Studio bytes', () => {
  const temp = mkdtempSync(resolve(os.tmpdir(), 'lw-breathe-'));
  try {
    const cpp = resolve(temp, 'test.cpp');
    const binary = resolve(temp, 'test');
    const header = resolve(import.meta.dirname, '../src/LightweaverBreathe.h');
    const settings = [
      [85, 100, 9],
      [91, 93, 4],
      [0, 100, 30],
      [40, 40, 4],
      [0, 1, 4],
    ];
    writeFileSync(cpp, `#include <iostream>\n#include "${header}"\nint main(){const int settings[][3]={{85,100,9},{91,93,4},{0,100,30},{40,40,4},{0,1,4}};for(const auto& s:settings){const int period=s[2]*1000;for(int t=0;t<=period;t++)std::cout<<s[0]<<","<<s[1]<<","<<s[2]<<","<<t<<","<<int(resolveBreatheScale(t,s[0],s[1],s[2]))<<"\\n";}}`);
    execFileSync('c++', ['-std=c++17', cpp, '-o', binary]);
    const rows = execFileSync(binary, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      .trim().split('\n').map(row => row.split(',').map(Number));
    assert.equal(rows.length, settings.reduce((count, setting) => count + setting[2] * 1000 + 1, 0));
    for (const [lower, upper, cycle, t, actual] of rows) {
      const expected = resolveBreatheScale(t, {
        customBreathe: true,
        breatheLowerPct: lower,
        breatheUpperPct: upper,
        breatheCycleSeconds: cycle,
      });
      assert.equal(actual, expected, `byte mismatch at t=${t}, lower=${lower}, upper=${upper}, cycle=${cycle}`);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
