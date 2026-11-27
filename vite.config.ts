import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // GitHub Pages serves project sites from a subpath; dev keeps the root base.
    base: process.env.VITE_BASE ?? '/',
    plugins: [react(), tailwindcss()],
    // The vendored Digits app reads NEXT_PUBLIC_* via process.env (a Next.js
    // convention). Vite does not replace process.env, so map the handful it uses
    // to literals. Auth is session-based, so the app id is not needed here.
    define: {
      'process.env.NEXT_PUBLIC_DERIV_APP_ID': JSON.stringify(process.env.DERIV_APP_ID ?? ''),
      'process.env.NEXT_PUBLIC_DERIV_APP_NAME': JSON.stringify('WickSentinel Digits'),
      'process.env.NEXT_PUBLIC_DERIV_SHOW_APP_NAME': JSON.stringify('true'),
      'process.env.NEXT_PUBLIC_DERIV_ENV': JSON.stringify('production'),
      'process.env.NEXT_PUBLIC_PREVIEW_MODE': JSON.stringify('false'),
      'process.env.NEXT_PUBLIC_BASE_PATH': JSON.stringify(''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/digits'),
        '@deriv/core': path.resolve(__dirname, 'src/digits/core/index.ts'),
        '@acc': path.resolve(__dirname, 'src/digits/accumulator'),
      },
    },
    server: {
      // Allow the proxied workspace hostname used for the public preview link.
      allowedHosts: ['.prod-runtime.all-hands.dev'],
      // Forward auth/API calls to the WickSentinel backend during development so
      // the OAuth flow and session checks work through the Vite preview.
      proxy: {
        // `xfwd` forwards the browser's host so the backend can recognise the
        // request as same-origin when the preview is served from a public
        // hostname rather than localhost.
        '/auth': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true, xfwd: true },
        '/api': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true, xfwd: true },
        '/healthz': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true, xfwd: true },
        // The vendored Deriv bot app is served by the backend under /bot; proxy it
        // so the dev preview matches production routing.
        '/bot': { target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787', changeOrigin: true },
        // Compatibility for cached bot bundles whose lazy chunks use /static.
        '/static': {
          target: process.env.BACKEND_ORIGIN ?? 'http://localhost:8787',
          changeOrigin: true,
          rewrite: path => `/bot${path}`,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
