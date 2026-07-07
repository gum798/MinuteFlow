/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        globIgnores: ['**/*.wasm'],           // onnxruntime wasm 22.5MiB — 프리캐시 제외 (Workbox 기본 2MiB 상한도 초과)
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
        // wasm은 프리캐시 대신 첫 사용 시 CacheFirst로 확보 — 오프라인 전사 보장 (runtimeCaching은 크기 상한 미적용)
        runtimeCaching: [
          {
            urlPattern: /\.wasm$/,
            handler: 'CacheFirst',
            options: { cacheName: 'onnx-wasm', expiration: { maxEntries: 4 } },
          },
        ],
      },
      manifest: {
        name: 'MinuteFlow — 음성 회의록',
        short_name: 'MinuteFlow',
        description: '브라우저에서 완결되는 음성 회의록 — 녹음·전사·화자 구분·요약',
        lang: 'ko',
        start_url: '/',
        display: 'standalone',
        background_color: '#F4F5F9',
        theme_color: '#1E43B8',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['fake-indexeddb/auto', './src/test/setup.ts'],
  },
})
