import assert from 'node:assert/strict';
import {
  LED_COUNT_SLIDER_MAX,
  SPEED_SLIDER_MAX,
  ledCountToSliderValue,
  sliderValueToLedCount,
  sliderValueToCurvedRange,
  sliderValueToSpeed,
  curvedRangeValueToSlider,
  speedToSliderValue,
} from '../src/lib/controlScale.js';

assert.equal(sliderValueToSpeed(0), 0.02);
assert.equal(sliderValueToSpeed(SPEED_SLIDER_MAX), 4);
assert.ok(speedToSliderValue(0.1) - speedToSliderValue(0.02) > speedToSliderValue(4) - speedToSliderValue(3.5));

for (const speed of [0.02, 0.03, 0.1, 0.5, 1, 2, 4]) {
  assert.ok(Math.abs(sliderValueToSpeed(speedToSliderValue(speed)) - speed) < 0.01, `speed round trip ${speed}`);
}

assert.equal(sliderValueToLedCount(0), 1);
assert.equal(sliderValueToLedCount(LED_COUNT_SLIDER_MAX), 3000);
assert.ok(ledCountToSliderValue(20) - ledCountToSliderValue(10) >= 40, '10 to 20 LEDs should not be a tiny slider move');
assert.ok(ledCountToSliderValue(150) >= 650, 'small installs should use most of the default slider travel');
assert.ok(ledCountToSliderValue(3000) - ledCountToSliderValue(1500) <= 60, 'large installs should be compressed into the final gear');

for (const count of [1, 30, 43, 100, 150]) {
  assert.ok(Math.abs(sliderValueToLedCount(ledCountToSliderValue(count)) - count) <= 1, `low LED count round trip ${count}`);
}

for (const count of [300, 1000, 3000]) {
  assert.ok(Math.abs(sliderValueToLedCount(ledCountToSliderValue(count)) - count) <= 10, `geared LED count round trip ${count}`);
}

assert.equal(sliderValueToCurvedRange(0, { min: 0, max: 4 }), 0);
assert.equal(sliderValueToCurvedRange(1000, { min: 0, max: 4 }), 4);
assert.ok(curvedRangeValueToSlider(0.5, { min: 0, max: 4 }) - curvedRangeValueToSlider(0, { min: 0, max: 4 }) > curvedRangeValueToSlider(4, { min: 0, max: 4 }) - curvedRangeValueToSlider(3.5, { min: 0, max: 4 }));

console.log('control-scale tests passed');
