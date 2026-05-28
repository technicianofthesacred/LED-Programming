import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readUsbLedConfig,
  writeUsbLedConfig,
} from '../server/usbLedConfigStore.js';

const dir = mkdtempSync(join(tmpdir(), 'lw-usb-config-'));
const path = join(dir, 'config.json');

try {
  assert.deepEqual(readUsbLedConfig(path), {});
  writeUsbLedConfig(path, { colorOrder: 'grb', ignored: true });
  assert.deepEqual(readUsbLedConfig(path), { colorOrder: 'GRB' });
  writeUsbLedConfig(path, { colorOrder: 'nope' });
  assert.deepEqual(readUsbLedConfig(path), { colorOrder: 'RGB' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const firmwareConfig = readFileSync('../firmware/lightweaver-usb-led-test/platformio.ini', 'utf8');
assert.match(firmwareConfig, /-DLW_ENCODER_REVERSED=1\b/);
assert.match(firmwareConfig, /-DLW_ENCODER_PRESS_ALT_PIN=6\b/);

console.log('usb-led-config tests passed');
