import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => new Map<string, string>())
vi.mock('./transcript-path', () => ({
  PROJECTS_ROOT: '/nonexistent-projects-root',
  findTranscriptPath: (id: string) => paths.get(id) ?? null,
}))
vi.mock('./db', () => ({ getDb: () => ({}) }))

import { parseChatMessages } from './chat-transcript'
import { REFRESH_MIN_INTERVAL_MS, TranscriptIndex } from './transcript-index'
import {
  LIVE_RETRY_MS,
  NEGATIVE_TTL_MS,
  PURPOSE_MAX_CHARS,
  WHERE_LEFT_OFF_INSTRUCTION,
  cleanPrompt,
  firstUserPrompt,
  forgetFirstPrompt,
  lastUserPrompt,
  readLastPrompt,
  readFirstPrompt,
  resolvePurpose,
  summarizeWhereLeftOff,
  whereLeftOffExcerpt,
} from './session-purpose'

// Linhas no formato que o Claude Code grava no JSONL — os mesmos shapes das
// fixtures de chat-transcript.test.ts ("Shapes espelham transcripts reais"): o
// que a CLI grava como type:'user' sem o humano ter digitado vem ANTES do 1º
// prompt de verdade numa sessão real (caveat do /model, o comando, o stdout,
// skill injetada com isMeta).
const line = (o: object) => JSON.stringify(o)
const REAL_SHAPES = [
  line({ type: 'ai-title', aiTitle: 'Some title' }),
  line({
    type: 'user',
    message: {
      role: 'user',
      content:
        '<local-command-caveat>Caveat: the messages below were generated…</local-command-caveat>',
    },
  }),
  line({
    type: 'user',
    message: {
      role: 'user',
      content:
        '<command-message>goal is running…</command-message>\n<command-name>/goal</command-name>\n<command-args>review the PR</command-args>',
    },
  }),
  line({
    type: 'user',
    message: {
      role: 'user',
      content: '<local-command-stdout>\u001B[1mSet model to\u001B[22m opus</local-command-stdout>',
    },
  }),
  line({
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: '# SKILL.md\n\nInjected skill body.' },
  }),
  line({
    type: 'user',
    message: {
      role: 'user',
      content:
        'Migrar o checkout para o\n  novo gateway de pagamentos, mantendo o fallback antigo por uma semana enquanto o time de risco valida os números de chargeback',
    },
  }),
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Vou começar pelo client do gateway.' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } },
      ],
    },
  }),
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'file body', is_error: false },
      ],
    },
  }),
  line({ type: 'user', message: { role: 'user', content: 'agora roda os testes' } }),
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Testes verdes; falta o webhook.' }],
    },
  }),
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'session-purpose-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  paths.clear()
})

describe('resolvePurpose — precedência', () => {
  it('edição do usuário/da sessão > tarefa do handoff > 1º prompt > null', () => {
    expect(resolvePurpose({ userPurpose: 'A', handoffTask: 'B', firstPrompt: 'C' })).toEqual({
      text: 'A',
      source: 'user',
    })
    expect(resolvePurpose({ userPurpose: '  ', handoffTask: 'B', firstPrompt: 'C' })).toEqual({
      text: 'B',
      source: 'handoff',
    })
    expect(resolvePurpose({ userPurpose: null, handoffTask: null, firstPrompt: 'C' })).toEqual({
      text: 'C',
      source: 'transcript',
    })
    expect(resolvePurpose({ userPurpose: null, handoffTask: null, firstPrompt: null })).toBeNull()
  })

  it('a tarefa do handoff vira uma linha só e é cortada', () => {
    const task = `## Tarefa\n${'x'.repeat(300)}`
    const out = resolvePurpose({ userPurpose: null, handoffTask: task, firstPrompt: null })
    expect(out?.text.startsWith('## Tarefa x')).toBe(true)
    expect(out!.text.length).toBeLessThanOrEqual(PURPOSE_MAX_CHARS)
  })
})

describe('firstUserPrompt', () => {
  it('pula caveat, comando, stdout e skill injetada e corta o 1º prompt humano', () => {
    const got = firstUserPrompt(parseChatMessages(REAL_SHAPES))
    expect(got?.startsWith('Migrar o checkout para o novo gateway de pagamentos')).toBe(true)
    expect(got!.length).toBeLessThanOrEqual(PURPOSE_MAX_CHARS)
    expect(got!.endsWith('…')).toBe(true)
  })

  it('sem prompt humano → null', () => {
    expect(
      firstUserPrompt(parseChatMessages(REAL_SHAPES.split('\n').slice(0, 5).join('\n'))),
    ).toBeNull()
  })
})

describe('cleanPrompt — o 1º prompt como identificação da sessão', () => {
  const userLine = (content: string) => line({ type: 'user', message: { role: 'user', content } })

  it('pula o kickoff da filha e usa o prompt seguinte', () => {
    const jsonl = [
      userLine(
        'Comece a tarefa do handoff descrita no seu contexto de sistema. Ao terminar, chame a MCP tool handoff_report com handoffId="h-1".',
      ),
      userLine('Agora rode a migração no staging'),
    ].join('\n')
    expect(firstUserPrompt(parseChatMessages(jsonl))).toBe('Agora rode a migração no staging')
  })

  it('kickoff do bastão só vale pela instrução do humano', () => {
    const baton =
      'Você está assumindo o trabalho de uma sessão anterior cujo contexto encheu. O briefing dela está no seu system prompt. Instrução do humano para este começo: fechar o PR do convite Você assumiu o handoff handoffId="h-2"; ao terminar, chame a MCP tool handoff_report.'
    expect(cleanPrompt(baton)).toBe('fechar o PR do convite')
    expect(
      cleanPrompt(
        'Você está assumindo o trabalho de uma sessão anterior cujo contexto encheu. Leia o briefing.',
      ),
    ).toBeNull()
  })

  it('tira a colagem e fica com o pedido escrito em volta', () => {
    expect(
      cleanPrompt('<pasted_content id="67b7">log enorme\nlinha 2</pasted_content> por que isso quebra?'),
    ).toBe('por que isso quebra?')
    expect(cleanPrompt('<pasted_content id="67b7"> resume o erro acima')).toBe('resume o erro acima')
  })

  it('URL do Linear vira chave · slug legível', () => {
    expect(
      cleanPrompt('https://linear.app/lexter/issue/POP-348/combinar-o-inicio-da-pericia'),
    ).toBe('POP-348 · combinar o inicio da pericia')
  })

  it('link do Slack sozinho não serve: vale o prompt seguinte', () => {
    const jsonl = [
      userLine('https://lexter-workspace.slack.com/archives/C0123/p1700000000'),
      userLine('Investigar o alerta de fila parada'),
    ].join('\n')
    expect(firstUserPrompt(parseChatMessages(jsonl))).toBe('Investigar o alerta de fila parada')
    expect(cleanPrompt('veja https://x.slack.com/archives/C1/p2 e responda')).toBe('veja e responda')
  })

  it('última mensagem do usuário, limpa', () => {
    const jsonl = [userLine('primeiro pedido'), userLine('https://x.slack.com/a/b'), userLine('ajusta o teste')]
      .join('\n')
    expect(lastUserPrompt(parseChatMessages(jsonl))).toBe('ajusta o teste')
  })
})

describe('readLastPrompt — fim do transcript', () => {
  it('lê a última mensagem do fim do arquivo; encerrada fica cacheada', () => {
    const file = join(dir, 'cc-last.jsonl')
    writeFileSync(file, REAL_SHAPES)
    paths.set('cc-last', file)
    const lookup = (id: string) => paths.get(id) ?? null
    expect(readLastPrompt('cc-last', false, lookup)).toBe('agora roda os testes')
    paths.delete('cc-last')
    expect(readLastPrompt('cc-last', false, lookup)).toBe('agora roda os testes')
    forgetFirstPrompt('cc-last')
    expect(readLastPrompt('cc-last', false, lookup)).toBeNull()
  })
})

describe('readFirstPrompt — transcript JSONL em disco', () => {
  const lookup = (id: string) => paths.get(id) ?? null

  it('lê o 1º prompt do arquivo e cacheia por sessão (positivo permanente)', () => {
    const file = join(dir, 'cc-a.jsonl')
    writeFileSync(file, REAL_SHAPES)
    paths.set('cc-a', file)
    expect(readFirstPrompt('cc-a', false, lookup)).toMatch(/^Migrar o checkout/)
    // Sem o arquivo, o cache responde (o 1º prompt de uma sessão não muda).
    paths.delete('cc-a')
    expect(readFirstPrompt('cc-a', false, lookup)).toMatch(/^Migrar o checkout/)
    forgetFirstPrompt('cc-a')
  })

  it('miss de sessão encerrada vale 10 min: não relê o disco a cada rebuild do grafo', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const spy = vi.fn(lookup)
    expect(readFirstPrompt('cc-late', false, spy)).toBeNull()
    const file = join(dir, 'cc-late.jsonl')
    writeFileSync(file, REAL_SHAPES)
    paths.set('cc-late', file)
    now.mockReturnValue(1_000_000 + NEGATIVE_TTL_MS - 1)
    expect(readFirstPrompt('cc-late', false, spy)).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
    now.mockReturnValue(1_000_000 + NEGATIVE_TTL_MS)
    expect(readFirstPrompt('cc-late', false, spy)).toMatch(/^Migrar/)
    now.mockRestore()
    forgetFirstPrompt('cc-late')
  })

  it('sessão viva retenta a cada 30s (o 1º prompt pode chegar a qualquer momento)', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    expect(readFirstPrompt('cc-live', true, lookup)).toBeNull()
    const file = join(dir, 'cc-live.jsonl')
    writeFileSync(file, REAL_SHAPES)
    paths.set('cc-live', file)
    now.mockReturnValue(2_000_000 + LIVE_RETRY_MS - 1)
    expect(readFirstPrompt('cc-live', true, lookup)).toBeNull()
    now.mockReturnValue(2_000_000 + LIVE_RETRY_MS)
    expect(readFirstPrompt('cc-live', true, lookup)).toMatch(/^Migrar/)
    now.mockRestore()
    forgetFirstPrompt('cc-live')
  })

  it('sessão viva sem transcript pede ao índice pra continuar varrendo', () => {
    const want = vi.fn()
    expect(readFirstPrompt('cc-quiet', true, lookup, want)).toBeNull()
    expect(want).toHaveBeenCalledWith('cc-quiet')
    expect(readFirstPrompt('cc-dead', false, lookup, want)).toBeNull()
    expect(want).toHaveBeenCalledTimes(1)
    forgetFirstPrompt('cc-quiet')
    forgetFirstPrompt('cc-dead')
  })

  it('índice: um want se reagenda sozinho até o transcript nascer, sem push do grafo', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'cm-want-'))
    const index = new TranscriptIndex(root)
    const seen: string[][] = []
    index.onGrow((ids) => seen.push(ids))
    await index.refresh()
    index.want('cc-later')
    mkdirSync(join(root, '-repo'))
    writeFileSync(join(root, '-repo', 'cc-later.jsonl'), REAL_SHAPES)
    await vi.advanceTimersByTimeAsync(REFRESH_MIN_INTERVAL_MS + 10)
    await vi.waitFor(() => expect(seen).toEqual([['cc-later']]))
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('o índice achar o transcript limpa o miss na hora', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-index-'))
    const index = new TranscriptIndex(root)
    const seen: string[][] = []
    index.onGrow((ids) => seen.push(ids))
    expect(index.lookup('cc-new')).toBeNull()
    await index.refresh()
    mkdirSync(join(root, '-home-x-repo'))
    writeFileSync(join(root, '-home-x-repo', 'cc-new.jsonl'), REAL_SHAPES)
    // Varredura recente: o miss seguinte não agenda outra antes do intervalo.
    expect(index.lookup('cc-new')).toBeNull()
    expect(await index.refresh()).toEqual(['cc-new'])
    expect(seen).toEqual([['cc-new']])
    expect(index.lookup('cc-new')).toBe(join(root, '-home-x-repo', 'cc-new.jsonl'))
    rmSync(root, { recursive: true, force: true })
  })
})

describe('onde parei', () => {
  it('o trecho é o último pedido do usuário + o que o agente respondeu depois', () => {
    const excerpt = whereLeftOffExcerpt(parseChatMessages(REAL_SHAPES))
    expect(excerpt).toContain('agora roda os testes')
    expect(excerpt).toContain('Testes verdes; falta o webhook.')
    expect(excerpt).not.toContain('Vou começar pelo client')
  })

  it('summarizeWhereLeftOff roda o claude só-texto sobre o trecho e devolve o resumo', async () => {
    const file = join(dir, 'cc-sum.jsonl')
    writeFileSync(file, REAL_SHAPES)
    paths.set('cc-sum', file)
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'Parou no webhook.\n', stderr: '' })
    const out = await summarizeWhereLeftOff('cc-sum', run)
    expect(out).toEqual({ ok: true, summary: 'Parou no webhook.' })
    const args = run.mock.calls[0][0] as string[]
    expect(args[1].startsWith(WHERE_LEFT_OFF_INSTRUCTION)).toBe(true)
    // O conteúdo da sessão entra no prompt: o resumidor NUNCA pode ter tools.
    expect(args).toEqual(expect.arrayContaining(['--tools', '', '--strict-mcp-config']))
  })

  it('sem transcript não gasta claude', async () => {
    const run = vi.fn()
    expect(await summarizeWhereLeftOff('cc-none', run)).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
  })
})
