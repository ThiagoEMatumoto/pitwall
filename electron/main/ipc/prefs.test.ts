import { describe, it, expect, vi, beforeEach } from 'vitest'

// Handlers registrados são capturados para exercitar o contrato REAL do canal
// (não só o helper de guarda).
const handlers = new Map<string, (e: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}))

const getPref = vi.fn()
const setPref = vi.fn()
vi.mock('../services/prefs-store', () => ({
  getPref: (key: string, fallback: unknown) => getPref(key, fallback),
  setPref: (key: string, value: unknown) => setPref(key, value),
}))
vi.mock('../services/repo-pull-scheduler', () => ({
  AUTO_PULL_ENABLED_KEY: 'repos.autoPull.enabled',
  AUTO_PULL_INTERVAL_MINUTES_KEY: 'repos.autoPull.intervalMinutes',
  rescheduleAutoPull: vi.fn(),
  runAutoPullNow: vi.fn(),
}))

import { registerPrefsIpc } from './prefs'
import { CUSTOM_ENV_VARS_KEY } from '../services/custom-env'

describe('prefs IPC × segredos', () => {
  beforeEach(() => {
    handlers.clear()
    getPref.mockReset()
    setPref.mockReset()
    registerPrefsIpc()
  })

  it('prefs:get recusa a pref de segredos (o envelope não trafega pelo canal genérico)', () => {
    expect(() => handlers.get('prefs:get')!(null, { key: CUSTOM_ENV_VARS_KEY })).toThrow(
      /secrets:env/,
    )
    expect(getPref).not.toHaveBeenCalled()
  })

  it('prefs:set recusa a pref de segredos (senão regravaria em claro)', () => {
    expect(() =>
      handlers.get('prefs:set')!(null, { key: CUSTOM_ENV_VARS_KEY, value: { A: 'x' } }),
    ).toThrow(/secrets:env/)
    expect(setPref).not.toHaveBeenCalled()
  })

  it('prefs comuns seguem funcionando', () => {
    getPref.mockReturnValue('dark')
    expect(handlers.get('prefs:get')!(null, { key: 'theme' })).toBe('dark')
    handlers.get('prefs:set')!(null, { key: 'theme', value: 'light' })
    expect(setPref).toHaveBeenCalledWith('theme', 'light')
  })
})
