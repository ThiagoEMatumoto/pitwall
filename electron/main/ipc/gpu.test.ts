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
import {
  autoDisableRecord,
  GPU_AUTO_PREF_KEY,
  GPU_DISABLED_BY_USER_PREF_KEY,
  GPU_DISABLED_PREF_KEY,
  OZONE_PREF_KEY,
} from '../services/gpu-state'
import type { GpuStatus } from '../../../shared/types/ipc'

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

describe('gpu IPC × desligamento automático', () => {
  beforeEach(() => {
    handlers.clear()
    getPref.mockReset()
    setPref.mockReset()
    getPref.mockImplementation((_key: string, fallback: unknown) => fallback)
    registerGpuIpc()
  })

  const status = () => handlers.get('gpu:status')!(null, undefined) as GpuStatus

  it('gpu:status expõe o registro gravado pelo automático', () => {
    const record = autoDisableRecord({
      previous: null,
      reason: 'crashed',
      version: '1.0.0',
      now: 1_700_000_000_000,
    })
    const stored: unknown = JSON.parse(JSON.stringify(record))
    getPref.mockImplementation((key: string, fallback: unknown) =>
      key === GPU_AUTO_PREF_KEY ? stored : fallback,
    )
    expect(status().autoDisabled).toEqual(record)
    expect(status().prefDisabled).toBe(false)
  })

  it('gpu:status devolve autoDisabled null sem registro, apagado ou fora do formato', () => {
    expect(status().autoDisabled).toBeNull()
    getPref.mockImplementation((key: string, fallback: unknown) =>
      key === GPU_AUTO_PREF_KEY ? null : fallback,
    )
    expect(status().autoDisabled).toBeNull()
    getPref.mockImplementation((key: string, fallback: unknown) =>
      key === GPU_AUTO_PREF_KEY ? { strikes: 'muitos' } : fallback,
    )
    expect(status().autoDisabled).toBeNull()
  })

  // A marca é o que separa a escolha do usuário do gpu.disabled=true que o
  // automático antigo gravou: sem ela o boot trataria o manual como legado.
  it('gpu:set-disabled(true) grava a pref com a marca de escolha do usuário', () => {
    handlers.get('gpu:set-disabled')!(null, true)
    expect(setPref).toHaveBeenCalledWith(GPU_DISABLED_PREF_KEY, true)
    expect(setPref).toHaveBeenCalledWith(GPU_DISABLED_BY_USER_PREF_KEY, true)
    expect(setPref).not.toHaveBeenCalledWith(GPU_AUTO_PREF_KEY, null)
  })

  it('gpu:set-disabled(false) religa de vez: apaga a marca e o registro automático', () => {
    handlers.get('gpu:set-disabled')!(null, false)
    expect(setPref).toHaveBeenCalledWith(GPU_DISABLED_PREF_KEY, false)
    expect(setPref).toHaveBeenCalledWith(GPU_DISABLED_BY_USER_PREF_KEY, false)
    expect(setPref).toHaveBeenCalledWith(GPU_AUTO_PREF_KEY, null)
  })

  it('gpu:set-disabled recusa payload não-booleano sem gravar nada', () => {
    expect(() => handlers.get('gpu:set-disabled')!(null, 'sim')).toThrow()
    expect(setPref).not.toHaveBeenCalled()
  })
})
