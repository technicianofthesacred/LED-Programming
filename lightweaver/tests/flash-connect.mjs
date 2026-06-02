import assert from 'node:assert/strict';
import {
  ESP_CONNECT_RESET_SEQUENCE,
  connectEspWithResetSequence,
} from '../src/lib/flashConnection.js';

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

console.log('flash-connect tests passed');
