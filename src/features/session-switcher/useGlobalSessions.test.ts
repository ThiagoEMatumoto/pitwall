import { describe, expect, it, vi } from 'vitest'

// useGlobalSessions → crew → handoffsStore → @/lib/ipc lê window.api no
// module-eval: stub mínimo antes do import dinâmico (padrão de crew.test.ts).
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const { mapSessionIds, visibleLiveSessions } = await import('./useGlobalSessions')

type Handoff = import('../../../shared/types/ipc').Handoff
type LiveSessionInfo = import('../../../shared/types/ipc').LiveSessionInfo
type ActivePane = import('@/store/appStore').ActivePane

const hf = (over: Partial<Handoff>) => ({ ...over }) as Handoff
const live = (over: Partial<LiveSessionInfo>) => ({ ...over }) as LiveSessionInfo
const pane = (ccSessionId: string) => ({ session: { ccSessionId } }) as unknown as ActivePane

describe('mapSessionIds — o conjunto que o mapa desenha', () => {
  const sessions = [
    live({ id: 'mae', ccSessionId: 'cc-mae' }),
    live({ id: 'filha', ccSessionId: 'cc-filha' }),
    live({ id: 'filha-aberta', ccSessionId: 'cc-aberta' }),
  ]
  const handoffs = [
    hf({ id: 'h1', status: 'running', childSessionId: 'filha' }),
    hf({ id: 'h2', status: 'needs_input', childSessionId: 'filha-aberta' }),
  ]

  it('as visíveis da área Projetos + as filhas vivas que moram no Crew Dock', () => {
    const panes = [pane('cc-aberta')]
    expect(visibleLiveSessions(sessions, panes, handoffs).map((s) => s.id)).toEqual([
      'mae',
      'filha-aberta',
    ])
    expect(mapSessionIds(sessions, panes, handoffs)).toEqual(
      new Set(['mae', 'filha', 'filha-aberta']),
    )
  })

  it('sessão que saiu da lista de vivas (encerrou) não entra', () => {
    expect(mapSessionIds(sessions.slice(0, 1), [], handoffs)).toEqual(new Set(['mae']))
  })
})
