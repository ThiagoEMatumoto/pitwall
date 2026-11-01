import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Teto de workers: com o padrão (≈ nº de CPUs, 23 nesta máquina de 24) cada
// worker chega a 0,6-1,4 GB, e duas suítes ao mesmo tempo derrubaram a sessão
// gráfica em 10/10 (scope da sessão a 27,9 GB). VITEST_MAX_WORKERS sobrescreve.
function maxWorkers(): number {
  const fromEnv = Number(process.env.VITEST_MAX_WORKERS)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 4)))
}

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
    maxWorkers: maxWorkers(),
    minWorkers: 1,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // Só testes unitários — o Playwright cuida de e2e/.
    include: [
      'src/**/*.test.{ts,tsx}',
      'electron/**/*.test.ts',
      'shared/**/*.test.ts',
      'scripts/**/*.test.ts',
      'e2e/driver/**/*.test.ts',
    ],
  },
})
