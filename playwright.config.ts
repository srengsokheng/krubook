import { defineConfig, devices } from '@playwright/test';

// Browser tests against a fresh demo database: `npm run build && npm run e2e`.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e-results/artifacts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results/report.json' }]],
  use: { baseURL: 'http://127.0.0.1:4320', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npx tsx e2e/server.ts', url: 'http://127.0.0.1:4320/api/health', reuseExistingServer: false, timeout: 60_000 },
  projects: [
    { name: 'flows', testMatch: /flows\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 860 } } },
    { name: 'desktop', testMatch: /routes\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 860 } }, dependencies: ['flows'] },
    { name: 'tablet', testMatch: /routes\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } }, dependencies: ['flows'] },
    { name: 'mobile', testMatch: /routes\.spec\.ts/, use: { ...devices['Pixel 7'] }, dependencies: ['flows'] },
    { name: 'dark', testMatch: /routes\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 860 }, colorScheme: 'dark' }, dependencies: ['flows'] },
  ],
});
