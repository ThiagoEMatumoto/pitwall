/** @vitest-environment node */
// Handler 'handoffs:create-manual' — a criação de filha SEM sessão-mãe pedindo
// por MCP (etapa E: abrir como sessão filha pelo diálogo de nova sessão). O que
// se trava aqui é o contrato de saída: apelido resolvido contra as sessões vivas
// e briefing composto (não-vazio, com o handoffId que a filha usa pra reportar).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateHandoffInput, Handoff } from '../../../shared/types/ipc'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, cb: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, cb)
    },
  },
}))

// Lookups do handler roteados por trecho do SQL (o resto do módulo não é exercido).
let motherRepoId: string | null = 'repo-mother'
vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (arg: unknown) => {
        if (sql.includes('SELECT id, label, path FROM repos')) {
          return arg === 'repo-target'
            ? { id: 'repo-target', label: 'legal-core', path: '/repos/legal-core' }
            : undefined
        }
        if (sql.includes('SELECT label FROM repos')) return { label: 'legal-ui' }
        if (sql.includes('FROM sessions')) return { repo_id: motherRepoId }
        if (sql.includes('FROM features')) return { title: 'Crew permanence' }
        return undefined
      },
      all: () => [],
      run: () => ({ changes: 1 }),
    }),
  }),
}))

const created: CreateHandoffInput[] = []
let activeNames: string[] = []
vi.mock('../services/handoff-store', () => ({
  create: (input: CreateHandoffInput): Handoff => {
    created.push(input)
    return { ...(input as unknown as Handoff), id: input.id!, status: 'pending' }
  },
  activeSessionNames: () => activeNames,
  list: () => [],
  get: () => null,
}))
vi.mock('../services/repo-dependency-store', () => ({ listByRepo: () => [] }))
vi.mock('../services/pty-manager', () => ({ ptyManager: { isRunning: () => false } }))
vi.mock('../services/handoff/inject', () => ({ injectIntoChild: () => {} }))

const broadcasts: unknown[] = []
vi.mock('../services/notify', () => ({
  broadcast: (_channel: string, payload: unknown) => {
    broadcasts.push(payload)
  },
}))

const { registerHandoffsIpc } = await import('./handoffs')
registerHandoffsIpc()

function createManual(raw: unknown) {
  return handlers.get('handoffs:create-manual')!(null, raw) as {
    handoff: Handoff
    alias: string
  }
}

const input = {
  repoId: 'repo-target',
  motherSessionId: 'sess-mother',
  task: 'refatorar o auth do gateway',
  featureId: 'feat-1',
  mode: 'auto-edits' as const,
}

beforeEach(() => {
  created.length = 0
  broadcasts.length = 0
  activeNames = []
  motherRepoId = 'repo-mother'
})

describe('handoffs:create-manual', () => {
  it('devolve o handoff com o apelido já resolvido', () => {
    const out = createManual(input)
    // implementer (auto-edits) começa em mauricio; o escopo vem da task.
    expect(out.alias).toBe('mauricio-refatorar-auth-gateway')
    expect(out.handoff.id).toBeTruthy()
    expect(out.handoff.task).toBe(input.task)
  })

  it('o apelido desvia dos nomes vivos AGORA (unicidade é do endereço do peer)', () => {
    activeNames = ['mauricio-outra-coisa']
    expect(createManual(input).alias).toBe('rafael-refatorar-auth-gateway')
  })

  it('compõe o briefing com o handoffId, o apelido e a tarefa', () => {
    const out = createManual(input)
    const prompt = created[0]!.composedPrompt
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).toContain(`handoffId: ${out.handoff.id}`)
    expect(prompt).toContain(out.alias)
    expect(prompt).toContain('refatorar o auth do gateway')
    // O modo molda as restrições — auto-edits avisa que as edições são aplicadas.
    expect(prompt).toContain('Modo auto-edits')
  })

  it('persiste mãe, repo-alvo, origem, feature e modo', () => {
    createManual(input)
    expect(created[0]).toMatchObject({
      motherSessionId: 'sess-mother',
      targetRepoId: 'repo-target',
      fromRepoId: 'repo-mother',
      featureId: 'feat-1',
      mode: 'auto-edits',
    })
    expect(broadcasts).toHaveLength(1)
  })

  it('mãe no MESMO repo não vira origem cross-repo (nem rótulo de repo-mãe)', () => {
    motherRepoId = 'repo-target'
    createManual(input)
    expect(created[0]!.composedPrompt).toContain('vindo do repo origem')
  })

  it('sem mode explícito cai em interactive (papel operator no apelido)', () => {
    const out = createManual({ ...input, mode: undefined })
    expect(created[0]!.mode).toBe('interactive')
    expect(out.alias).toBe('renata-refatorar-auth-gateway')
  })

  it('repo-alvo inexistente é erro (não cria handoff órfão)', () => {
    expect(() => createManual({ ...input, repoId: 'sumiu' })).toThrow(/Repo-alvo/)
    expect(created).toHaveLength(0)
  })

  it('tarefa vazia é rejeitada pelo schema (apelido sem escopo não existe)', () => {
    expect(() => createManual({ ...input, task: '' })).toThrow()
  })

  it('mãe é obrigatória — escolha explícita, sem inferir do foco', () => {
    expect(() => createManual({ ...input, motherSessionId: '' })).toThrow()
  })
})
