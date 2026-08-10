import { describe, expect, it, vi } from 'vitest'

// crew.ts importa @/store/handoffsStore, que importa @/lib/ipc e lê window.api no
// module-eval. As funções puras testadas aqui não tocam a API, mas o import
// precisa de um stub mínimo. Stub ANTES do import dinâmico (top-level await
// garante a ordem) — mesmo padrão de HandoffCard.test.ts.
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const {
  splitAlias,
  activeCrew,
  hiddenCrewSessionIds,
  crewCcSessionIds,
  crewNeedsAttention,
  crewAttentionCount,
  orderCrew,
} = await import('./crew')

type Handoff = import('../../../shared/types/ipc').Handoff
type LiveSessionInfo = import('../../../shared/types/ipc').LiveSessionInfo

// Casts mínimos: só preenchemos os campos que estas funções puras leem.
const hf = (over: Partial<Handoff>) => ({ ...over }) as Handoff
const live = (over: Partial<LiveSessionInfo>) => ({ ...over }) as LiveSessionInfo

describe('splitAlias', () => {
  it('null/undefined → null', () => {
    expect(splitAlias(null)).toBeNull()
    expect(splitAlias(undefined)).toBeNull()
  })

  it('string vazia ou só espaços → null', () => {
    expect(splitAlias('')).toBeNull()
    expect(splitAlias('   ')).toBeNull()
  })

  it('só hífens → null (filter(Boolean) esvazia as partes)', () => {
    expect(splitAlias('---')).toBeNull()
  })

  it('só o nome → scope null', () => {
    expect(splitAlias('helena')).toEqual({ name: 'Helena', scope: null })
  })

  it('nome + escopo simples', () => {
    expect(splitAlias('helena-auth')).toEqual({ name: 'Helena', scope: 'auth' })
  })

  it('escopo com vários segmentos é rejuntado com hífen', () => {
    expect(splitAlias('helena-auth-refactor')).toEqual({
      name: 'Helena',
      scope: 'auth-refactor',
    })
  })

  it('sufixo numérico de desambiguação fica no escopo', () => {
    expect(splitAlias('helena-auth-2')).toEqual({ name: 'Helena', scope: 'auth-2' })
  })

  it('hífens repetidos/nas pontas são ignorados', () => {
    expect(splitAlias('-helena--auth-')).toEqual({ name: 'Helena', scope: 'auth' })
  })

  it('espaços em volta são aparados antes de fatiar', () => {
    expect(splitAlias('  helena-auth  ')).toEqual({ name: 'Helena', scope: 'auth' })
  })

  // O alias técnico é kebab SEM acento (é o endereço do SendMessage e não pode
  // mudar); só o rótulo de tela recebe o acento.
  it('nome do roster com acento é exibido acentuado, sem alterar o escopo', () => {
    expect(splitAlias('mauricio-billing')).toEqual({ name: 'Maurício', scope: 'billing' })
    expect(splitAlias('otavio-search-2')).toEqual({ name: 'Otávio', scope: 'search-2' })
  })

  it('mapa de exibição é case-insensitive na chave', () => {
    expect(splitAlias('Mauricio-billing')?.name).toBe('Maurício')
    expect(splitAlias('OTAVIO')?.name).toBe('Otávio')
  })

  it('nome fora do mapa cai no capitalize simples (sem inventar acento)', () => {
    expect(splitAlias('otaviano-x')?.name).toBe('Otaviano')
    expect(splitAlias('mauricia-x')?.name).toBe('Mauricia')
  })
})

describe('activeCrew', () => {
  it('mantém pending/approved/running/needs_input e descarta os terminais', () => {
    const handoffs = [
      hf({ id: 'a', status: 'pending' }),
      hf({ id: 'b', status: 'approved' }),
      hf({ id: 'c', status: 'running' }),
      hf({ id: 'd', status: 'needs_input' }),
      hf({ id: 'e', status: 'done' }),
      hf({ id: 'f', status: 'failed' }),
      hf({ id: 'g', status: 'rejected' }),
    ]
    expect(activeCrew(handoffs).map((h) => h.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('lista vazia → vazia', () => {
    expect(activeCrew([])).toEqual([])
  })
})

describe('hiddenCrewSessionIds', () => {
  const handoffs = [
    hf({ id: 'h1', status: 'running', childSessionId: 's1' }),
    hf({ id: 'h2', status: 'needs_input', childSessionId: 's2' }),
    hf({ id: 'h3', status: 'done', childSessionId: 's3' }),
  ]
  const sessions = [
    live({ id: 's1', ccSessionId: 'cc1' }),
    live({ id: 's2', ccSessionId: 'cc2' }),
    live({ id: 's3', ccSessionId: 'cc3' }),
    live({ id: 's9', ccSessionId: 'cc9' }),
  ]

  it('esconde as filhas de handoff ativo que não têm pane aberta', () => {
    expect(hiddenCrewSessionIds(handoffs, sessions, new Set())).toEqual(new Set(['s1', 's2']))
  })

  it('filha com pane aberta vira sessão de primeira classe (deixa de ser escondida)', () => {
    expect(hiddenCrewSessionIds(handoffs, sessions, new Set(['cc1']))).toEqual(new Set(['s2']))
  })

  it('sessão de handoff terminal e sessão avulsa nunca entram', () => {
    const hidden = hiddenCrewSessionIds(handoffs, sessions, new Set())
    expect(hidden.has('s3')).toBe(false)
    expect(hidden.has('s9')).toBe(false)
  })
})

describe('crewCcSessionIds', () => {
  it('traduz Session.id de filha ativa → ccSessionId', () => {
    const handoffs = [
      hf({ status: 'running', childSessionId: 's1' }),
      hf({ status: 'done', childSessionId: 's2' }),
    ]
    const sessions = [live({ id: 's1', ccSessionId: 'cc1' }), live({ id: 's2', ccSessionId: 'cc2' })]
    expect(crewCcSessionIds(handoffs, sessions)).toEqual(new Set(['cc1']))
  })

  it('filha ainda sem sessão viva → conjunto vazio', () => {
    const handoffs = [hf({ status: 'running', childSessionId: 's1' })]
    expect(crewCcSessionIds(handoffs, [])).toEqual(new Set())
  })
})

describe('crewNeedsAttention', () => {
  it('needs_input basta, mesmo com o PTY trabalhando', () => {
    expect(crewNeedsAttention(hf({ status: 'needs_input' }), live({ status: 'working' }))).toBe(true)
  })

  it('PTY waiting basta, mesmo com o handoff running', () => {
    expect(crewNeedsAttention(hf({ status: 'running' }), live({ status: 'waiting' }))).toBe(true)
  })

  it('running + PTY working → false', () => {
    expect(crewNeedsAttention(hf({ status: 'running' }), live({ status: 'working' }))).toBe(false)
  })

  it('sem sessão viva e sem needs_input → false', () => {
    expect(crewNeedsAttention(hf({ status: 'running' }), undefined)).toBe(false)
  })
})

describe('crewAttentionCount', () => {
  it('conta as duas fontes de atenção e ignora handoff terminal', () => {
    const handoffs = [
      hf({ id: 'a', status: 'needs_input', childSessionId: 's1' }),
      hf({ id: 'b', status: 'running', childSessionId: 's2' }),
      hf({ id: 'c', status: 'running', childSessionId: 's3' }),
      hf({ id: 'd', status: 'done', childSessionId: 's4' }),
    ]
    const sessions = [
      live({ id: 's1', status: 'working' }),
      live({ id: 's2', status: 'waiting' }),
      live({ id: 's3', status: 'working' }),
      live({ id: 's4', status: 'waiting' }),
    ]
    // s1 (needs_input) + s2 (waiting). s3 trabalha; s4 é de handoff done.
    expect(crewAttentionCount(handoffs, sessions)).toBe(2)
  })

  it('ninguém esperando → 0', () => {
    expect(crewAttentionCount([hf({ status: 'running', childSessionId: 's1' })], [])).toBe(0)
  })
})

describe('orderCrew', () => {
  it('promove quem espera você e preserva a ordem do store dentro de cada grupo', () => {
    const handoffs = [
      hf({ id: 'a', status: 'running', childSessionId: 's1' }),
      hf({ id: 'b', status: 'needs_input', childSessionId: 's2' }),
      hf({ id: 'c', status: 'running', childSessionId: 's3' }),
      hf({ id: 'd', status: 'running', childSessionId: 's4' }),
    ]
    const sessions = [
      live({ id: 's1', status: 'working' }),
      live({ id: 's2', status: 'working' }),
      live({ id: 's3', status: 'waiting' }),
      live({ id: 's4', status: 'working' }),
    ]
    // Atenção: b (needs_input) e c (waiting), na ordem original. Resto: a, d.
    expect(orderCrew(handoffs, sessions).map((h) => h.id)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('não reordena por status vivo quando ninguém precisa de atenção', () => {
    const handoffs = [
      hf({ id: 'a', status: 'running', childSessionId: 's1' }),
      hf({ id: 'b', status: 'running', childSessionId: 's2' }),
    ]
    const sessions = [live({ id: 's1', status: 'idle' }), live({ id: 's2', status: 'working' })]
    expect(orderCrew(handoffs, sessions).map((h) => h.id)).toEqual(['a', 'b'])
  })

  it('descarta handoffs terminais junto com o activeCrew', () => {
    const handoffs = [
      hf({ id: 'a', status: 'done', childSessionId: 's1' }),
      hf({ id: 'b', status: 'running', childSessionId: 's2' }),
    ]
    const sessions = [live({ id: 's2', status: 'working' })]
    expect(orderCrew(handoffs, sessions).map((h) => h.id)).toEqual(['b'])
  })
})
