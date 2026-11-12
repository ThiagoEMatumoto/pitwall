import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// O status vem do handler real gpu:status sobre prefs gravadas pelos produtores
// reais (createGpuCrashWatch, resolveGpuBoot, gpu:set-disabled): nenhum GpuStatus
// é montado à mão.
const { handlers, relaunch, prefs, failing, statusDelivery } = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, payload: unknown) => unknown>(),
  relaunch: vi.fn(),
  prefs: new Map<string, unknown>(),
  failing: { key: null as string | null, read: false },
  // O main já respondeu; a resposta só chega ao renderer quando isto resolve.
  statusDelivery: { gate: null as Promise<void> | null },
}))

vi.mock('electron', () => ({
  app: { relaunch, quit: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))
vi.mock('../../../electron/main/services/prefs-store', () => ({
  getPref: (key: string, fallback: unknown) => {
    if (failing.read) throw new Error('disk I/O error')
    return prefs.has(key) ? prefs.get(key) : fallback
  },
  setPref: (key: string, value: unknown) => {
    if (key === failing.key) throw new Error('disk I/O error')
    prefs.set(key, JSON.parse(JSON.stringify(value)))
  },
}))

const invoke = (channel: string, payload?: unknown) =>
  Promise.resolve().then(() => handlers.get(channel)!(null, payload))
vi.mock('@/lib/ipc', () => ({
  gpuApi: {
    status: () => {
      const answered = invoke('gpu:status')
      const { gate } = statusDelivery
      return gate ? gate.then(() => answered) : answered
    },
    setDisabled: (disabled: boolean) => invoke('gpu:set-disabled', disabled),
    setOzone: (ozone: boolean) => invoke('gpu:set-ozone', ozone),
    relaunch: () => invoke('app:relaunch'),
  },
  appApi: { getInfo: () => Promise.resolve({ platform: 'linux' }) },
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
  sessionsApi: {},
  prefsApi: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
}))

const { registerGpuIpc } = await import('../../../electron/main/ipc/gpu')
const { getPref, setPref } = await import('../../../electron/main/services/prefs-store')
const {
  createGpuCrashWatch,
  resolveGpuBoot,
  setGpuState,
  GPU_AUTO_PREF_KEY,
  GPU_DISABLED_PREF_KEY,
  OZONE_PREF_KEY,
} = await import('../../../electron/main/services/gpu-state')
const { GpuSoftwareIndicator } = await import('./GpuSoftwareIndicator')
const { TerminalSection } = await import('./TerminalSection')
const { IconRail } = await import('@/app/IconRail')
const { useGpuStatusStore, GPU_STATUS_RETRY_MS } = await import('./gpu-status-store')

const HOUR_MS = 60 * 60 * 1000
const NOW = new Date(2026, 10, 12, 9, 0).getTime()
const VERSION = '1.0.0'

// Mesma composição do boot em electron/main/index.ts.
function boot(args: { envDisabled?: boolean; now?: number } = {}): void {
  const envDisabled = args.envDisabled ?? false
  const decided = resolveGpuBoot({
    prefs: { getPref, setPref },
    envDisabled,
    version: VERSION,
    now: args.now ?? NOW,
  })
  setGpuState({
    hwAccelDisabled: decided.hwAccelDisabled,
    envDisabled,
    ozoneWayland: true,
    probation: decided.probation,
  })
}

// Dois crashes de driver num boot normal: o automático grava o registro.
function crashTwice(): void {
  boot({ now: NOW - HOUR_MS })
  const watch = createGpuCrashWatch({
    prefs: { getPref, setPref },
    hwAccelDisabled: false,
    probation: false,
    version: VERSION,
    now: () => NOW - HOUR_MS,
    onAutoDisabled: () => {},
    notifyCrashed: () => {},
  })
  watch.processGone('crashed')
  watch.processGone('crashed')
}

async function renderIndicator(): Promise<void> {
  render(<GpuSoftwareIndicator />)
  await waitFor(() => expect(useGpuStatusStore.getState().status).not.toBeNull())
}

const indicator = () => screen.queryByTestId('gpu-software-indicator')

describe('GpuSoftwareIndicator', () => {
  beforeEach(() => {
    handlers.clear()
    prefs.clear()
    relaunch.mockReset()
    failing.key = null
    statusDelivery.gate = null
    useGpuStatusStore.setState({ status: null })
    registerGpuIpc()
  })
  afterEach(() => {
    cleanup()
    failing.read = false
    vi.useRealTimers()
  })

  it('não aparece com a GPU ligada', async () => {
    boot()
    await renderIndicator()
    expect(useGpuStatusStore.getState().status?.hwAccelDisabled).toBe(false)
    expect(indicator()).toBeNull()
  })

  it('aparece com o desligamento automático em vigor, dizendo motivo, data e efeito', async () => {
    crashTwice()
    boot()
    await renderIndicator()
    expect(useGpuStatusStore.getState().status?.hwAccelDisabled).toBe(true)
    const label = indicator()?.getAttribute('aria-label') ?? ''
    expect(label).toContain('o driver de vídeo falhou')
    expect(label).toContain(new Date(NOW - HOUR_MS).toLocaleDateString('pt-BR'))
    expect(label).toContain('terminais')
  })

  it('o primeiro clique apaga o registro e o segundo reinicia', async () => {
    crashTwice()
    boot()
    await renderIndicator()

    fireEvent.click(indicator()!)
    await waitFor(() => expect(indicator()?.getAttribute('aria-label')).toContain('reiniciar'))
    expect(prefs.get(GPU_AUTO_PREF_KEY)).toBeNull()
    expect(relaunch).not.toHaveBeenCalled()

    fireEvent.click(indicator()!)
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1))
    // O boot seguinte sobe com a GPU ligada, fora de teste.
    expect(
      resolveGpuBoot({
        prefs: { getPref, setPref },
        envDisabled: false,
        version: VERSION,
        now: NOW,
      }),
    ).toEqual({ hwAccelDisabled: false, probation: false })
  })

  it('não aparece para quem desligou a GPU pelas Configurações', async () => {
    boot()
    handlers.get('gpu:set-disabled')!(null, true)
    boot()
    await renderIndicator()
    expect(useGpuStatusStore.getState().status?.hwAccelDisabled).toBe(true)
    expect(indicator()).toBeNull()
  })

  it('não aparece para a escolha manual nem quando sobrou um registro automático antigo', async () => {
    crashTwice()
    handlers.get('gpu:set-disabled')!(null, true)
    boot()
    await renderIndicator()
    expect(useGpuStatusStore.getState().status?.autoDisabled).not.toBeNull()
    expect(indicator()).toBeNull()
  })

  it('não aparece com CM_DISABLE_GPU=1, com ou sem registro automático', async () => {
    boot({ envDisabled: true })
    await renderIndicator()
    expect(useGpuStatusStore.getState().status?.hwAccelDisabled).toBe(true)
    expect(indicator()).toBeNull()
    cleanup()

    crashTwice()
    boot({ envDisabled: true })
    useGpuStatusStore.setState({ status: null })
    await renderIndicator()
    expect(useGpuStatusStore.getState().status?.autoDisabled).not.toBeNull()
    expect(indicator()).toBeNull()
  })

  // gpu.disabled=true sem marca é o que o automático antigo gravava. O boot migra
  // e religa em teste; se esse boot morre sem crash nem quit limpo, o seguinte
  // fica desligado com o registro 'legacy'.
  it('aparece para o legado em vigor, sem inventar motivo', async () => {
    prefs.set(GPU_DISABLED_PREF_KEY, true)
    boot({ now: NOW - HOUR_MS })
    boot()
    await renderIndicator()
    expect(useGpuStatusStore.getState().status?.hwAccelDisabled).toBe(true)
    expect(indicator()?.getAttribute('aria-label')).toContain('motivo desconhecido')
  })

  it('se o registro não sai do banco, continua oferecendo religar e não oferece reiniciar', async () => {
    crashTwice()
    boot()
    await renderIndicator()
    failing.key = GPU_AUTO_PREF_KEY
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    fireEvent.click(indicator()!)
    await waitFor(() => expect(console.warn).toHaveBeenCalled())
    await waitFor(() => expect(indicator()?.getAttribute('aria-label')).toContain('religar'))
    expect(indicator()?.getAttribute('aria-label')).not.toContain('reiniciar')

    fireEvent.click(indicator()!)
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2))
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('se a escrita e a releitura falham, o aviso volta sozinho quando o gpu:status responde', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    crashTwice()
    boot()
    await renderIndicator()
    failing.key = GPU_AUTO_PREF_KEY
    failing.read = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    fireEvent.click(indicator()!)
    await waitFor(() => expect(useGpuStatusStore.getState().status).toBeNull())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GPU_STATUS_RETRY_MS)
    })
    expect(useGpuStatusStore.getState().status).toBeNull()
    expect(indicator()).toBeNull()

    // Nada mudou no main: o registro segue no banco e a GPU segue desligada.
    failing.read = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GPU_STATUS_RETRY_MS)
    })
    await waitFor(() => expect(indicator()?.getAttribute('aria-label')).toContain('religar'))
    expect(indicator()?.getAttribute('aria-label')).not.toContain('reiniciar')
    expect(prefs.get(GPU_AUTO_PREF_KEY)).not.toBeNull()
  })

  it('fica no rail, logo acima do botão de Configurações', async () => {
    crashTwice()
    boot()
    render(<IconRail onOpenSettings={() => {}} />)
    await waitFor(() => expect(indicator()).not.toBeNull())
    const settings = screen.getByTitle('Configurações')
    expect(indicator()!.nextElementSibling).toBe(settings)
  })

  it('religar pelo toggle das Configurações também tira o aviso', async () => {
    crashTwice()
    boot()
    render(
      <>
        <GpuSoftwareIndicator />
        <TerminalSection open />
      </>,
    )
    await waitFor(() => expect(indicator()).not.toBeNull())
    const toggle = screen.getByRole('checkbox', { name: /Desativar aceleração de GPU/ })
    expect(toggle).toBeChecked()

    fireEvent.click(toggle)
    await waitFor(() => expect(indicator()).toBeNull())
    expect(prefs.get(GPU_AUTO_PREF_KEY)).toBeNull()
    expect(screen.getByRole('button', { name: 'Reiniciar agora' })).toBeInTheDocument()
  })

  it('um gpu:status pedido antes de religar e entregue depois não desfaz o religar', async () => {
    crashTwice()
    boot()
    render(
      <>
        <GpuSoftwareIndicator />
        <TerminalSection open />
      </>,
    )
    await waitFor(() => expect(indicator()).not.toBeNull())
    const toggle = screen.getByRole('checkbox', { name: /Desativar aceleração de GPU/ })

    let deliver = (): void => {}
    statusDelivery.gate = new Promise<void>((resolve) => {
      deliver = resolve
    })
    const staleLoad = useGpuStatusStore.getState().load()
    fireEvent.click(toggle)
    await waitFor(() => expect(prefs.get(GPU_AUTO_PREF_KEY)).toBeNull())
    deliver()
    await staleLoad

    expect(useGpuStatusStore.getState().status?.autoDisabled).toBeNull()
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(indicator()).toBeNull()
  })

  it('outra escrita durante a reconciliação de um religar que falhou não deixa o palpite valendo', async () => {
    crashTwice()
    boot()
    render(
      <>
        <GpuSoftwareIndicator />
        <TerminalSection open />
      </>,
    )
    await waitFor(() => expect(indicator()).not.toBeNull())
    const toggle = screen.getByRole('checkbox', { name: /Desativar aceleração de GPU/ })
    const wayland = await screen.findByRole('checkbox', { name: /Wayland nativo/ })
    failing.key = GPU_AUTO_PREF_KEY
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    let deliver = (): void => {}
    statusDelivery.gate = new Promise<void>((resolve) => {
      deliver = resolve
    })
    fireEvent.click(toggle)
    await waitFor(() => expect(console.warn).toHaveBeenCalled())
    fireEvent.click(wayland)
    await waitFor(() => expect(prefs.get(OZONE_PREF_KEY)).toBe(false))
    deliver()

    // O registro ficou no banco: o aviso tem de voltar, sem desfazer o Wayland.
    await waitFor(() => expect(indicator()).not.toBeNull())
    expect(prefs.get(GPU_AUTO_PREF_KEY)).not.toBeNull()
    expect(useGpuStatusStore.getState().status?.autoDisabled).not.toBeNull()
    expect(useGpuStatusStore.getState().status?.prefOzone).toBe(false)
    expect(toggle).toBeChecked()
    expect(wayland).not.toBeChecked()
  })
})

describe('gpu-status-store × escrita que falha', () => {
  beforeEach(() => {
    handlers.clear()
    prefs.clear()
    failing.key = null
    statusDelivery.gate = null
    useGpuStatusStore.setState({ status: null })
    registerGpuIpc()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    failing.key = null
    failing.read = false
    statusDelivery.gate = null
    vi.restoreAllMocks()
  })

  const store = () => useGpuStatusStore.getState()

  it('um gpu:set-ozone que falha volta ao que ficou no banco, sem rejeição solta', async () => {
    boot()
    await store().load()
    expect(store().status?.prefOzone).toBe(true)
    failing.key = OZONE_PREF_KEY

    await expect(store().setOzone(false)).resolves.toBeUndefined()

    expect(prefs.has(OZONE_PREF_KEY)).toBe(false)
    expect(store().status?.prefOzone).toBe(true)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('o toggle de Wayland volta a ficar marcado quando a escrita falha', async () => {
    boot()
    render(<TerminalSection open />)
    const wayland = await screen.findByRole('checkbox', { name: /Wayland nativo/ })
    await waitFor(() => expect(wayland).not.toBeDisabled())
    failing.key = OZONE_PREF_KEY

    fireEvent.click(wayland)
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1))

    await waitFor(() => expect(wayland).toBeChecked())
    expect(screen.queryByRole('button', { name: 'Reiniciar agora' })).toBeNull()
  })

  it('outra escrita durante a reconciliação do Wayland que falhou não deixa o palpite valendo', async () => {
    boot()
    await store().load()
    failing.key = OZONE_PREF_KEY
    let deliver = (): void => {}
    statusDelivery.gate = new Promise<void>((resolve) => {
      deliver = resolve
    })

    const ozone = store().setOzone(false)
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1))
    const disabled = store().setDisabled(true)
    await waitFor(() => expect(prefs.get(GPU_DISABLED_PREF_KEY)).toBe(true))
    deliver()
    await Promise.all([ozone, disabled])

    await waitFor(() => expect(store().status?.prefOzone).toBe(true))
    expect(store().status?.prefDisabled).toBe(true)
  })

  it('duas escritas que falham em sequência terminam no que ficou no banco', async () => {
    crashTwice()
    boot()
    await store().load()
    // O automático avisa no console ao desligar: só contam os avisos das escritas.
    vi.mocked(console.warn).mockClear()
    failing.key = GPU_AUTO_PREF_KEY
    let deliver = (): void => {}
    statusDelivery.gate = new Promise<void>((resolve) => {
      deliver = resolve
    })

    const reenable = store().setDisabled(false)
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1))
    failing.key = OZONE_PREF_KEY
    const ozone = store().setOzone(false)
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2))
    deliver()
    await Promise.all([reenable, ozone])

    await waitFor(() => expect(store().status?.autoDisabled).not.toBeNull())
    expect(prefs.get(GPU_AUTO_PREF_KEY)).not.toBeNull()
    expect(store().status?.prefOzone).toBe(true)
  })

  it('se nem o gpu:status responde depois de religar falhar, o palpite sai e os toggles travam', async () => {
    crashTwice()
    boot()
    render(<TerminalSection open />)
    const toggle = screen.getByRole('checkbox', { name: /Desativar aceleração de GPU/ })
    await waitFor(() => expect(toggle).toBeChecked())
    failing.key = GPU_AUTO_PREF_KEY
    failing.read = true

    await expect(store().setDisabled(false)).resolves.toBeUndefined()

    // O palpite seria "religada, falta reiniciar"; o registro segue no banco.
    expect(store().status).toBeNull()
    await waitFor(() => expect(toggle).toBeDisabled())
    expect(screen.queryByRole('button', { name: 'Reiniciar agora' })).toBeNull()

    failing.read = false
    await store().load()
    expect(store().status?.autoDisabled).not.toBeNull()
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('se nem o gpu:status responde depois do Wayland falhar, o palpite sai', async () => {
    boot()
    await store().load()
    failing.key = OZONE_PREF_KEY
    failing.read = true

    await expect(store().setOzone(false)).resolves.toBeUndefined()

    expect(store().status).toBeNull()
    failing.read = false
    await store().load()
    expect(store().status?.prefOzone).toBe(true)
  })
})

describe('TerminalSection × CM_DISABLE_GPU=1', () => {
  beforeEach(() => {
    handlers.clear()
    prefs.clear()
    useGpuStatusStore.setState({ status: null })
    registerGpuIpc()
  })
  afterEach(cleanup)

  it('diz que a variável desliga a GPU e não pede um reinício que não resolve', async () => {
    boot({ envDisabled: true })
    render(<TerminalSection open />)
    await waitFor(() => expect(screen.getByText(/CM_DISABLE_GPU=1/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Reiniciar agora' })).toBeNull()
  })
})
