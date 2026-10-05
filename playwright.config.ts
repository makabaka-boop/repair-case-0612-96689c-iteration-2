import { defineConfig, devices } from '@playwright/test';

// e2e 使用的预览端口同样允许 APP_PORT 覆盖（默认 4173，避免与 dev 5173 冲突）。
const port = Number(process.env.APP_PORT ?? 4173);

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
    launchOptions: {
      // 容器内以 root 运行 Chromium 所需
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
