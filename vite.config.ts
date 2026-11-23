import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // GitHub Pages serves project sites from a subpath; dev keeps the root base.
    base: process.env.VITE_BASE ?? '/',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Allow the proxied workspace hostname used for the public preview link.
      allowedHosts: ['.prod-runtime.all-hands.dev'],
      // Forward auth/API calls to the WickSentinel backend during development so
      // the OAuth flow and session checks work through the Vite preview.
      proxy: {
        '/auth': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true },
        '/api': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true },
        '/healthz': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true },
        // The vendored Deriv bot app is served by the backend under /bot; proxy it
        // so the dev preview matches production routing.
        '/bot': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true }
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
