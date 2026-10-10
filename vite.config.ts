import { defineConfig } from 'vite';

// Tüm işlemler tarayıcıda yapılır; sunucu tarafında dosya işleme yoktur.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: 'es',
  },
});
