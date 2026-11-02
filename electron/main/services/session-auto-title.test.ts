import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('./transcript-path', () => ({
  PROJECTS_ROOT: '/nonexistent-projects-root',
  findTranscriptPath: () => null,
}))
vi.mock('./db', () => ({ getDb: () => ({}) }))

import { forgetFirstPrompt, readFirstPrompt, type SessionTitleResult } from './session-purpose'
import {
  AUTO_TITLE_MAX_ATTEMPTS,
  AUTO_TITLE_MAX_CONCURRENT,
  AUTO_TITLE_RETRY_MS,
  createAutoTitler,
  isAutoTitleCandidate,
  type AutoTitleNode,
} from './session-auto-title'

const dir = mkdtempSync(join(tmpdir(), 'auto-title-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function mother(id: string, over: Partial<AutoTitleNode> = {}): AutoTitleNode {
  return {
    sessionId: id,
    ccSessionId: `cc-${id}`,
    provider: 'claude',
    status: 'idle',
    titleSource: null,
    autoTitle: null,
    hierarchyMotherId: null,
    childOfHandoffId: null,
    ...over,
  }
}

function harness(opts: { prompt?: (cc: string) => string | null; now?: () => number } = {}) {
  const pending = new Map<string, (r: SessionTitleResult) => void>()
  const summarize = vi.fn(
    (cc: string) => new Promise<SessionTitleResult>((resolve) => pending.set(cc, resolve)),
  )
  const save = vi.fn((_sessionId: string, _title: string) => true)
  const onSaved = vi.fn()
  const titler = createAutoTitler({
    readPrompt: opts.prompt ?? (() => 'Corrigir o login'),
    summarize,
    save,
    onSaved,
    now: opts.now ?? (() => 0),
    log: () => {},
  })
  const settle = async (cc: string, r: SessionTitleResult) => {
    pending.get(cc)!(r)
    pending.delete(cc)
    // Só a geração desta conversa assenta; as outras seguem em voo.
    await new Promise((r) => setImmediate(r))
  }
  return { titler, summarize, save, onSaved, settle, pending }
}

describe('isAutoTitleCandidate — régua de elegibilidade', () => {
  it('mãe viva do claude sem título manual nem auto é candidata', () => {
    expect(isAutoTitleCandidate(mother('m'))).toBe(true)
  })

  it('filha (hierarquia ou vínculo vivo), manual, com auto, encerrada ou codex não', () => {
    expect(isAutoTitleCandidate(mother('k', { hierarchyMotherId: 'mae' }))).toBe(false)
    expect(isAutoTitleCandidate(mother('k', { childOfHandoffId: 'h1' }))).toBe(false)
    expect(isAutoTitleCandidate(mother('m', { titleSource: 'manual' }))).toBe(false)
    expect(isAutoTitleCandidate(mother('m', { autoTitle: 'Já tem' }))).toBe(false)
    expect(isAutoTitleCandidate(mother('m', { status: 'ended' }))).toBe(false)
    expect(isAutoTitleCandidate(mother('m', { provider: 'codex', ccSessionId: null }))).toBe(false)
  })

  it('hierarchyMotherId apontando pra si mesma (dado sujo) não é filha', () => {
    expect(isAutoTitleCandidate(mother('m', { hierarchyMotherId: 'm' }))).toBe(true)
  })
})

describe('createAutoTitler — gatilho idempotente', () => {
  it('sem 1º prompt não gera; com o 1º prompt lido do JSONL real, gera e grava', async () => {
    const file = join(dir, 'cc-live.jsonl')
    let hasPrompt = false
    const reader = (cc: string) => (hasPrompt ? readFirstPrompt(cc, true, () => file) : null)
    const h = harness({ prompt: reader })
    h.titler.consider([mother('live')])
    expect(h.summarize).not.toHaveBeenCalled()

    writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Corrigir o redirect do login no Safari' },
      }),
    )
    hasPrompt = true
    h.titler.consider([mother('live')])
    expect(h.summarize).toHaveBeenCalledWith('cc-live')
    await h.settle('cc-live', { ok: true, title: 'Corrige login no Safari' })
    expect(h.save).toHaveBeenCalledWith('live', 'Corrige login no Safari')
    expect(h.onSaved).toHaveBeenCalledWith('live', 'cc-live', 'Corrige login no Safari')
    expect(h.titler.stats()).toMatchObject({ attempts: 1, succeeded: 1, failed: 0 })
    forgetFirstPrompt('cc-live')
  })

  it('não dispara de novo enquanto roda nem depois de gravar', async () => {
    const h = harness()
    h.titler.consider([mother('m')])
    h.titler.consider([mother('m')])
    expect(h.summarize).toHaveBeenCalledTimes(1)
    await h.settle('cc-m', { ok: true, title: 'Corrige login' })
    // O grafo pode chegar antes de refletir o banco: a conversa já foi atendida.
    h.titler.consider([mother('m')])
    expect(h.summarize).toHaveBeenCalledTimes(1)
  })

  it(`no máximo ${AUTO_TITLE_MAX_CONCURRENT} gerações concorrentes; as outras ficam pro próximo tick`, async () => {
    const h = harness()
    h.titler.consider([mother('a'), mother('b'), mother('c')])
    expect(h.summarize).toHaveBeenCalledTimes(AUTO_TITLE_MAX_CONCURRENT)
    await h.settle('cc-a', { ok: true, title: 'A' })
    h.titler.consider([mother('b'), mother('c')])
    expect(h.summarize).toHaveBeenLastCalledWith('cc-c')
  })

  it('falha não grava e re-tenta só depois do intervalo, no máximo 2 vezes', async () => {
    let t = 0
    const h = harness({ now: () => t })
    h.titler.consider([mother('m')])
    await h.settle('cc-m', { ok: false, error: 'timeout' })
    expect(h.save).not.toHaveBeenCalled()

    t = AUTO_TITLE_RETRY_MS - 1
    h.titler.consider([mother('m')])
    expect(h.summarize).toHaveBeenCalledTimes(1)

    t = AUTO_TITLE_RETRY_MS
    h.titler.consider([mother('m')])
    expect(h.summarize).toHaveBeenCalledTimes(AUTO_TITLE_MAX_ATTEMPTS)
    await h.settle('cc-m', { ok: false, error: 'timeout' })

    t = 10 * AUTO_TITLE_RETRY_MS
    h.titler.consider([mother('m')])
    expect(h.summarize).toHaveBeenCalledTimes(AUTO_TITLE_MAX_ATTEMPTS)
    expect(h.titler.stats()).toMatchObject({ attempts: 2, succeeded: 0, failed: 2, gaveUp: 1 })
  })

  it('gravação recusada (manual ou self chegou antes) não avisa a UI nem re-tenta', async () => {
    const h = harness()
    h.save.mockReturnValue(false)
    h.titler.consider([mother('m')])
    await h.settle('cc-m', { ok: true, title: 'Corrige login' })
    expect(h.onSaved).not.toHaveBeenCalled()
    h.titler.consider([mother('m')])
    expect(h.summarize).toHaveBeenCalledTimes(1)
    expect(h.titler.stats()).toMatchObject({ discarded: 1 })
  })
})
