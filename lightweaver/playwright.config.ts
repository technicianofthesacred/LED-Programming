import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.LIGHTWEAVER_TEST_PORT || 9997);
export default defineConfig({
  testDir: './tests',
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
