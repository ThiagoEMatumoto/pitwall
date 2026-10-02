import { describe, expect, it, vi } from 'vitest'

// useGlobalSessions → crew → handoffsStore → @/lib/ipc lê window.api no
// module-eval: stub mínimo antes do import dinâmico (padrão de crew.test.ts).
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const {
  crewOnlyCount,
  crewOnlyLabel,
  mapSessionIds,
  unknownLiveIds,
  visibleLiveSessions,
  withCrewSessions,
} =
  await import('./useGlobalSessions')

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
    expect(mapSessionIds(sessions)).toEqual(new Set(['mae', 'filha', 'filha-aberta']))
  })

  it('sessão que saiu da lista de vivas (encerrou) não entra', () => {
    expect(mapSessionIds(sessions.slice(0, 1))).toEqual(new Set(['mae']))
  })

  it('viva no grafo do main sem aba e fora do snapshot entra; na janela de undo não', () => {
    expect(mapSessionIds(sessions.slice(0, 1), ['s4', 's5'], new Set(['s5']))).toEqual(
      new Set(['mae', 's4']),
    )
  })
})

describe('unknownLiveIds — PTYs vivas no grafo que o snapshot do renderer não conhece', () => {
  it('lista só as que faltam no snapshot, em ordem estável (chave do refetch)', () => {
    const snap = [live({ id: 'mae', ccSessionId: 'cc-mae' })]
    expect(unknownLiveIds(snap, ['s5', 'mae', 's4'])).toEqual(['s4', 's5'])
  })

  it('nada a buscar quando o snapshot já tem todas', () => {
    expect(unknownLiveIds([live({ id: 'mae', ccSessionId: 'cc-mae' })], ['mae'])).toEqual([])
  })
})

describe('crewOnlyCount — a diferença entre o mapa e o seletor, dita', () => {
  it('conta as vivas que só estão na equipe (filha no dock), não as encerradas', () => {
    const sessions = [
      live({ id: 'mae', ccSessionId: 'cc-mae', status: 'working' }),
      live({ id: 'filha', ccSessionId: 'cc-filha', status: 'working' }),
      live({ id: 'velha', ccSessionId: 'cc-velha', status: 'ended' }),
    ]
    const visible = visibleLiveSessions(sessions, [], [
      hf({ id: 'h1', status: 'running', childSessionId: 'filha' }),
      hf({ id: 'h2', status: 'running', childSessionId: 'velha' }),
    ])
    expect(crewOnlyCount(sessions, visible)).toBe(1)
    expect(crewOnlyLabel(1)).toBe('+1 na equipe')
    expect(crewOnlyLabel(0)).toBeNull()
  })
})

describe('withCrewSessions — o toggle "+N na equipe" do seletor', () => {
  const sessions = [
    live({ id: 'mae', ccSessionId: 'cc-mae', status: 'working' }),
    live({ id: 'filha', ccSessionId: 'cc-filha', status: 'working' }),
    live({ id: 'velha', ccSessionId: 'cc-velha', status: 'ended' }),
  ]
  const visible = visibleLiveSessions(sessions, [], [
    hf({ id: 'h1', status: 'running', childSessionId: 'filha' }),
    hf({ id: 'h2', status: 'running', childSessionId: 'velha' }),
  ])
  it('desligado: só as visíveis, ninguém marcado', () => {
    const r = withCrewSessions(sessions, visible, false)
    expect(r.items.map((s) => s.id)).toEqual(['mae'])
    expect(r.crewIds.size).toBe(0)
  })
  it('ligado: entram as filhas do dock, marcadas; encerrada não', () => {
    const r = withCrewSessions(sessions, visible, true)
    expect(r.items.map((s) => s.id)).toEqual(['mae', 'filha'])
    expect([...r.crewIds]).toEqual(['filha'])
  })
})
