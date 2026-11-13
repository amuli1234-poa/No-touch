import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

/**
 * WickSentinel Admin — an independently deployable application.
 *
 * It has its own entry HTML, its own source root and its own build output
 * (`dist-admin/`), so it can be deployed to a separate origin from the trader
 * app without touching the trader build. In development it proxies the admin
 * API to the WickSentinel backend on :8787.
 */
export default defineConfig(() => {
  return {
    root: path.resolve(import.meta.dirname),
    base: process.env.ADMIN_BASE ?? '/',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, 'src') }
    },
    build: {
      outDir: path.resolve(import.meta.dirname, '../dist-admin'),
      emptyOutDir: true,
      sourcemap: false
    },
    server: {
      port: Number(process.env.ADMIN_PORT ?? 3001),
      host: '0.0.0.0',
      allowedHosts: ['.prod-runtime.all-hands.dev'],
      proxy: {
        '/api/admin': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true },
        '/healthz': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true }
      },
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {}
    }
  };
});
