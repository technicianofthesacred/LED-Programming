import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const sourceDir = path.join(repoDir, 'firmware/lightweaver-controller/src');
const controlsSource = path.join(sourceDir, 'LightweaverControls.cpp');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-rotary-direction-'));
const includeDir = path.join(tmpDir, 'include');
fs.mkdirSync(includeDir);

fs.writeFileSync(path.join(includeDir, 'Arduino.h'), `
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
using String = std::string;
using std::max;
using std::min;
#define LOW 0
#define HIGH 1
#define INPUT_PULLUP 2
#define OUTPUT 1
int digitalRead(int pin);
void pinMode(int pin, int mode);
uint32_t millis();
`);

fs.writeFileSync(path.join(includeDir, 'FastLED.h'), '#pragma once\n');
fs.writeFileSync(path.join(includeDir, 'SD.h'), '#pragma once\n');

const harness = path.join(tmpDir, 'rotary_direction_test.cpp');
fs.writeFileSync(harness, `
#include <Arduino.h>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

int pinValues[64];
uint32_t fakeMillis = 1000;

int digitalRead(int pin) {
  if (pin < 0 || pin >= 64) return HIGH;
  return pinValues[pin];
}

void pinMode(int, int) {}

uint32_t millis() {
  return fakeMillis;
}

#include ${JSON.stringify(controlsSource)}

void setEncoderState(uint8_t state) {
  pinValues[4] = (state & 0b10) ? LOW : HIGH;
  pinValues[5] = (state & 0b01) ? LOW : HIGH;
}

ControlEventType runSequence(const std::vector<uint8_t>& sequence, const String& rotateDirection) {
  for (int& pinValue : pinValues) pinValue = HIGH;
  ControlsConfig controls;
  controls.encoderA = 4;
  controls.encoderB = 5;
  controls.encoderPress = -1;
  controls.encoderPressAlt = -1;
  controls.previous = -1;
  controls.next = -1;
  controls.blackout = -1;
  controls.statusLed = -1;
  controls.rotateDirection = rotateDirection;
  controls.brightnessStep = 18;

  ControlState state;
  setEncoderState(sequence.front());
  setupLightweaverControls(controls, state);

  ControlEventType last = CONTROL_NONE;
  for (size_t i = 1; i < sequence.size(); i++) {
    fakeMillis += 5;
    setEncoderState(sequence[i]);
    ControlEventType event = pollLightweaverControls(controls, state);
    if (event != CONTROL_NONE) last = event;
  }
  return last;
}

int main() {
  const std::vector<uint8_t> physicalClockwise = {0b00, 0b10, 0b11, 0b01, 0b00};
  const std::vector<uint8_t> physicalCounterclockwise = {0b00, 0b01, 0b11, 0b10, 0b00};

  assert(runSequence(physicalClockwise, "clockwise-brighter") == CONTROL_BRIGHTER);
  assert(runSequence(physicalCounterclockwise, "clockwise-brighter") == CONTROL_DIMMER);
  assert(runSequence(physicalClockwise, "clockwise-dimmer") == CONTROL_DIMMER);
  assert(runSequence(physicalCounterclockwise, "clockwise-dimmer") == CONTROL_BRIGHTER);

  return 0;
}
`);

const candidates = [
  process.env.CXX,
  '/usr/bin/clang++',
  'clang++',
  'g++',
].filter(Boolean);

let lastError = null;
for (const compiler of candidates) {
  try {
    execFileSync(compiler, [
      '-std=c++17',
      '-I', includeDir,
      '-I', sourceDir,
      harness,
      '-o', path.join(tmpDir, 'rotary_direction_test'),
    ], { stdio: 'inherit' });
    execFileSync(path.join(tmpDir, 'rotary_direction_test'), { stdio: 'inherit' });
    console.log('standalone rotary direction tests passed');
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (error.code === 'ENOENT') continue;
    break;
  }
}

assert.fail(`standalone rotary direction test failed: ${lastError?.message || 'no C++ compiler found'}`);
