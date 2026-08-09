import { defineConfig, devices } from '@playwright/test';
import { testPort } from './testPort.mjs';

const windowlessPort = testPort + 1;

export default defineConfig({
  testDir: '.',
  testMatch: /windowless-.*\.spec\.ts/,
  use: {
    baseURL: `http://127.0.0.1:${windowlessPort}`,
    serviceWorkers: 'allow',
  },
  webServer: {
    command: `npm run build && node windowless-preview.mjs ${windowlessPort}`,
    port: windowlessPort,
    reuseExistingServer: false,
    timeout: 60000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
