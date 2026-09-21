import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  resolve: {
    // Use the core package's TypeScript sources directly so `pnpm dev` needs no build step.
    alias: { '@photoshare/core': new URL('../../packages/core/src/index.ts', import.meta.url).pathname },
  },
});
