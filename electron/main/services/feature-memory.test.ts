/** @vitest-environment node */
// Integração do auto-sugerir de vínculo a objetivo (Onda 2): score alto grava
// o feature_link direto; score médio e baixo não escrevem NADA — nem link, nem
// task de revisão (a task era ruído que ninguém consumia). Mesma
// estratégia de setup de mcp/tools.test.ts — DB real (tmp dir), electron mockado.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'feature-memory-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

vi.mock('./session-activity', () => ({ findTranscriptPath: vi.fn() }))
vi.mock('./claude-cli', () => ({ runClaude: vi.fn() }))

import { app } from 'electron'
import { closeDb, getDb } from './db'
import {
  create as createFeature,
  get as getFeature,
  listObjectiveLinks,
  sessionRecordCount,
} from './feature-store'
import { create as createObjective, createKeyResult } from './objective-store'
import { list as listTasks } from './task-store'
import {
  maybeSuggestObjectiveLink,
  isSelfRepoPath,
  featureMemory,
  pulseCandidateFromSummary,
} from './feature-memory'
import { currentPulse, pulseHistory, setPulse } from './loop-store'
import { findTranscriptPath } from './session-activity'
import { runClaude } from './claude-cli'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec(
    'DELETE FROM feature_links; DELETE FROM tasks; DELETE FROM key_results; DELETE FROM objectives; DELETE FROM features; DELETE FROM projects;',
  )
  getDb()
    .prepare('INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('proj-1', 'Projeto de teste', Date.now(), Date.now())
})

const PROMPT = 'arruma o cache de sessao do checkout'
const TITLE_HIGH = 'arruma o cache de sessao' // substring do prompt -> fuzzyScore 1
const TITLE_MEDIUM = 'cache sessao pagamento cartao externo' // overlap parcial -> ~0.4
const TITLE_LOW = 'auditoria financeira anual relatorio' // sem overlap -> 0

function makeFeature(title = 'Feature sem OKR') {
  return createFeature({ projectId: 'proj-1', title })
}

describe('maybeSuggestObjectiveLink', () => {
  it('score alto: grava o feature_link automaticamente', () => {
    const feature = makeFeature()
    const objective = createObjective({ title: TITLE_HIGH, kind: 'okr' })

    maybeSuggestObjectiveLink(feature.id, PROMPT)

    const links = listObjectiveLinks(feature.id)
    expect(links).toEqual([{ targetType: 'objective', targetId: objective.id }])
    expect(getFeature(feature.id)?.objectiveLinkCount).toBe(1)
    expect(listTasks().filter((t) => t.tags.includes('needs-review'))).toHaveLength(0)
  })

  // Guarda contra reintroduzir a task de revisão: ela nascia aqui, no score
  // médio, e morria intocada no backlog. Quem cobra o OKR faltante é a issue
  // `okr_missing` da UI, não uma pendência criada por robô.
  it('score médio: NÃO grava link e NÃO cria task nenhuma', () => {
    const feature = makeFeature()
    createObjective({ title: TITLE_MEDIUM, kind: 'okr' })

    maybeSuggestObjectiveLink(feature.id, PROMPT)

    expect(listObjectiveLinks(feature.id)).toEqual([])
    expect(listTasks()).toHaveLength(0)
  })

  it('score baixo: não grava link nem cria task (nunca silencioso, nunca ruído)', () => {
    const feature = makeFeature()
    createObjective({ title: TITLE_LOW, kind: 'okr' })

    maybeSuggestObjectiveLink(feature.id, PROMPT)

    expect(listObjectiveLinks(feature.id)).toEqual([])
    expect(listTasks()).toHaveLength(0)
  })

  it('considera KRs ativos, não só objetivos', () => {
    const feature = makeFeature()
    const objective = createObjective({ title: 'Objetivo genérico sem overlap', kind: 'okr' })
    const kr = createKeyResult({ objectiveId: objective.id, title: TITLE_HIGH })

    maybeSuggestObjectiveLink(feature.id, PROMPT)

    expect(listObjectiveLinks(feature.id)).toEqual([{ targetType: 'key_result', targetId: kr.id }])
  })

  it('feature já linkada (objectiveLinkCount > 0) não é candidata — guarda contra sobrescrever escolha humana', () => {
    const feature = makeFeature()
    const objective = createObjective({ title: 'Objetivo qualquer', kind: 'okr' })
    const highMatch = createObjective({ title: TITLE_HIGH, kind: 'okr' })
    // Vínculo manual pré-existente.
    getDb()
      .prepare('INSERT INTO feature_links (feature_id, target_type, target_id) VALUES (?, ?, ?)')
      .run(feature.id, 'objective', objective.id)

    maybeSuggestObjectiveLink(feature.id, PROMPT)

    // Nenhum vínculo novo pro objetivo de score alto — só o manual permanece.
    expect(listObjectiveLinks(feature.id)).toEqual([{ targetType: 'objective', targetId: objective.id }])
    expect(listObjectiveLinks(feature.id).some((l) => l.targetId === highMatch.id)).toBe(false)
  })

  it('sem prompt (sessão sem 1º prompt de usuário): não faz nada', () => {
    const feature = makeFeature()
    createObjective({ title: TITLE_HIGH, kind: 'okr' })

    maybeSuggestObjectiveLink(feature.id, null)

    expect(listObjectiveLinks(feature.id)).toEqual([])
  })
})

// ---- Auto-tag app-dev (Onda 3 — separação app-dev) ----

describe('isSelfRepoPath', () => {
  it('true quando o package.json do repo tem name pitwall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-repo-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pitwall' }))
    expect(isSelfRepoPath(dir)).toBe(true)
  })

  it('false pra outro package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'other-repo-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'some-other-app' }))
    expect(isSelfRepoPath(dir)).toBe(false)
  })

  it('false sem package.json ou sem path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-pkg-'))
    expect(isSelfRepoPath(dir)).toBe(false)
    expect(isSelfRepoPath(null)).toBe(false)
  })
})

function transcriptLine(obj: unknown): string {
  return JSON.stringify(obj)
}

// Transcript mínimo que passa a guarda de atividade (userTurns>=2, editCount>=1)
// e carrega uma branch de trabalho (feat/*), pra decideRegistration cair em 'create'.
function makeSelfSessionTranscript(dir: string, branch = 'feat/self-test'): string {
  const path = join(dir, 'sess.jsonl')
  const lines = [
    transcriptLine({ gitBranch: branch, message: { role: 'user', content: 'primeiro prompt' } }),
    transcriptLine({
      gitBranch: branch,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }],
      },
    }),
    transcriptLine({ gitBranch: branch, message: { role: 'user', content: 'segundo prompt' } }),
  ]
  writeFileSync(path, lines.join('\n'))
  return path
}

function seedRepo(id: string, path: string): void {
  getDb()
    .prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, 'proj-1', ?, ?, 0, ?)`,
    )
    .run(id, id, path, Date.now())
}

describe('resolveFeature — auto-tag app-dev', () => {
  it('estampa isAppDev quando o repo da sessão é o próprio Pitwall', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'self-app-repo-'))
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'pitwall' }))
    seedRepo('repo-self', repoDir)

    const transcriptDir = mkdtempSync(join(tmpdir(), 'self-app-transcript-'))
    const transcriptPath = makeSelfSessionTranscript(transcriptDir)
    vi.mocked(findTranscriptPath).mockReturnValue(transcriptPath)

    const result = featureMemory.registerOnly({
      sessionId: 'sess-1',
      ccSessionId: 'cc-1',
      repoId: 'repo-self',
      featureId: null,
    })

    expect(result).not.toBeNull()
    const feature = getFeature(result!.featureId)
    expect(feature?.isAppDev).toBe(true)
  })

  it('NÃO estampa isAppDev pra um repo qualquer', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'other-app-repo-'))
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'some-other-app' }))
    seedRepo('repo-other', repoDir)

    const transcriptDir = mkdtempSync(join(tmpdir(), 'other-app-transcript-'))
    const transcriptPath = makeSelfSessionTranscript(transcriptDir, 'feat/other-test')
    vi.mocked(findTranscriptPath).mockReturnValue(transcriptPath)

    const result = featureMemory.registerOnly({
      sessionId: 'sess-2',
      ccSessionId: 'cc-2',
      repoId: 'repo-other',
      featureId: null,
    })

    expect(result).not.toBeNull()
    const feature = getFeature(result!.featureId)
    expect(feature?.isAppDev).toBe(false)
  })
})

// ---- Feature fantasma: stub title-only quando a síntese LLM falha (Onda 3) ----

function seedSession(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, repo_id, status, started_at) VALUES (?, NULL, 'ended', ?)`,
    )
    .run(id, Date.now())
}

describe('generateSessionRecord — feature fantasma', () => {
  it('síntese com exit != 0 grava um registro título-only e torna o rascunho visível', async () => {
    const draft = createFeature({ projectId: 'proj-1', title: 'Rascunho parado', origin: 'auto' })
    expect(sessionRecordCount(draft.id)).toBe(0)
    seedSession('sess-stub-fail')

    const transcriptDir = mkdtempSync(join(tmpdir(), 'stub-fail-transcript-'))
    const transcriptPath = makeSelfSessionTranscript(transcriptDir, 'feat/stub-fail')
    vi.mocked(findTranscriptPath).mockReturnValue(transcriptPath)
    vi.mocked(runClaude).mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' })

    featureMemory.onSessionExit({
      sessionId: 'sess-stub-fail',
      ccSessionId: 'cc-stub-fail',
      repoId: 'repo-none',
      featureId: draft.id,
    })

    await vi.waitFor(() => expect(sessionRecordCount(draft.id)).toBe(1))
    // Rascunho ganhou o 1º registro: isVisibleFeature (origin='auto' && recordCount===0)
    // deixa de valer — a feature "aparece" com o título como conteúdo do registro.
  })

  it('síntese com output vazio (summary vazio) também gera o stub', async () => {
    const draft = createFeature({ projectId: 'proj-1', title: 'Outro rascunho parado', origin: 'auto' })
    seedSession('sess-stub-empty')

    const transcriptDir = mkdtempSync(join(tmpdir(), 'stub-empty-transcript-'))
    const transcriptPath = makeSelfSessionTranscript(transcriptDir, 'feat/stub-empty')
    vi.mocked(findTranscriptPath).mockReturnValue(transcriptPath)
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: '   ', stderr: '' })

    featureMemory.onSessionExit({
      sessionId: 'sess-stub-empty',
      ccSessionId: 'cc-stub-empty',
      repoId: 'repo-none',
      featureId: draft.id,
    })

    await vi.waitFor(() => expect(sessionRecordCount(draft.id)).toBe(1))
  })

  it('feature JÁ visível (com registro) não ganha stub extra numa falha nova', async () => {
    const feature = createFeature({ projectId: 'proj-1', title: 'Feature com histórico', origin: 'auto' })
    seedSession('sess-seed')
    getDb()
      .prepare(
        `INSERT INTO feature_session_records (session_id, feature_id, cc_session_id, summary, model, session_at, created_at)
         VALUES (?, ?, NULL, 'registro real anterior', NULL, ?, ?)`,
      )
      .run('sess-seed', feature.id, Date.now(), Date.now())
    expect(sessionRecordCount(feature.id)).toBe(1)

    seedSession('sess-stub-existing')
    const transcriptDir = mkdtempSync(join(tmpdir(), 'stub-existing-transcript-'))
    const transcriptPath = makeSelfSessionTranscript(transcriptDir, 'feat/stub-existing')
    vi.mocked(findTranscriptPath).mockReturnValue(transcriptPath)
    vi.mocked(runClaude).mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' })

    featureMemory.onSessionExit({
      sessionId: 'sess-stub-existing',
      ccSessionId: 'cc-stub-existing',
      repoId: 'repo-none',
      featureId: feature.id,
    })

    // Dá tempo pro drain assíncrono rodar; sem 2º registro, a contagem some presa em 1.
    await new Promise((r) => setTimeout(r, 50))
    expect(sessionRecordCount(feature.id)).toBe(1)
  })
})

// ---- Pulso automático: rede de segurança do loop (Fase 2) ----

describe('pulseCandidateFromSummary', () => {
  it('prefere a seção de resultado/estado — o pulso é o AGORA, não o objetivo da sessão', () => {
    const summary = [
      '## Objetivo da sessão',
      'Investigar o parser de transcript.',
      '',
      '## Resultado / estado ao fim da sessão',
      'O parser volta a ler JSONL truncado; falta cobrir o caso de linha partida.',
    ].join('\n')
    expect(pulseCandidateFromSummary(summary)).toBe(
      'O parser volta a ler JSONL truncado; falta cobrir o caso de linha partida.',
    )
  })

  it('entende a forma inline com ênfase (**Estado:** ...)', () => {
    const summary = '- Mexeu no store.\n- **Estado:** migration aplicada, UI ainda desligada. Segue amanhã.'
    expect(pulseCandidateFromSummary(summary)).toBe('migration aplicada, UI ainda desligada.')
  })

  it('sem seção de resultado cai na primeira frase de prosa, sem decoração Markdown', () => {
    const summary = '## Registro\n\n**Sessão** de refactor do `loop-store`. Depois veio outra coisa.'
    expect(pulseCandidateFromSummary(summary)).toBe('Sessão de refactor do loop-store.')
  })

  it('corta no limite do pulso (200 caracteres)', () => {
    const long = `${'a'.repeat(400)}.`
    const pulse = pulseCandidateFromSummary(long)
    expect(pulse).not.toBeNull()
    expect(pulse!.length).toBe(200)
    expect(pulse!.endsWith('…')).toBe(true)
  })

  it('devolve null quando não sobra texto nenhum', () => {
    expect(pulseCandidateFromSummary('')).toBeNull()
    expect(pulseCandidateFromSummary('##\n\n   \n')).toBeNull()
  })
})

describe('generateSessionRecord — pulso automático', () => {
  function arrangeSession(id: string, branch: string): void {
    seedSession(id)
    const dir = mkdtempSync(join(tmpdir(), `${id}-`))
    vi.mocked(findTranscriptPath).mockReturnValue(makeSelfSessionTranscript(dir, branch))
  }

  it('sessão que NÃO gravou pulso ganha um derivado do registro, com source session', async () => {
    const feature = createFeature({ projectId: 'proj-1', title: 'Feature sem pulso' })
    arrangeSession('sess-pulse-auto', 'feat/pulse-auto')
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: '## Resultado\nExport do loop funciona; falta ligar no menu.',
      stderr: '',
    })

    featureMemory.onSessionExit({
      sessionId: 'sess-pulse-auto',
      ccSessionId: 'cc-pulse-auto',
      repoId: 'repo-none',
      featureId: feature.id,
    })

    await vi.waitFor(() => expect(sessionRecordCount(feature.id)).toBe(1))
    const pulse = currentPulse(feature.id)
    expect(pulse?.body).toBe('Export do loop funciona; falta ligar no menu.')
    expect(pulse?.source).toBe('session')
    expect(pulse?.sessionId).toBe('sess-pulse-auto')
    // Evita o timer da síntese holística disparar depois do teardown do DB.
    featureMemory.close()
  })

  it('sessão que JÁ fechou o loop via MCP não ganha pulso automático por cima', async () => {
    const feature = createFeature({ projectId: 'proj-1', title: 'Feature com pulso da sessão' })
    arrangeSession('sess-pulse-mcp', 'feat/pulse-mcp')
    setPulse(feature.id, 'Pulso escrito pela própria sessão via MCP.', 'mcp', 'sess-pulse-mcp')
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: '## Resultado\nOutra coisa qualquer que NÃO deve virar pulso.',
      stderr: '',
    })

    featureMemory.onSessionExit({
      sessionId: 'sess-pulse-mcp',
      ccSessionId: 'cc-pulse-mcp',
      repoId: 'repo-none',
      featureId: feature.id,
    })

    await vi.waitFor(() => expect(sessionRecordCount(feature.id)).toBe(1))
    expect(pulseHistory(feature.id)).toHaveLength(1)
    expect(currentPulse(feature.id)?.body).toBe('Pulso escrito pela própria sessão via MCP.')
    featureMemory.close()
  })

  it('pulso de uma sessão ANTIGA não bloqueia o automático desta', async () => {
    const feature = createFeature({ projectId: 'proj-1', title: 'Feature com pulso velho' })
    arrangeSession('sess-pulse-old', 'feat/pulse-old')
    getDb()
      .prepare(
        `INSERT INTO feature_pulses (id, feature_id, body, source, session_id, created_at)
         VALUES ('p-old', ?, 'Pulso de semanas atrás.', 'session', 'sess-antiga', ?)`,
      )
      .run(feature.id, Date.now() - 14 * 24 * 60 * 60 * 1000)
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: '## Resultado\nRede de segurança do pulso está de pé.',
      stderr: '',
    })

    featureMemory.onSessionExit({
      sessionId: 'sess-pulse-old',
      ccSessionId: 'cc-pulse-old',
      repoId: 'repo-none',
      featureId: feature.id,
    })

    await vi.waitFor(() => expect(sessionRecordCount(feature.id)).toBe(1))
    expect(pulseHistory(feature.id)).toHaveLength(2)
    expect(currentPulse(feature.id)?.body).toBe('Rede de segurança do pulso está de pé.')
    featureMemory.close()
  })
})
