/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Manga — PLUNZ',
        short_name: 'Manga',
        description: 'Find, read, and send manga to your Kindle. Your library stays on your device.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0f0f0f',
        theme_color: '#0f0f0f',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{html,js,css,svg,png,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/privacy(\.html)?$/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Covers are small and safe to reuse offline; chapter pages are stored explicitly in IndexedDB.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/mangadex/covers/'),
            handler: 'CacheFirst',
            options: { cacheName: 'covers', expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['src/test/setup.ts'], include: ['src/**/*.test.ts', 'worker/**/*.test.ts'] },
  // Tests run Solid's client build: under Node, solid-js resolves to its
  // server build, where signal and store writes are inert.
  ...(process.env.VITEST
    ? { resolve: { conditions: ['browser', 'development'] }, ssr: { resolve: { conditions: ['browser', 'development'] } } }
    : {}),
});
