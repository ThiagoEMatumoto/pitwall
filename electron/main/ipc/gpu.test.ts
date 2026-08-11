import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (e: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), quit: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

const getPref = vi.fn()
const setPref = vi.fn()
vi.mock('../services/prefs-store', () => ({
  getPref: (key: string, fallback: unknown) => getPref(key, fallback),
  setPref: (key: string, value: unknown) => setPref(key, value),
}))

import { registerGpuIpc } from './gpu'
import { OZONE_PREF_KEY } from '../services/gpu-state'

describe('gpu IPC × Wayland nativo', () => {
  beforeEach(() => {
    handlers.clear()
    getPref.mockReset()
    setPref.mockReset()
    getPref.mockImplementation((_key: string, fallback: unknown) => fallback)
    registerGpuIpc()
  })

  // O default LIGADO é o que tira o app do XWayland (onde tecla travada vira
  // digitação fantasma). Sem pref gravada, gpu:status precisa reportar ligado —
  // senão a UI mostra "requer reiniciar" eterno contra o estado real do boot.
  it('gpu:status reporta ozone ligado quando não há pref gravada', () => {
    const status = handlers.get('gpu:status')!(null, undefined) as { prefOzone: boolean }
    expect(getPref).toHaveBeenCalledWith(OZONE_PREF_KEY, true)
    expect(status.prefOzone).toBe(true)
  })

  it('gpu:status respeita o opt-out gravado', () => {
    getPref.mockImplementation((key: string, fallback: unknown) =>
      key === OZONE_PREF_KEY ? false : fallback,
    )
    const status = handlers.get('gpu:status')!(null, undefined) as { prefOzone: boolean }
    expect(status.prefOzone).toBe(false)
  })

  it('gpu:set-ozone grava a pref e recusa payload não-booleano', () => {
    handlers.get('gpu:set-ozone')!(null, false)
    expect(setPref).toHaveBeenCalledWith(OZONE_PREF_KEY, false)
    expect(() => handlers.get('gpu:set-ozone')!(null, 'sim')).toThrow()
  })
})
