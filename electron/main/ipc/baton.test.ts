/** @vitest-environment node */
// Gate dos handlers 'baton:pass' / 'baton:distill' (etapa I — subir a sucessora).
// Não exercita o claude real: captura os callbacks que register*Ipc passam a
// ipcMain.handle e o innerCmd que o ptyManager receberia.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

// DB falso roteado por trecho do SQL. Os filtros que importam (dismissed_at IS
// NULL, child_session_id) são aplicados AQUI contra o SQL que o código escreveu,
// pra o teste de herança valer alguma coisa.
let predecessorRow: Record<string, unknown> | undefined
let handoffRow: Record<string, unknown> | undefined
let repoRow: { path: string; label: string } | undefined = { path: '/tmp', label: 'Repo 1' }
let distillLookupRow: Record<string, unknown> | undefined
const insertedSessions: unknown[][] = []
const predecessorUpdates: unknown[][] = []
const sessionStatusUpdates: string[] = []

vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO sessions')) insertedSessions.push(args)
        if (sql.includes('predecessor_session_id')) predecessorUpdates.push(args)
        if (sql.includes('UPDATE sessions SET status')) sessionStatusUpdates.push(sql)
        return { changes: 1 }
      },
      get: (...args: unknown[]) => {
        if (sql.includes('FROM handoffs')) {
          if (!handoffRow) return undefined
          // O código PRECISA filtrar por child_session_id e por dispensa.
          if (args[0] !== handoffRow.child_session_id) return undefined
          if (sql.includes('dismissed_at IS NULL') && handoffRow.dismissed_at !== null) {
            return undefined
          }
          return handoffRow
        }
        if (sql.includes('LEFT JOIN repos r')) return distillLookupRow
        if (sql.includes('FROM sessions')) return predecessorRow
        if (sql.includes('FROM repos')) return repoRow
        return undefined
      },
      all: () => [],
    }),
  }),
}))

const spawns: Array<{ sessionId: string; innerCmd: string; cwd: string }> = []
const killed: unknown[][] = []
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    write: () => {},
    kill: (...args: unknown[]) => {
      killed.push(args)
    },
    isRunning: () => false,
    runningIds: () => [],
    spawn: (opts: { sessionId: string; args: string[]; cwd: string }) => {
      spawns.push({ sessionId: opts.sessionId, innerCmd: opts.args.join(' '), cwd: opts.cwd })
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
vi.mock('../services/session-activity', () => ({
  sessionActivityService: {},
  findTranscriptPath: () => null,
  buildSessionsFileIndex: () => new Map(),
  readTranscriptTitle: () => null,
  readTail: () => null,
  deriveEnrichment: () => ({}),
  isPidAlive: () => false,
  mapStatus: () => 'idle',
}))

let activeNames: string[] = []
vi.mock('../services/handoff-store', () => ({
  get: () => null,
  activeSessionNames: () => activeNames,
  markRunning: vi.fn((id: string, childSessionId: string) => ({
    id,
    status: 'running',
    childSessionId,
  })),
  getByChildSession: () => null,
  failIfRunning: () => null,
}))

vi.mock('../services/baton/distill', () => ({ distillBaton: vi.fn(async () => '## Estado atual\nx') }))

// Aviso à mãe: o seam é mockado pra o teste medir QUEM o bastão avisa (e com
// quê), sem depender de PTY. O comportamento interno dele (mãe viva, ausente,
// PTY que morre no meio) está coberto em services/handoff/notify-mother-alias.
const notifyMotherOfAliasChange = vi.fn(
  (_args: { handoffId: string; alias: string; previousAlias?: string | null }) =>
    ({ delivered: true }) as { delivered: boolean },
)
vi.mock('../services/handoff/notify-mother-alias', () => ({
  notifyMotherOfAliasChange: (args: {
    handoffId: string
    alias: string
    previousAlias?: string | null
  }) => notifyMotherOfAliasChange(args),
}))

import { registerBatonIpc } from './baton'
import { DESTRUCTIVE_DENYLIST } from '../services/spawn-flags'
import { registerSessionIpc } from './sessions'
import * as handoffStore from '../services/handoff-store'
import { distillBaton } from '../services/baton/distill'
const markRunning = vi.mocked(handoffStore.markRunning)
const distillMock = vi.mocked(distillBaton)

const PRED_CC = '11111111-2222-3333-4444-555555555555'
const BRIEFING = '## Estado atual\nO parser de bastão está pela metade.\n## Próximo passo\nRodar os testes.'

function predecessor(over: Record<string, unknown> = {}): void {
  predecessorRow = {
    id: 'sess-antiga',
    repo_id: 'r1',
    cc_session_id: PRED_CC,
    title: 'mauricio-auth-refactor',
    feature_id: 'f1',
    ...over,
  }
}

function linkedHandoff(over: Record<string, unknown> = {}): void {
  handoffRow = {
    id: 'h1',
    status: 'running',
    mode: 'auto-edits',
    task: 'Auth refactor',
    child_session_id: 'sess-antiga',
    dismissed_at: null,
    ...over,
  }
}

function resetSeams(): void {
  handlers.clear()
  markRunning.mockClear()
  notifyMotherOfAliasChange.mockClear()
  notifyMotherOfAliasChange.mockReturnValue({ delivered: true })
  distillMock.mockClear()
  killed.length = 0
  spawns.length = 0
  insertedSessions.length = 0
  predecessorUpdates.length = 0
  sessionStatusUpdates.length = 0
  predecessorRow = undefined
  handoffRow = undefined
  distillLookupRow = undefined
  repoRow = { path: '/tmp', label: 'Repo 1' }
  activeNames = []
  registerSessionIpc()
  registerBatonIpc()
}

interface PassResult {
  session: { id: string; repoId: string | null }
  handoff: { id: string; childSessionId: string } | null
  alias: string | null
  aliasChanged: boolean
}

function pass(input: Record<string, unknown> = {}): PassResult {
  return handlers.get('baton:pass')!(null, {
    ccSessionId: PRED_CC,
    briefing: BRIEFING,
    ...input,
  }) as PassResult
}

// O `--append-system-prompt-file` aponta pra um arquivo REAL escrito no spawn:
// ler o conteúdo é a única prova de que o briefing aprovado chegou à sucessora.
function systemPromptOf(innerCmd: string): string {
  const match = /--append-system-prompt-file '([^']+)'/.exec(innerCmd)
  expect(match).not.toBeNull()
  return readFileSync(match![1], 'utf8')
}

describe('baton:pass — sucessora sem herança', () => {
  beforeEach(() => {
    resetSeams()
    predecessor()
  })

  it('nasce no mesmo repo/feature, com o briefing aprovado no system prompt', () => {
    const result = pass()

    expect(spawns).toHaveLength(1)
    expect(spawns[0].cwd).toBe('/tmp')
    expect(result.session.repoId).toBe('r1')
    // feature_id da antecessora vai junto (é o mesmo trabalho, outra sessão).
    expect(insertedSessions[0][8]).toBe('f1')
    expect(systemPromptOf(spawns[0].innerCmd)).toContain('O parser de bastão está pela metade.')
  })

  it('sobe sessão LIMPA: sem --resume e com --session-id novo', () => {
    const result = pass()
    expect(spawns[0].innerCmd).not.toContain('--resume')
    expect(spawns[0].innerCmd).toContain('--session-id')
    expect(spawns[0].innerCmd).not.toContain(PRED_CC)
    expect(result.session.id).not.toBe('sess-antiga')
  })

  it('nasce solta: sem apelido de peer, sem --settings, sem permissão herdada', () => {
    const result = pass()
    expect(result.handoff).toBeNull()
    expect(result.alias).toBeNull()
    expect(spawns[0].innerCmd).not.toContain('--settings')
    expect(spawns[0].innerCmd).not.toContain('--permission-mode')
    expect(markRunning).not.toHaveBeenCalled()
    expect(predecessorUpdates).toHaveLength(0)
  })

  it('kickoff manda assumir o trabalho e repassa a instrução do humano', () => {
    pass({ task: 'Comece rodando a suíte de baton.' })
    expect(spawns[0].innerCmd).toContain('assumindo o trabalho de uma sessão anterior')
    expect(spawns[0].innerCmd).toContain('Comece rodando a suíte de baton.')
  })

  it('recusa briefing vazio (a sucessora subiria cega)', () => {
    expect(() => pass({ briefing: '   ' })).toThrow(/[Bb]riefing vazio/)
    expect(spawns).toHaveLength(0)
  })

  it('recusa cc_session_id desconhecido', () => {
    predecessorRow = undefined
    expect(() => pass()).toThrow(/não encontrada/)
  })

  // A antecessora fica VIVA: quem a encerra é o humano, não a passagem de bastão.
  it('não encerra a antecessora', () => {
    pass()
    expect(killed).toHaveLength(0)
    expect(sessionStatusUpdates).toHaveLength(0)
  })
})

describe('baton:pass — herança do papel de filha de handoff', () => {
  beforeEach(() => {
    resetSeams()
    predecessor()
    linkedHandoff()
  })

  it('relinka o handoff pra sucessora e grava a linhagem', () => {
    const result = pass()

    expect(markRunning).toHaveBeenCalledWith('h1', result.session.id)
    expect(result.handoff?.childSessionId).toBe(result.session.id)
    // predecessor_session_id preserva de quem veio o bastão — o markRunning
    // sobrescreve child_session_id e apagaria o elo.
    expect(predecessorUpdates).toEqual([['sess-antiga', 'h1']])
  })

  // Herdar o papel de filha sem herdar as permissões é afrouxamento silencioso:
  // a sucessora de uma filha `plan` nasceria podendo editar, e a de uma autônoma
  // sem o DESTRUCTIVE_DENYLIST que o spawnSession aplica a partir do modo.
  it('herda as permissões do modo: acceptEdits + denylist destrutivo', () => {
    pass()
    expect(spawns[0].innerCmd).toContain("--permission-mode 'acceptEdits'")
    expect(spawns[0].innerCmd).toContain('--disallowedTools')
    for (const spec of DESTRUCTIVE_DENYLIST) {
      expect(spawns[0].innerCmd).toContain(spec)
    }
  })

  it('modo plan: a sucessora volta read-only, sem denylist (nada a negar)', () => {
    linkedHandoff({ mode: 'plan' })
    pass()
    expect(spawns[0].innerCmd).toContain("--permission-mode 'plan'")
    expect(spawns[0].innerCmd).not.toContain('--disallowedTools')
  })

  it('herda o endereço: --settings da filha + apelido espelhado no título', () => {
    const result = pass()
    expect(spawns[0].innerCmd).toContain('--settings')
    expect(spawns[0].innerCmd).toContain(`-n '${result.alias}'`)
  })

  it('ignora handoff em status terminal (não ressuscita card morto)', () => {
    for (const status of ['done', 'rejected', 'failed']) {
      resetSeams()
      predecessor()
      linkedHandoff({ status })
      const result = pass()
      expect(result.handoff).toBeNull()
      expect(markRunning).not.toHaveBeenCalled()
    }
  })

  it('ignora handoff dispensado no Crew Dock', () => {
    linkedHandoff({ dismissed_at: Date.now() })
    const result = pass()
    expect(result.handoff).toBeNull()
    expect(markRunning).not.toHaveBeenCalled()
  })
})

// A decisão: com a antecessora VIVA o apelido dela continua ocupado no processo
// real, e `sessions:rename` só mexeria no SQLite (o `-n` do processo vivo não
// muda). Liberar o nome no banco seria mentir sobre o processo — então quem
// desambigua é a SUCESSORA, preservando o escopo e trocando só o nome humano.
describe('baton:pass — conflito de apelido com a antecessora viva', () => {
  beforeEach(() => {
    resetSeams()
    predecessor()
    linkedHandoff()
  })

  it('antecessora viva: sucessora troca o nome humano e mantém o escopo', () => {
    activeNames = ['mauricio-auth-refactor']
    const result = pass()

    expect(result.aliasChanged).toBe(true)
    expect(result.alias).not.toBe('mauricio-auth-refactor')
    expect(result.alias).toMatch(/-auth-refactor$/)
    expect(spawns[0].innerCmd).toContain(`-n '${result.alias}'`)
  })

  it('avisa a sucessora do endereço novo (é ela quem conta pra mãe)', () => {
    activeNames = ['mauricio-auth-refactor']
    const result = pass()
    expect(spawns[0].innerCmd).toContain(`Seu endereço de peer agora é "${result.alias}"`)
  })

  it('antecessora já encerrada: o apelido está livre e é reusado tal e qual', () => {
    activeNames = ['outra-coisa']
    const result = pass()

    expect(result.aliasChanged).toBe(false)
    expect(result.alias).toBe('mauricio-auth-refactor')
    expect(spawns[0].innerCmd).toContain("-n 'mauricio-auth-refactor'")
    expect(spawns[0].innerCmd).not.toContain('Seu endereço de peer agora é')
  })

  // Regressão: enquanto ninguém avisava a mãe, o SendMessage dela continuava
  // chegando na ANTECESSORA (viva, mas fora do trabalho) — misdelivery silenciosa
  // cuja única defesa era o humano ler o aviso do diálogo e repassar. O aviso sai
  // do BACKEND: vale por qualquer caminho, não só pelo diálogo.
  it('endereço trocado: o próprio passBaton avisa a mãe (sem passar pela UI)', () => {
    activeNames = ['mauricio-auth-refactor']
    const result = pass()

    expect(notifyMotherOfAliasChange).toHaveBeenCalledTimes(1)
    expect(notifyMotherOfAliasChange).toHaveBeenCalledWith({
      handoffId: 'h1',
      alias: result.alias,
      previousAlias: 'mauricio-auth-refactor',
    })
  })

  it('apelido reusado (antecessora encerrada): nada a avisar', () => {
    activeNames = ['outra-coisa']
    pass()
    expect(notifyMotherOfAliasChange).not.toHaveBeenCalled()
  })

  it('mãe encerrada: o aviso não chega e o bastão segue de pé', () => {
    activeNames = ['mauricio-auth-refactor']
    notifyMotherOfAliasChange.mockReturnValue({ delivered: false })
    const result = pass()

    expect(result.handoff).not.toBeNull()
    expect(result.aliasChanged).toBe(true)
    expect(spawns).toHaveLength(1)
    expect(markRunning).toHaveBeenCalled()
  })

  it('falha do aviso NÃO derruba um bastão que já deu certo', () => {
    activeNames = ['mauricio-auth-refactor']
    notifyMotherOfAliasChange.mockImplementation(() => {
      throw new Error('banco caiu no meio do aviso')
    })
    const result = pass()

    expect(result.handoff).not.toBeNull()
    expect(result.session.id).not.toBe('sess-antiga')
  })

  it('apelido legado sem escopo cai na task do handoff', () => {
    predecessor({ title: 'handoff' })
    activeNames = ['handoff']
    const result = pass()
    expect(result.aliasChanged).toBe(true)
    expect(result.alias).toMatch(/-auth-refactor$/)
  })
})

describe('baton:distill', () => {
  beforeEach(() => {
    resetSeams()
  })

  it('devolve o briefing destilado enriquecido com repo e feature', async () => {
    distillLookupRow = { repo_label: 'Repo 1', feature_title: 'Passagem de bastão' }
    const text = await handlers.get('baton:distill')!(null, {
      ccSessionId: PRED_CC,
      note: 'foca no parser',
    })

    expect(text).toContain('## Estado atual')
    expect(distillMock).toHaveBeenCalledWith(PRED_CC, {
      repoLabel: 'Repo 1',
      featureTitle: 'Passagem de bastão',
      note: 'foca no parser',
    })
  })

  it('destila mesmo sem repo/feature resolvidos', async () => {
    distillLookupRow = undefined
    await handlers.get('baton:distill')!(null, { ccSessionId: PRED_CC })
    expect(distillMock).toHaveBeenCalledWith(PRED_CC, {
      repoLabel: null,
      featureTitle: null,
      note: null,
    })
  })
})
