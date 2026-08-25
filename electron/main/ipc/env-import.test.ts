import { describe, it, expect, vi, beforeEach } from 'vitest'

// Handlers registrados são capturados para exercitar o contrato REAL do canal
// (padrão de prefs.test.ts).
const handlers = new Map<string, (e: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

const scanEnvSources = vi.fn()
const applyImport = vi.fn()
vi.mock('../services/env-import', () => ({
  scanEnvSources: (...args: unknown[]) => scanEnvSources(...args),
  applyImport: (...args: unknown[]) => applyImport(...args),
}))

const resetDossierPipeline = vi.fn()
vi.mock('../services/dossier-pipeline-singleton', () => ({
  resetDossierPipeline: () => resetDossierPipeline(),
}))

import { registerEnvImportIpc } from './env-import'

describe('env-import IPC', () => {
  beforeEach(() => {
    handlers.clear()
    scanEnvSources.mockReset()
    applyImport.mockReset()
    resetDossierPipeline.mockReset()
    registerEnvImportIpc()
  })

  it('secrets:import:scan delega ao scanner (sem payload)', () => {
    const candidates = [
      { key: 'A', sources: [{ path: '/x/.env', fingerprint: '••••abcd (12)' }], status: 'new' },
    ]
    scanEnvSources.mockReturnValue(candidates)
    expect(handlers.get('secrets:import:scan')!(null, undefined)).toBe(candidates)
  })

  it('secrets:import:apply valida payload e repassa as seleções', () => {
    const result = { applied: ['A'], missing: [], plaintext: [] }
    applyImport.mockReturnValue(result)
    const out = handlers.get('secrets:import:apply')!(null, {
      selections: [{ key: 'A', sourcePath: '/x/.env' }],
    })
    expect(out).toBe(result)
    expect(applyImport).toHaveBeenCalledWith([{ key: 'A', sourcePath: '/x/.env' }])
  })

  it('apply com credencial gravada invalida o dossier pipeline', () => {
    applyImport.mockReturnValue({ applied: ['A'], missing: [], plaintext: [] })
    handlers.get('secrets:import:apply')!(null, {
      selections: [{ key: 'A', sourcePath: '/x/.env' }],
    })
    expect(resetDossierPipeline).toHaveBeenCalledTimes(1)
  })

  it('apply sem nada gravado não invalida o pipeline', () => {
    applyImport.mockReturnValue({ applied: [], missing: ['A'], plaintext: [] })
    handlers.get('secrets:import:apply')!(null, {
      selections: [{ key: 'A', sourcePath: '/x/.env' }],
    })
    expect(resetDossierPipeline).not.toHaveBeenCalled()
  })

  it('apply rejeita payload malformado (zod) sem tocar no service', () => {
    expect(() =>
      handlers.get('secrets:import:apply')!(null, { selections: [{ key: '' }] }),
    ).toThrow()
    expect(applyImport).not.toHaveBeenCalled()
  })
})
