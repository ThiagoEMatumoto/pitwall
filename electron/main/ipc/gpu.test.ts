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
  decideGpuBoot,
  setGpuState,
  GPU_AUTO_PREF_KEY,
  GPU_DISABLED_BY_USER_PREF_KEY,
  GPU_DISABLED_PREF_KEY,
  OZONE_PREF_KEY,
} from '../services/gpu-state'
import type { GpuBootInput } from '../services/gpu-state'
import { gpuDisableChecked, gpuRestartPending, withGpuDisabled } from '../../../shared/gpu-status'
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

// O toggle das Configurações lê o gpu:status. Cada caso sobe o estado pelo mesmo
// caminho do boot (decideGpuBoot → prefs + setGpuState) e lê o status pelo handler.
describe('gpu:status × toggle das Configurações', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const NOW = 1_700_000_000_000
  const prefs = new Map<string, unknown>()

  beforeEach(() => {
    handlers.clear()
    prefs.clear()
    getPref.mockReset()
    setPref.mockReset()
    getPref.mockImplementation((key: string, fallback: unknown) =>
      prefs.has(key) ? prefs.get(key) : fallback,
    )
    setPref.mockImplementation((key: string, value: unknown) => {
      prefs.set(key, JSON.parse(JSON.stringify(value)))
    })
    registerGpuIpc()
  })

  const status = () => handlers.get('gpu:status')!(null, undefined) as GpuStatus

  function boot(input: Partial<GpuBootInput>): void {
    const decision = decideGpuBoot({
      envDisabled: false,
      prefDisabled: false,
      disabledByUser: false,
      autoDisabled: null,
      version: '1.0.0',
      now: NOW,
      ...input,
    })
    setPref(GPU_DISABLED_PREF_KEY, decision.prefDisabled)
    setPref(GPU_AUTO_PREF_KEY, decision.autoDisabled)
    setGpuState({
      hwAccelDisabled: decision.hwAccelDisabled,
      ozoneWayland: true,
      probation: decision.probation,
    })
  }

  const crashRecord = autoDisableRecord({
    previous: null,
    reason: 'crashed',
    version: '1.0.0',
    now: NOW - DAY_MS,
  })

  // Reiniciar não religa: o boot espera o backoff. Um "requer reiniciar" aqui
  // nunca sairia da tela.
  it('desligamento automático em vigor: toggle marcado, sem reinício pendente', () => {
    boot({ autoDisabled: crashRecord })
    expect(status().hwAccelDisabled).toBe(true)
    expect(status().prefDisabled).toBe(false)
    expect(gpuDisableChecked(status())).toBe(true)
    expect(gpuRestartPending(status())).toBe(false)
  })

  it('desmarcar o desligamento automático religa: toggle livre, reinício pendente', () => {
    boot({ autoDisabled: crashRecord })
    const local = withGpuDisabled(status(), false)
    handlers.get('gpu:set-disabled')!(null, false)
    expect(local).toEqual(status())
    expect(gpuDisableChecked(local)).toBe(false)
    expect(gpuRestartPending(local)).toBe(true)
  })

  it('boot de teste: GPU ligada, toggle livre, sem reinício pendente', () => {
    boot({ autoDisabled: crashRecord, now: NOW + 30 * DAY_MS })
    expect(status().hwAccelDisabled).toBe(false)
    expect(status().autoDisabled).not.toBeNull()
    expect(gpuDisableChecked(status())).toBe(false)
    expect(gpuRestartPending(status())).toBe(false)
  })

  it('escolha manual: marcar pede reinício e o boot seguinte fica quieto', () => {
    boot({})
    const local = withGpuDisabled(status(), true)
    handlers.get('gpu:set-disabled')!(null, true)
    expect(local).toEqual(status())
    expect(gpuDisableChecked(local)).toBe(true)
    expect(gpuRestartPending(local)).toBe(true)

    boot({ prefDisabled: true, disabledByUser: true })
    expect(gpuDisableChecked(status())).toBe(true)
    expect(gpuRestartPending(status())).toBe(false)
  })

  it('pref do Wayland diferente do boot pede reinício', () => {
    boot({})
    handlers.get('gpu:set-ozone')!(null, false)
    expect(gpuRestartPending(status())).toBe(true)
  })
})
