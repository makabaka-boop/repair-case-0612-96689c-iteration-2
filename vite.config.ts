/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 宿主端口（容器/发布环境）由 APP_PORT 覆盖；本地默认 5173。
const port = Number(process.env.APP_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port,
    strictPort: true,
  },
  preview: {
    host: true,
    port,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
