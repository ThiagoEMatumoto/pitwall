import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Builds the artboard iframe runtime as a single dependency-free IIFE. The
// main process reads out/design-runtime/runtime.js once and inlines it into
// every artboard document under a CSP nonce, so the output must be a plain
// script: no import/export, no hashed filename.
export default defineConfig({
  build: {
    outDir: 'out/design-runtime',
    emptyOutDir: true,
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: resolve('src/design-runtime/runtime/index.ts'),
      name: 'PitwallDesignRuntime',
      formats: ['iife'],
      fileName: () => 'runtime.js',
    },
  },
})
