/** @vitest-environment node */
// Adoção de sessão já aberta. O que se trava aqui: (a) o GATE — sem transcript no
// disco nada acontece, nem handoff nem PTY morta; (b) a sequência — o handoff só
// nasce depois da PTY antiga morrer, e o relance é o resumeHandoffChild (o único
// caminho que refixa apelido + accept-inbound no exec); (c) a recuperação — se o
// relance falha, o handoff fica 'interrupted' (retomável), não órfão.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateHandoffInput, Handoff } from '../../../../shared/types/ipc'

// Trilha de efeitos na ordem em que acontecem — é a ordem que importa aqui.
const trail: string[] = []

let sessionRow: {
  id: string
  repo_id: string | null
  cc_session_id: string | null
  title: string | null
  title_source: string | null
} | null = null
const renames: unknown[][] = []

vi.mock('../db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (arg: unknown) => {
        if (sql.includes('SELECT id, repo_id, cc_session_id')) return sessionRow ?? undefined
        if (sql.includes('SELECT id, label, path FROM repos')) {
          return arg === 'repo-1'
            ? { id: 'repo-1', label: 'legal-core', path: '/repos/legal-core' }
            : undefined
        }
        if (sql.includes('SELECT label FROM repos')) return { label: 'legal-ui' }
        if (sql.includes('SELECT repo_id FROM sessions')) return { repo_id: 'repo-mother' }
        return undefined
      },
      all: () => [],
      run: (...args: unknown[]) => {
        if (sql.includes('UPDATE sessions SET title')) {
          trail.push('rename')
          renames.push(args)
        }
        return { changes: 1 }
      },
    }),
  }),
}))

const created: CreateHandoffInput[] = []
let existingChildHandoff: Handoff | null = null
const failures: { id: string; error: string }[] = []
const failed: { id: string; error: string }[] = []
const dismissed: string[] = []
let markRunningCalls: { id: string; childSessionId: string }[] = []

function fakeHandoff(input: CreateHandoffInput): Handoff {
  return { ...(input as unknown as Handoff), id: input.id!, status: 'pending' }
}

vi.mock('../handoff-store', () => ({
  create: (input: CreateHandoffInput): Handoff => {
    trail.push('create-handoff')
    created.push(input)
    return fakeHandoff(input)
  },
  activeSessionNames: () => [],
  getByChildSession: () => existingChildHandoff,
  markRunning: (id: string, childSessionId: string): Handoff => {
    trail.push('mark-running')
    markRunningCalls.push({ id, childSessionId })
    return { ...fakeHandoff(created[0]!), status: 'running', childSessionId }
  },
  failIfRunning: (id: string, error: string): Handoff => {
    failures.push({ id, error })
    return { ...fakeHandoff(created[0]!), status: 'interrupted' }
  },
  fail: (id: string, error: string): Handoff => {
    trail.push('fail-handoff')
    failed.push({ id, error })
    return { ...fakeHandoff(created[0]!), status: 'failed' }
  },
  dismiss: (id: string): Handoff => {
    trail.push('dismiss-handoff')
    dismissed.push(id)
    return { ...fakeHandoff(created[0]!), status: 'failed' }
  },
}))
vi.mock('../repo-dependency-store', () => ({ listByRepo: () => [] }))
vi.mock('../notify', () => ({ broadcast: () => {} }))

let transcript: string | null = '/home/u/.claude/projects/x/cc-1.jsonl'
vi.mock('../transcript-path', () => ({ findTranscriptPath: () => transcript }))

// PTY falsa: kill emite 'exit' síncrono (o real emite assíncrono, e é justamente
// por isso que o adopt espera o evento em vez de confiar no isRunning).
const exitListeners = new Set<(e: { sessionId: string }) => void>()
let running = new Set<string>()
const writes: { sessionId: string; data: string }[] = []
vi.mock('../pty-manager', () => ({
  ptyManager: {
    isRunning: (id: string) => running.has(id),
    kill: (id: string) => {
      trail.push('kill-pty')
      // Falha do kill = o mesmo desfecho do teto de PTY_EXIT_TIMEOUT_MS (a
      // promessa rejeita), sem fazer o teste esperar 5s de verdade.
      if (killError) throw killError
      running.delete(id)
      for (const l of [...exitListeners]) l({ sessionId: id })
    },
    on: (event: string, cb: (e: { sessionId: string }) => void) => {
      if (event === 'exit') exitListeners.add(cb)
    },
    off: (event: string, cb: (e: { sessionId: string }) => void) => {
      if (event === 'exit') exitListeners.delete(cb)
    },
    write: (sessionId: string, data: string) => writes.push({ sessionId, data }),
  },
}))

let killError: Error | null = null
let resumeError: Error | null = null
const resumeCalls: { id: string; kickoff?: string }[] = []
vi.mock('../../ipc/sessions', () => ({
  resumeHandoffChild: (id: string, opts?: { kickoff?: string }) => {
    trail.push('resume')
    resumeCalls.push({ id, kickoff: opts?.kickoff })
    if (resumeError) throw resumeError
    return {
      handoff: { ...fakeHandoff(created[0]!), status: 'running' },
      session: { id: 'sess-nova' },
      alreadyRunning: false,
    }
  },
}))

const { adoptSession, adoptionKickoff } = await import('./adopt')

const input = {
  sessionId: 'sess-alvo',
  motherSessionId: 'sess-mae',
  task: 'refatorar o auth do gateway',
}

beforeEach(() => {
  trail.length = 0
  created.length = 0
  renames.length = 0
  failures.length = 0
  failed.length = 0
  dismissed.length = 0
  writes.length = 0
  markRunningCalls = []
  resumeCalls.length = 0
  resumeError = null
  killError = null
  existingChildHandoff = null
  transcript = '/home/u/.claude/projects/x/cc-1.jsonl'
  running = new Set(['sess-alvo'])
  exitListeners.clear()
  sessionRow = {
    id: 'sess-alvo',
    repo_id: 'repo-1',
    cc_session_id: '11111111-2222-3333-4444-555555555555',
    title: 'sessão comum',
    title_source: 'auto',
  }
})

describe('adoptSession — gate', () => {
  it('sem transcript no disco: não cria handoff nem mata a PTY', async () => {
    transcript = null
    await expect(adoptSession(input)).rejects.toThrow(/[Tt]ranscript/)
    expect(created).toHaveLength(0)
    expect(trail).toEqual([])
    expect(running.has('sess-alvo')).toBe(true)
  })

  it('sem cc_session_id válido: nada acontece (não há o que retomar)', async () => {
    sessionRow = { ...sessionRow!, cc_session_id: null }
    await expect(adoptSession(input)).rejects.toThrow(/Claude Code/)
    expect(created).toHaveLength(0)
    expect(trail).toEqual([])
  })

  it('sessão sem repo não vira filha (o handoff é sempre contra um repo)', async () => {
    sessionRow = { ...sessionRow!, repo_id: null }
    await expect(adoptSession(input)).rejects.toThrow(/repo/)
    expect(created).toHaveLength(0)
  })

  it('sessão que já é filha ativa não é adotada de novo', async () => {
    existingChildHandoff = { status: 'running' } as Handoff
    await expect(adoptSession(input)).rejects.toThrow(/já é filha/)
    expect(created).toHaveLength(0)
  })

  it('sessão não pode ser mãe de si mesma', async () => {
    const eu = { ...input, motherSessionId: 'sess-alvo' }
    await expect(adoptSession(eu)).rejects.toThrow(/si mesma/)
    expect(created).toHaveLength(0)
  })
})

describe('adoptSession — adoção', () => {
  it('cria o handoff com apelido e briefing compostos', async () => {
    const out = await adoptSession(input)
    expect(out.alias).toBe('renata-refatorar-auth-gateway')
    const composed = created[0]!.composedPrompt
    expect(composed.length).toBeGreaterThan(0)
    expect(composed).toContain(out.alias)
    expect(composed).toContain('refatorar o auth do gateway')
    expect(created[0]!.targetRepoId).toBe('repo-1')
    expect(created[0]!.motherSessionId).toBe('sess-mae')
  })

  it('registra a origem no contextJson (o vínculo passa pra sessão nova)', async () => {
    await adoptSession(input)
    const ctx = JSON.parse(created[0]!.contextJson!)
    expect(ctx).toMatchObject({
      adopted: true,
      adoptedFromSessionId: 'sess-alvo',
      adoptedFromCcSessionId: '11111111-2222-3333-4444-555555555555',
      adoptedFromTitle: 'sessão comum',
    })
  })

  it('fixa o apelido em sessions.title ANTES de relançar (é dele que sai o -n)', async () => {
    const out = await adoptSession(input)
    expect(renames[0]).toEqual([out.alias, 'manual', 'sess-alvo'])
    expect(trail.indexOf('rename')).toBeLessThan(trail.indexOf('resume'))
  })

  it('mata a PTY antes de vincular o handoff, e relança via resumeHandoffChild', async () => {
    const out = await adoptSession(input)
    // A ordem é o contrato: matar depois do vínculo faria o listener de exit do
    // ipc/sessions marcar o handoff como interrompido com um erro enganoso.
    expect(trail).toEqual(['create-handoff', 'rename', 'kill-pty', 'mark-running', 'resume'])
    expect(markRunningCalls).toEqual([{ id: created[0]!.id, childSessionId: 'sess-alvo' }])
    expect(resumeCalls.map((c) => c.id)).toEqual([created[0]!.id])
    expect(out.childSessionId).toBe('sess-nova')
  })

  it('a adoção vai num turno ÚNICO: o kickoff do relance carrega apelido e handoffId', async () => {
    const out = await adoptSession(input)
    // Um único resume, um único kickoff — nada de 2ª mensagem cuja ordem
    // dependeria de timing (numa máquina lenta a sessão adotada não saberia
    // que foi adotada, que é o ponto todo).
    expect(resumeCalls).toHaveLength(1)
    expect(writes).toHaveLength(0)
    const kickoff = resumeCalls[0]!.kickoff!
    expect(kickoff).toContain(out.alias)
    expect(kickoff).toContain(created[0]!.id)
    expect(kickoff).toContain('handoff_report')
  })

  it('relance que falha deixa o handoff RETOMÁVEL (interrupted), não órfão', async () => {
    resumeError = new Error('repo sumiu do disco')
    await expect(adoptSession(input)).rejects.toThrow('repo sumiu do disco')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.error).toContain('repo sumiu do disco')
  })
})

// Regressão: o kill tem teto de 5s. Quando ele estoura, a adoção morre com o
// título JÁ trocado e um handoff 'pending' sem filha — pending sem
// child_session_id não é retomável nem reconciliável, ou seja, card fantasma
// permanente. Ou completa, ou volta ao que era.
describe('adoptSession — kill que falha não deixa estado intermediário', () => {
  it('devolve o título original (com o title_source original)', async () => {
    killError = new Error('A sessão não encerrou a tempo para ser relançada como filha.')
    await expect(adoptSession(input)).rejects.toThrow(/não encerrou a tempo/)
    // 1º rename fixa o apelido; o 2º é o rollback.
    expect(renames).toHaveLength(2)
    expect(renames[1]).toEqual(['sessão comum', 'auto', 'sess-alvo'])
  })

  it('não deixa o handoff pending órfão: encerra e tira do Crew Dock', async () => {
    killError = new Error('A sessão não encerrou a tempo para ser relançada como filha.')
    await expect(adoptSession(input)).rejects.toThrow()
    expect(markRunningCalls).toHaveLength(0)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.id).toBe(created[0]!.id)
    expect(failed[0]!.error).toMatch(/antes de vincular/)
    expect(dismissed).toEqual([created[0]!.id])
    expect(trail).toEqual([
      'create-handoff',
      'rename',
      'kill-pty',
      // 2º rename = rollback do apelido.
      'rename',
      'fail-handoff',
      'dismiss-handoff',
    ])
    // failIfRunning é o caminho do RELANCE falho (recuperável); aqui não houve
    // relance nenhum, então nada de 'interrupted'.
    expect(failures).toHaveLength(0)
  })

  it('relance falho continua no caminho recuperável (não faz rollback)', async () => {
    resumeError = new Error('repo sumiu do disco')
    await expect(adoptSession(input)).rejects.toThrow('repo sumiu do disco')
    expect(failures).toHaveLength(1)
    expect(failed).toHaveLength(0)
    expect(dismissed).toHaveLength(0)
    // Título permanece o apelido: é dele que sai o -n quando o humano retomar.
    expect(renames).toHaveLength(1)
  })
})

describe('adoptionKickoff', () => {
  it('conta à sessão que ela foi adotada, o próprio endereço e como reportar', () => {
    const note = adoptionKickoff({ alias: 'renata-auth', handoffId: 'h-1', task: 'arrumar o auth' })
    expect(note).toContain('ADOTADA')
    expect(note).toContain('renata-auth')
    expect(note).toContain('handoffId: h-1')
    expect(note).toContain('handoff_report')
  })
})
