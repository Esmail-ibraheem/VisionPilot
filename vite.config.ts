import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: {
    // Pre-bundle the lazily imported detector packages so the first perception start does not
    // trigger a dependency re-optimisation and page reload in dev.
    include: ['@tensorflow/tfjs', '@tensorflow-models/coco-ssd'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 90000,
  },
});
