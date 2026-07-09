import assert from 'node:assert/strict';
import {
  ESP_CONNECT_RESET_SEQUENCE,
  connectEspWithResetSequence,
} from '../src/lib/flashConnection.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.deepEqual(ESP_CONNECT_RESET_SEQUENCE, ['default_reset', 'usb_reset', 'no_reset']);

{
  const attempts = [];
  const disconnected = [];
  const port = { id: 'esp32s3' };

  const result = await connectEspWithResetSequence({
    port,
    createTransport: (_port, attempt) => ({
      attempt,
      disconnect: async () => disconnected.push(attempt.mode),
    }),
    createLoader: ({ transport }) => ({
      main: async mode => {
        attempts.push(mode);
        if (mode !== 'no_reset') {
          throw new Error(`sync failed in ${mode}`);
        }
        return 'ESP32-S3';
      },
      transport,
    }),
  });

  assert.equal(result.chip, 'ESP32-S3');
  assert.deepEqual(attempts, ['default_reset', 'usb_reset', 'no_reset']);
  assert.deepEqual(disconnected, ['default_reset', 'usb_reset']);
}

{
  const attempts = [];

  const result = await connectEspWithResetSequence({
    port: { id: 'auto-reset-board' },
    createTransport: (_port, attempt) => ({
      attempt,
      disconnect: async () => {
        throw new Error('successful transport should stay open');
      },
    }),
    createLoader: ({ transport }) => ({
      main: async mode => {
        attempts.push(mode);
        return 'ESP32-S3';
      },
      transport,
    }),
  });

  assert.equal(result.chip, 'ESP32-S3');
  assert.equal(result.resetMode, 'default_reset');
  assert.deepEqual(attempts, ['default_reset']);
}

{
  await assert.rejects(
    () => connectEspWithResetSequence({
      port: { id: 'dead-board' },
      createTransport: (_port, attempt) => ({
        attempt,
        disconnect: async () => {},
      }),
      createLoader: () => ({
        main: async mode => {
          throw new Error(`sync failed in ${mode}`);
        },
      }),
    }),
    /Failed to connect with the device/,
  );
}

{
  let workflow;
  try {
    workflow = await import('../src/lib/flashWorkflow.js');
  } catch {
    assert.fail('flashWorkflow should export the post-flash release workflow');
  }
  const {
    FLASH_COMPLETE_RELEASED_LOG,
    FLASH_COMPLETE_RELEASED_STATUS,
    flashFirmwareAndRelease,
  } = workflow;
  const calls = [];
  const file = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  const loader = { id: 'loader' };
  const transport = {
    disconnect: async () => calls.push({ type: 'disconnect' }),
  };
  const progress = [];

  await flashFirmwareAndRelease({
    loader,
    transport,
    file,
    address: 0,
    eraseAll: true,
    onProgress: value => progress.push(value),
    flashFirmware: async (...args) => {
      calls.push({
        type: 'flashFirmware',
        loader: args[0].id,
        file: args[1],
        address: args[2],
        eraseAll: args[3],
      });
      args[4](1);
    },
    resetESP: async (...args) => {
      calls.push({
        type: 'resetESP',
        transport: args[0],
      });
    },
  });

  assert.deepEqual(calls, [
    { type: 'flashFirmware', loader: 'loader', file, address: 0, eraseAll: true },
    { type: 'resetESP', transport },
    { type: 'disconnect' },
  ]);
  assert.deepEqual(progress, [1]);
  assert.match(FLASH_COMPLETE_RELEASED_STATUS, /USB released/);
  assert.match(FLASH_COMPLETE_RELEASED_LOG, /Lightweaver-XXXX WiFi/);
}

{
  const screen = readFileSync(resolve(import.meta.dirname, '../src/v3/lw-flash.jsx'), 'utf8');

  assert.match(
    screen,
    /flashFirmwareAndRelease/,
    'Flash screen should use the post-flash release workflow instead of the raw flasher',
  );
  assert.match(
    screen,
    /transportRef\.current/,
    'Flash screen should pass the active serial transport so the workflow can release USB after flashing',
  );
  assert.match(
    screen,
    /FLASH_COMPLETE_RELEASED_STATUS/,
    'Flash screen should show the USB-released completion status',
  );
  assert.match(
    screen,
    /FLASH_COMPLETE_RELEASED_LOG/,
    'Flash screen should log the concrete post-flash WiFi/IP next step',
  );
}

console.log('flash-connect tests passed');
