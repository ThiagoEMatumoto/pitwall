/** @vitest-environment node */
// Gate do handler 'handoffs:resume' / 'handoffs:is-resumable' (Fase 3 — robustez
// de órfãos) + RELINK no 'sessions:resume' (etapa A — permanência da crew).
// Não exercita o claude real: captura os callbacks que registerSessionIpc passa a
// ipcMain.handle e o que o ptyManager receberia, e valida GATES e innerCmd.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff } from '../../../shared/types/ipc'

// Captura os handlers registrados por canal.
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, cb: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, cb)
    },
  },
}))

// DB falso: roteia por trecho do SQL. `linkedHandoffRow` é a linha do lookup de
// relink — o filtro `dismissed_at IS NULL` é aplicado AQUI, contra o SQL real que
// o código escreveu, pra o teste do handoff dispensado valer alguma coisa.
let ccRow: Record<string, unknown> | undefined
let repoRow: { path: string; label: string } | undefined
let linkedHandoffRow: { id: string; status: string; dismissed_at: number | null } | undefined
const insertedSessionIds: string[] = []
// Tabela `sessions` EM MEMÓRIA: o INSERT do startSession e o UPDATE de título
// precisam ser observáveis pelo SELECT seguinte — é isso que permite encadear
// dois resumes e ver se o apelido sobreviveu ao primeiro.
const sessionRows = new Map<string, Record<string, unknown>>()
const titleUpdates: Array<{ id: string; title: unknown }> = []
vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO sessions')) {
          insertedSessionIds.push(args[0] as string)
          sessionRows.set(args[0] as string, {
            id: args[0],
            repo_id: args[1],
            cc_session_id: args[2],
            title: args[3],
            title_source: null,
            pane_id: args[4],
            status: args[5],
            started_at: args[6],
            ended_at: args[7],
          })
        }
        if (sql.includes('UPDATE sessions SET title')) {
          const id = args[args.length - 1] as string
          titleUpdates.push({ id, title: args[0] })
          const row = sessionRows.get(id)
          if (row) {
            row.title = args[0]
            row.title_source = 'manual'
          }
        }
        return { changes: 1 }
      },
      get: (...args: unknown[]) => {
        if (sql.includes('FROM handoffs h')) {
          if (!linkedHandoffRow) return undefined
          if (sql.includes('dismissed_at IS NULL') && linkedHandoffRow.dismissed_at !== null) {
            return undefined
          }
          return linkedHandoffRow
        }
        if (sql.includes('FROM app_prefs')) return undefined
        if (sql.includes('FROM sessions')) return sessionRows.get(args[0] as string) ?? ccRow
        return repoRow
      },
      all: () => [],
    }),
  }),
}))

const spawns: Array<{ sessionId: string; innerCmd: string }> = []
let liveSessionIds: string[] = []
// Listeners de 'data' e writes ficam capturados: é por eles que o kickoff do
// relance é observável (injectInitialCommandOnFirstData injeta no 1º byte).
const dataListeners = new Set<(e: { sessionId: string }) => void>()
const writes: Array<{ sessionId: string; data: string }> = []
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: (event: string, cb: (e: { sessionId: string }) => void) => {
      if (event === 'data') dataListeners.add(cb)
    },
    off: (_event: string, cb: (e: { sessionId: string }) => void) => {
      dataListeners.delete(cb)
    },
    write: (sessionId: string, data: string) => {
      writes.push({ sessionId, data })
    },
    isRunning: (sessionId: string) => liveSessionIds.includes(sessionId),
    runningIds: () => [],
    spawn: (opts: { sessionId: string; args: string[] }) => {
      spawns.push({ sessionId: opts.sessionId, innerCmd: opts.args.join(' ') })
    },
  },
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../services/feature-store', () => ({ get: () => null, linkedObjectiveTitles: () => [] }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: () => '/tmp/mcp.json',
  removeSessionMcpConfig: () => {},
}))
vi.mock('../services/notify', () => ({ broadcast: () => {} }))

let transcriptPath: string | null = null
vi.mock('../services/session-activity', () => ({
  sessionActivityService: {},
  findTranscriptPath: () => transcriptPath,
  buildSessionsFileIndex: () => new Map(),
  readTranscriptTitle: () => null,
  readTail: () => null,
  deriveEnrichment: () => ({}),
  isPidAlive: () => false,
  mapStatus: () => 'idle',
}))

let handoff: Handoff | null = null
vi.mock('../services/handoff-store', () => ({
  get: () => handoff,
  markRunning: vi.fn((_id: string, childSessionId: string) => ({
    ...(handoff as Handoff),
    status: 'running',
    childSessionId,
  })),
  getByChildSession: () => null,
  failIfRunning: () => null,
}))

import { registerSessionIpc, resumeHandoffChild } from './sessions'
import { DESTRUCTIVE_DENYLIST } from '../services/spawn-flags'
import * as handoffStore from '../services/handoff-store'
const markRunning = vi.mocked(handoffStore.markRunning)

function baseHandoff(over: Partial<Handoff> = {}): Handoff {
  return {
    id: 'h1',
    motherSessionId: null,
    targetRepoId: 'r1',
    targetRepoLabel: 'Repo 1',
    childSessionId: 'child-internal-1',
    featureId: null,
    task: 't',
    contextJson: null,
    composedPrompt: 'p',
    status: 'interrupted',
    mode: 'interactive',
    currentStep: null,
    stepUpdatedAt: null,
    pendingQuestion: null,
    questionAskedAt: null,
    summary: null,
    error: 'Sessão-filha encerrada sem reportar conclusão',
    createdAt: 1,
    updatedAt: 1,
    consumedAt: null,
    fromRepoId: null,
    outcome: null,
    dismissedAt: null,
    resumable: false,
    ...over,
  }
}

const VALID_CC = '11111111-2222-3333-4444-555555555555'

function resetSeams(): void {
  handlers.clear()
  markRunning.mockClear()
  spawns.length = 0
  writes.length = 0
  dataListeners.clear()
  insertedSessionIds.length = 0
  sessionRows.clear()
  titleUpdates.length = 0
  liveSessionIds = []
  handoff = null
  ccRow = undefined
  repoRow = undefined
  linkedHandoffRow = undefined
  transcriptPath = null
  registerSessionIpc()
}

describe('handoffs:resume / handoffs:is-resumable gates', () => {
  beforeEach(resetSeams)

  function resume(id = 'h1') {
    return handlers.get('handoffs:resume')!(null, id)
  }
  function isResumable(id = 'h1'): boolean {
    return handlers.get('handoffs:is-resumable')!(null, id) as boolean
  }

  it('rejeita resume quando o handoff está num status TERMINAL', () => {
    for (const status of ['done', 'rejected', 'failed'] as const) {
      handoff = baseHandoff({ status })
      expect(() => resume()).toThrow(/não-terminal/)
    }
    expect(markRunning).not.toHaveBeenCalled()
  })

  // O relink precisa cobrir running/needs_input ÓRFÃOS (o reconcileStuck pode
  // ainda não ter passado), então o guard é "não-terminal", não "== interrupted":
  // esses status passam do guard e param só no gate de cc_session_id/transcript.
  it('aceita status não-terminais além de interrupted (running/needs_input)', () => {
    ccRow = { cc_session_id: null }
    for (const status of ['running', 'needs_input', 'pending', 'approved'] as const) {
      handoff = baseHandoff({ status })
      expect(() => resume()).toThrow(/cc_session_id/)
    }
  })

  it('rejeita resume quando não há cc_session_id válido', () => {
    handoff = baseHandoff()
    ccRow = { cc_session_id: null }
    expect(() => resume()).toThrow(/cc_session_id/)
  })

  it('rejeita resume quando o transcript não existe (não-resumível)', () => {
    handoff = baseHandoff()
    ccRow = { cc_session_id: VALID_CC }
    transcriptPath = null
    expect(() => resume()).toThrow(/transcript/)
  })

  it('is-resumable: false quando não interrompido; true quando interrompido + transcript', () => {
    handoff = baseHandoff({ status: 'failed' })
    ccRow = { cc_session_id: VALID_CC }
    transcriptPath = '/tmp/t.jsonl'
    expect(isResumable()).toBe(false)

    handoff = baseHandoff() // interrupted
    expect(isResumable()).toBe(true)

    transcriptPath = null
    expect(isResumable()).toBe(false)
  })
})

// O bug que esta suíte tranca: retomar a filha por uma superfície NORMAL
// (switcher, palette, modal) caía no sessions:resume, que gerava um sessions.id
// novo e nunca atualizava handoffs.child_session_id — o handoff apontava pra um
// id morto, a filha sumia do painel e voltava sem apelido nem --settings.
describe('sessions:resume — relink da filha de handoff', () => {
  beforeEach(() => {
    resetSeams()
    repoRow = { path: '/tmp', label: 'Repo 1' }
    transcriptPath = '/tmp/t.jsonl'
  })

  function sessionsResume() {
    return handlers.get('sessions:resume')!(null, {
      repoId: 'r1',
      ccSessionId: VALID_CC,
    }) as { id: string; ccSessionId: string | null }
  }

  function linkedChild(status: string, over: Partial<Handoff> = {}): void {
    handoff = baseHandoff({ status: status as Handoff['status'], ...over })
    linkedHandoffRow = { id: 'h1', status, dismissed_at: over.dismissedAt ?? null }
    ccRow = {
      id: 'child-internal-1',
      repo_id: 'r1',
      cc_session_id: VALID_CC,
      title: 'alias-filha',
      title_source: 'manual',
      pane_id: null,
      status: 'exited',
      started_at: 1,
      ended_at: 2,
    }
  }

  it('relinka o handoff (child_session_id vira o novo sessions.id) e volta a running', () => {
    linkedChild('interrupted')
    const session = sessionsResume()

    expect(session.id).not.toBe('child-internal-1')
    expect(session.ccSessionId).toBe(VALID_CC)
    expect(markRunning).toHaveBeenCalledWith('h1', session.id)
    expect(markRunning.mock.results[0].value).toMatchObject({
      status: 'running',
      childSessionId: session.id,
    })
    // Volta COM o endereço do peer e aceitando mensagem da mãe.
    expect(spawns).toHaveLength(1)
    expect(spawns[0].innerCmd).toContain("-n 'alias-filha'")
    expect(spawns[0].innerCmd).toContain('--settings')
    expect(spawns[0].innerCmd).toContain(`--resume ${VALID_CC}`)
  })

  it('relinka também filha ÓRFÃ ainda marcada running (antes do reconcileStuck)', () => {
    linkedChild('running')
    const session = sessionsResume()
    expect(markRunning).toHaveBeenCalledWith('h1', session.id)
  })

  it('handoff DISPENSADO no Crew Dock não relinka — segue o caminho normal', () => {
    linkedChild('interrupted', { dismissedAt: 1700000000000 })
    const session = sessionsResume()

    expect(markRunning).not.toHaveBeenCalled()
    expect(session.id).not.toBe('child-internal-1')
    expect(spawns).toHaveLength(1)
    expect(spawns[0].innerCmd).not.toContain('--settings')
    // Sem alias da filha: o nome cai no label do repo.
    expect(spawns[0].innerCmd).toContain("-n 'Repo 1'")
  })

  it('handoff TERMINAL não relinka — segue o caminho normal', () => {
    for (const status of ['done', 'rejected', 'failed']) {
      resetSeams()
      repoRow = { path: '/tmp', label: 'Repo 1' }
      transcriptPath = '/tmp/t.jsonl'
      linkedChild(status)
      sessionsResume()
      expect(markRunning).not.toHaveBeenCalled()
      expect(spawns[0].innerCmd).not.toContain('--settings')
    }
  })

  // Dois PTYs sobre o mesmo transcript, e dois xterms brigando pelo resize da
  // mesma PTY: nada disso pode acontecer só porque o usuário clicou "retomar".
  it('filha VIVA não spawna PTY novo — devolve a sessão existente', () => {
    linkedChild('running')
    liveSessionIds = ['child-internal-1']

    const session = sessionsResume()

    expect(spawns).toHaveLength(0)
    expect(insertedSessionIds).toHaveLength(0)
    expect(markRunning).not.toHaveBeenCalled()
    expect(session.id).toBe('child-internal-1')
  })
})

// O kickoff é o 1º (e único) turno da filha relançada. Três coisas precisam ser
// verdade ao mesmo tempo: o painel (handoffs:resume) não pode mudar de texto
// (guard de não-regressão), a adoção precisa conseguir substituí-lo — a sessão
// adotada nunca viu briefing nenhum —, e o relink pelo switcher NÃO pode injetar
// nada: quem retomou foi o usuário, e a sessão sairia trabalhando sozinha.
describe('resumeHandoffChild — kickoff do relance', () => {
  beforeEach(() => {
    resetSeams()
    vi.useFakeTimers()
    repoRow = { path: '/tmp', label: 'Repo 1' }
    transcriptPath = '/tmp/t.jsonl'
    handoff = baseHandoff()
    linkedHandoffRow = { id: 'h1', status: 'interrupted', dismissed_at: null }
    ccRow = {
      id: 'child-internal-1',
      repo_id: 'r1',
      cc_session_id: VALID_CC,
      title: 'alias-filha',
      title_source: 'manual',
      pane_id: null,
      status: 'exited',
      started_at: 1,
      ended_at: 2,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Dispara o 1º byte da PTY nova e vence o debounce da injeção.
  function injectedCommands(sessionId: string): string[] {
    for (const listener of [...dataListeners]) listener({ sessionId })
    vi.advanceTimersByTime(1000)
    return writes.filter((w) => w.sessionId === sessionId).map((w) => w.data)
  }

  it('painel (handoffs:resume): mantém o texto original de retomar a tarefa', () => {
    handlers.get('handoffs:resume')!(null, 'h1')
    const cmds = injectedCommands(insertedSessionIds[0])
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toContain('Retome a tarefa do handoff (handoffId="h1") de onde parou.')
    expect(cmds[0]).toContain('handoff_report com handoffId="h1"')
  })

  it('com kickoff: injeta UM comando, o do chamador (nada de 2º turno)', () => {
    const { session } = resumeHandoffChild('h1', { kickoff: 'Você foi ADOTADA — apelido X' })
    const cmds = injectedCommands(session.id)
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toContain('Você foi ADOTADA — apelido X')
    expect(cmds[0]).not.toContain('Retome a tarefa do handoff')
  })

  // O bug: o usuário abre pelo switcher uma sessão que um dia foi filha e ela
  // começa a trabalhar sozinha, sem ele ter pedido nada.
  it('relink pelo switcher: relinka a identidade mas NÃO injeta kickoff', () => {
    const session = handlers.get('sessions:resume')!(null, {
      repoId: 'r1',
      ccSessionId: VALID_CC,
    }) as { id: string }

    expect(injectedCommands(session.id)).toHaveLength(0)
    // A identidade continua sendo restaurada: apelido, settings e relink.
    expect(spawns[0].innerCmd).toContain("-n 'alias-filha'")
    expect(spawns[0].innerCmd).toContain('--settings')
    expect(markRunning).toHaveBeenCalledWith('h1', session.id)
  })

  it('sem kickoff explícito: resumeHandoffChild não injeta nada', () => {
    const { session } = resumeHandoffChild('h1')
    expect(injectedCommands(session.id)).toHaveLength(0)
  })
})

// O apelido é o ENDEREÇO do peer, e cada resume cria uma LINHA NOVA em `sessions`.
// Se o alias não for re-carimbado nessa linha, o resume SEGUINTE não o acha e o
// endereço da filha muda sozinho — exatamente o que a permanência veio consertar.
describe('resumeHandoffChild — permanência do apelido entre resumes', () => {
  beforeEach(() => {
    resetSeams()
    repoRow = { path: '/tmp', label: 'Repo 1' }
    transcriptPath = '/tmp/t.jsonl'
    handoff = baseHandoff()
    ccRow = {
      id: 'child-internal-1',
      repo_id: 'r1',
      cc_session_id: VALID_CC,
      title: 'alias-filha',
      title_source: 'manual',
      pane_id: null,
      status: 'exited',
      started_at: 1,
      ended_at: 2,
    }
  })

  it('carimba title/manual na linha nova (activeSessionNames enxerga o apelido)', () => {
    const { session } = resumeHandoffChild('h1')
    expect(titleUpdates).toContainEqual({ id: session.id, title: 'alias-filha' })
    expect(session.title).toBe('alias-filha')
    expect(session.titleSource).toBe('manual')
  })

  it('SEGUNDO resume consecutivo mantém o mesmo endereço', () => {
    const first = resumeHandoffChild('h1')
    // markRunning re-aponta o handoff pra linha nova — é dela que o 2º resume
    // vai ler o apelido.
    handoff = baseHandoff({ childSessionId: first.session.id })

    const second = resumeHandoffChild('h1')

    expect(spawns).toHaveLength(2)
    expect(spawns[1].innerCmd).toContain("-n 'alias-filha'")
    expect(spawns[1].innerCmd).not.toContain('handoff: Repo 1')
    expect(second.session.title).toBe('alias-filha')
  })
})

// Uma filha em `plan` que volta do resume podendo editar é regressão de
// permissão, não de UX: o modo do handoff tem que ir junto no relance.
describe('resumeHandoffChild — permissões preservadas no relance', () => {
  beforeEach(() => {
    resetSeams()
    repoRow = { path: '/tmp', label: 'Repo 1' }
    transcriptPath = '/tmp/t.jsonl'
    ccRow = {
      id: 'child-internal-1',
      repo_id: 'r1',
      cc_session_id: VALID_CC,
      title: 'alias-filha',
      title_source: 'manual',
      pane_id: null,
      status: 'exited',
      started_at: 1,
      ended_at: 2,
    }
  })

  it('modo plan volta como --permission-mode plan (sem virar editável)', () => {
    handoff = baseHandoff({ mode: 'plan' })
    resumeHandoffChild('h1')
    expect(spawns[0].innerCmd).toContain("--permission-mode 'plan'")
  })

  it('modo auto-edits volta com acceptEdits + denylist destrutivo', () => {
    handoff = baseHandoff({ mode: 'auto-edits' })
    resumeHandoffChild('h1')
    expect(spawns[0].innerCmd).toContain("--permission-mode 'acceptEdits'")
    expect(spawns[0].innerCmd).toContain('--disallowedTools')
    for (const spec of DESTRUCTIVE_DENYLIST) {
      expect(spawns[0].innerCmd).toContain(spec)
    }
  })

  it('modo interactive fica sem flag (default do claude) e sem denylist', () => {
    handoff = baseHandoff({ mode: 'interactive' })
    resumeHandoffChild('h1')
    expect(spawns[0].innerCmd).not.toContain('--permission-mode')
    expect(spawns[0].innerCmd).not.toContain('--disallowedTools')
  })
})
