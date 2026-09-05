import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve('src'),
      '@shared': resolve('shared'),
      '@main': resolve('electron/main'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // Só testes unitários — o Playwright cuida de e2e/.
    include: [
      'src/**/*.test.{ts,tsx}',
      'electron/**/*.test.ts',
      'shared/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
  },
})
