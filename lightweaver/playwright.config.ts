import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://localhost:9997' },
  webServer: {
    command: 'npx vite --port 9997 --strictPort',
    port: 9997,
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
