import { describe, expect, it, vi } from 'vitest'

// useGlobalSessions → crew → handoffsStore → @/lib/ipc lê window.api no
// module-eval: stub mínimo antes do import dinâmico (padrão de crew.test.ts).
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const {
  crewOnlyCount,
  countWithCrew,
  listsCrew,
  crewOnlyLabel,
  showRowStatus,
  mapSessionIds,
  unknownLiveIds,
  visibleLiveSessions,
  withCrewSessions,
  orderByFeature,
} = await import('./useGlobalSessions')

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
    const visible = visibleLiveSessions(
      sessions,
      [],
      [
        hf({ id: 'h1', status: 'running', childSessionId: 'filha' }),
        hf({ id: 'h2', status: 'running', childSessionId: 'velha' }),
      ],
    )
    expect(crewOnlyCount(sessions, visible)).toBe(1)
    expect(crewOnlyLabel(1)).toBe('1 na equipe')
    expect(crewOnlyLabel(0)).toBeNull()
  })
})

describe('withCrewSessions — o toggle "+N na equipe" do seletor', () => {
  const sessions = [
    live({ id: 'mae', ccSessionId: 'cc-mae', status: 'working' }),
    live({ id: 'filha', ccSessionId: 'cc-filha', status: 'working' }),
    live({ id: 'velha', ccSessionId: 'cc-velha', status: 'ended' }),
  ]
  const visible = visibleLiveSessions(
    sessions,
    [],
    [
      hf({ id: 'h1', status: 'running', childSessionId: 'filha' }),
      hf({ id: 'h2', status: 'running', childSessionId: 'velha' }),
    ],
  )
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

describe('countWithCrew', () => {
  it('o número é o total: soma as filhas só da Equipe, a não ser que já estejam na lista', () => {
    expect(countWithCrew(9, 2, false)).toBe(11)
    expect(countWithCrew(11, 2, true)).toBe(11)
    expect(countWithCrew(4, 0, false)).toBe(4)
  })
})

describe('showRowStatus — badge só quando difere do grupo', () => {
  it('sob "Trabalhando" some o "trabalhando" e fica o "iniciando"', () => {
    expect(showRowStatus('working', ['working', 'starting'])).toBe(false)
    expect(showRowStatus('starting', ['working', 'starting'])).toBe(true)
  })
  it('grupo sem status (encerradas/avulsas) mostra sempre', () => {
    expect(showRowStatus('idle', [])).toBe(true)
  })
})

describe('listsCrew', () => {
  it('filhas entram com o toggle ligado ou durante uma busca (quem digita o nome dela quer achá-la)', () => {
    expect(listsCrew(false, '')).toBe(false)
    expect(listsCrew(false, '   ')).toBe(false)
    expect(listsCrew(true, '')).toBe(true)
    expect(listsCrew(false, 'marina')).toBe(true)
  })
  it('o número do grupo é o das linhas listadas: sem o toggle, as filhas ficam só no chip', async () => {
    const { withCrewSessions } = await import('./useGlobalSessions')
    const s = (id: string) => ({ id, status: 'working' }) as LiveSessionInfo
    const all = ['a', 'b', 'c', 'marina', 'otavio'].map(s)
    const visible = all.slice(0, 3)
    expect(withCrewSessions(all, visible, listsCrew(false, '')).items).toHaveLength(3)
    expect(withCrewSessions(all, visible, listsCrew(false, 'mar')).items).toHaveLength(5)
  })
})

describe('orderByFeature', () => {
  const s = (id: string) => ({ id })
  // Ordem de recência do print 13: 8 soltas e a mãe da feature por último.
  const recency = ['extra-6', 'extra-5', 'extra-4', 'solta-x', 'mae', 'otavio', 'marina'].map(s)
  const featureOf = new Map<string, string | null>([
    ['mae', 'checkout'],
    ['otavio', 'checkout'],
    ['marina', null],
  ])
  const motherOfChild = new Map([
    ['otavio', 'mae'],
    ['marina', 'mae'],
  ])

  it('feature no topo: mãe primeiro e as filhas logo abaixo; depois as soltas por recência', () => {
    const r = orderByFeature(recency, featureOf, motherOfChild)
    expect(r.items.map((x) => x.id)).toEqual([
      'mae',
      'otavio',
      'marina',
      'extra-6',
      'extra-5',
      'extra-4',
      'solta-x',
    ])
    expect([...r.childOf.entries()]).toEqual([
      ['otavio', 'mae'],
      ['marina', 'mae'],
    ])
  })

  it('filha sem a mãe na lista (toggle da equipe desligado) não vira ↳', () => {
    const r = orderByFeature([s('a'), s('otavio')], featureOf, motherOfChild)
    expect(r.items.map((x) => x.id)).toEqual(['otavio', 'a'])
    expect(r.childOf.size).toBe(0)
  })

  it('sem feature nenhuma, a ordem fica', () => {
    const items = [s('a'), s('b'), s('c')]
    expect(orderByFeature(items, new Map(), new Map()).items).toEqual(items)
  })
})
