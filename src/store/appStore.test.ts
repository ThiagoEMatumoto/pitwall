import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// appStore importa @/lib/ipc, que lê window.api no module-eval. O spy de kill
// precisa existir ANTES do import dinâmico do store (top-level await garante).
const killSpy = vi.fn(() => Promise.resolve())
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          {},
          { get: (_t, prop) => (prop === 'kill' ? killSpy : () => Promise.resolve()) },
        ),
    },
  ),
})

const { useAppStore } = await import('./appStore')
const { useToastStore } = await import('@/features/notifications/toast-store')
type ActivePane = import('./appStore').ActivePane
type Session = import('../../shared/types/ipc').Session
type LiveSessionInfo = import('../../shared/types/ipc').LiveSessionInfo

// Espelham as constantes privadas do appStore (END_UNDO_MS / END_KILL_GRACE_MS).
// Se os valores mudarem lá, ajustar aqui — os testes validam a RELAÇÃO
// (kill só depois do toast sumir), não os valores absolutos.
const TOAST_MS = 5000
const GRACE_MS = 750

function makePane(sessionId: string): ActivePane {
  return {
    paneId: `pane-${sessionId}`,
    session: { id: sessionId, ccSessionId: null, title: null } as unknown as Session,
    repo: null,
    projectName: null,
    projectIcon: null,
    projectColor: null,
    mode: 'terminal',
  }
}

function makeLive(sessionId: string): LiveSessionInfo {
  return { id: sessionId, ccSessionId: `cc-${sessionId}` } as unknown as LiveSessionInfo
}

function seedSession(sessionId: string): void {
  useAppStore.setState({ panes: [makePane(sessionId)], liveSessions: [makeLive(sessionId)] })
}

beforeEach(() => {
  vi.useFakeTimers()
  killSpy.mockClear()
  useAppStore.setState({ panes: [], liveSessions: [] })
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  // Drena timers pendentes (kills agendados) pra não vazar entre testes.
  vi.runAllTimers()
  vi.useRealTimers()
})

describe('endSession (janela de undo)', () => {
  it('kill só dispara DEPOIS do toast sumir (graça pós-toast)', () => {
    seedSession('s1')
    useAppStore.getState().endSession('s1')

    // Remoção otimista + toast com a duração da janela de undo.
    expect(useAppStore.getState().panes).toHaveLength(0)
    const toast = useToastStore.getState().toasts[0]
    expect(toast?.actionLabel).toBe('Desfazer')
    expect(toast?.durationMs).toBe(TOAST_MS)

    // Enquanto o toast pode estar visível, o PTY segue vivo.
    vi.advanceTimersByTime(TOAST_MS)
    expect(killSpy).not.toHaveBeenCalled()

    // Passada a graça, o kill efetivo dispara.
    vi.advanceTimersByTime(GRACE_MS)
    expect(killSpy).toHaveBeenCalledTimes(1)
    expect(killSpy).toHaveBeenCalledWith('s1')
  })

  it('undo no fim da vida do toast ainda cancela o kill e restaura', () => {
    seedSession('s2')
    useAppStore.getState().endSession('s2')

    // Último instante em que o toast pode ser clicado (auto-dismiss = TOAST_MS).
    vi.advanceTimersByTime(TOAST_MS)
    useAppStore.getState().undoEndSession('s2')

    expect(useAppStore.getState().panes.map((p) => p.session.id)).toEqual(['s2'])
    expect(useAppStore.getState().liveSessions.map((l) => l.id)).toEqual(['s2'])
    vi.advanceTimersByTime(GRACE_MS + TOAST_MS)
    expect(killSpy).not.toHaveBeenCalled()
  })
})

describe('undoEndSession sem pending', () => {
  it('não finge sucesso: avisa que a janela expirou', () => {
    useAppStore.getState().undoEndSession('inexistente')

    expect(useAppStore.getState().panes).toHaveLength(0)
    const toast = useToastStore.getState().toasts[0]
    expect(toast?.title).toBe('Tarde demais para desfazer')
  })
})

describe('endSession immediate (fluxo Reabrir)', () => {
  it('mata na hora, sem toast e sem janela de undo', () => {
    seedSession('s4')
    useAppStore.getState().endSession('s4', { immediate: true })

    expect(useAppStore.getState().panes).toHaveLength(0)
    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(killSpy).toHaveBeenCalledTimes(1)
    expect(killSpy).toHaveBeenCalledWith('s4')

    // Nenhum kill duplicado agendado.
    vi.runAllTimers()
    expect(killSpy).toHaveBeenCalledTimes(1)
  })

  it('cancela um pending anterior da mesma sessão (kill único)', () => {
    seedSession('s5')
    useAppStore.getState().endSession('s5')
    useAppStore.getState().endSession('s5', { immediate: true })

    expect(killSpy).toHaveBeenCalledTimes(1)
    vi.runAllTimers()
    expect(killSpy).toHaveBeenCalledTimes(1)
  })
})

describe('sessionFromLiveSession — provider sem id nativo', () => {
  // Shape do produtor (live-session-pty.ts livePtySessionInfo): o Codex chega com
  // ccSessionId = sessions.id, só como chave do batch global.
  const codexLive = {
    id: 'sess-codex',
    ccSessionId: 'sess-codex',
    name: 'codex-ops',
    provider: 'codex',
  } as unknown as LiveSessionInfo

  it('Codex vira Session sem ccSessionId (sem watch/baton/persistência de claude)', async () => {
    const { sessionFromLiveSession } = await import('./appStore')
    expect(sessionFromLiveSession(codexLive, 'p1').ccSessionId).toBeNull()
  })

  it('Claude mantém o id nativo', async () => {
    const { sessionFromLiveSession } = await import('./appStore')
    const claude = { ...codexLive, ccSessionId: 'cc-1', provider: 'claude' } as LiveSessionInfo
    expect(sessionFromLiveSession(claude, 'p1').ccSessionId).toBe('cc-1')
  })
})
