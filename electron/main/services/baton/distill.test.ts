/** @vitest-environment node */
// Destilação do bastão sobre um transcript-fixture real (JSONL no tmp), com
// findTranscriptPath e runClaude mockados — o teste NUNCA chama `claude -p` de
// verdade. Mesma técnica de feature-memory.test.ts:22-23.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../session-activity', () => ({ findTranscriptPath: vi.fn() }))
vi.mock('../claude-cli', () => ({ runClaude: vi.fn() }))

import { findTranscriptPath } from '../session-activity'
import { runClaude } from '../claude-cli'
import { distillBaton } from './distill'
import { BATON_SECTIONS } from './compose-baton-prompt'

const dir = mkdtempSync(join(tmpdir(), 'baton-distill-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

// Transcript com o sinal que o bastão precisa carregar: pedido do usuário, edições,
// um comando que falhou e o snapshot de todos.
function makeTranscript(name: string): string {
  const path = join(dir, `${name}.jsonl`)
  const branch = 'feat/crew-permanence'
  const lines = [
    line({ gitBranch: branch, message: { role: 'user', content: 'implementa a destilação do bastão' } }),
    line({
      gitBranch: branch,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'electron/main/services/baton/distill.ts' } }],
      },
    }),
    line({
      gitBranch: branch,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npx vitest run electron/main/services/baton/' } }],
      },
    }),
    line({
      gitBranch: branch,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: { todos: [{ content: 'mockar runClaude', status: 'completed' }] },
          },
        ],
      },
    }),
    line({ gitBranch: branch, message: { role: 'user', content: 'agora escreve o teste' } }),
    line({ gitBranch: branch, message: { role: 'assistant', content: [{ type: 'text', text: 'teste escrito' }] } }),
  ]
  writeFileSync(path, lines.join('\n'))
  return path
}

const BRIEFING = `${BATON_SECTIONS[0]}\nA destilação está pronta.\n\n${BATON_SECTIONS[4]}\nRodar os testes.`

beforeEach(() => {
  vi.mocked(findTranscriptPath).mockReset()
  vi.mocked(runClaude).mockReset()
})

describe('distillBaton', () => {
  it('destila o transcript e devolve o briefing do claude', async () => {
    vi.mocked(findTranscriptPath).mockReturnValue(makeTranscript('happy'))
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: `${BRIEFING}\n`, stderr: '' })

    const briefing = await distillBaton('cc-happy', { repoLabel: 'claude-manager', note: 'foca no que falta' })

    expect(briefing).toBe(BRIEFING)
    expect(runClaude).toHaveBeenCalledTimes(1)
    const [args, opts] = vi.mocked(runClaude).mock.calls[0]
    expect(args[0]).toBe('-p')
    expect(args.slice(2)).toEqual(['--output-format', 'text'])
    // Timeout do precedente (feature-memory): 90s.
    expect(opts?.timeoutMs).toBe(90_000)
  })

  it('leva pro prompt o sinal do transcript + as opções, e pede as seções do bastão', async () => {
    vi.mocked(findTranscriptPath).mockReturnValue(makeTranscript('prompt'))
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: BRIEFING, stderr: '' })

    await distillBaton('cc-prompt', {
      repoLabel: 'claude-manager',
      featureTitle: 'Passagem de bastão',
      note: 'foca no que falta',
    })

    const prompt = vi.mocked(runClaude).mock.calls[0][0][1]
    for (const section of BATON_SECTIONS) expect(prompt).toContain(section)
    expect(prompt).toContain('feat/crew-permanence')
    expect(prompt).toContain('electron/main/services/baton/distill.ts')
    expect(prompt).toContain('npx vitest run')
    expect(prompt).toContain('mockar runClaude')
    expect(prompt).toContain('implementa a destilação do bastão')
    expect(prompt).toContain('Passagem de bastão')
    expect(prompt).toContain('foca no que falta')
  })

  it('passa --model quando pedido', async () => {
    vi.mocked(findTranscriptPath).mockReturnValue(makeTranscript('model'))
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: BRIEFING, stderr: '' })

    await distillBaton('cc-model', { model: 'opus' })

    expect(vi.mocked(runClaude).mock.calls[0][0].slice(-2)).toEqual(['--model', 'opus'])
  })

  it('remove a cerca de código que o modelo às vezes envolve no output inteiro', async () => {
    vi.mocked(findTranscriptPath).mockReturnValue(makeTranscript('fence'))
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: '```markdown\n' + BRIEFING + '\n```', stderr: '' })

    expect(await distillBaton('cc-fence')).toBe(BRIEFING)
  })

  it('erro legível quando o transcript não existe (e não chama o claude)', async () => {
    vi.mocked(findTranscriptPath).mockReturnValue(null)

    await expect(distillBaton('cc-sumiu')).rejects.toThrow(/Transcript da sessão cc-sumiu não encontrado/)
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('transcript sem trabalho registrado não gasta LLM', async () => {
    const path = join(dir, 'vazio.jsonl')
    writeFileSync(path, '{"type":"summary"}\nlinha quebrada\n')
    vi.mocked(findTranscriptPath).mockReturnValue(path)

    await expect(distillBaton('cc-vazio')).rejects.toThrow(/nada para destilar/)
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('propaga a stderr do claude quando o exit é != 0 (inclui timeout)', async () => {
    vi.mocked(findTranscriptPath).mockReturnValue(makeTranscript('falha'))
    vi.mocked(runClaude).mockResolvedValue({ code: 143, stdout: '', stderr: 'ETIMEDOUT: killed' })

    await expect(distillBaton('cc-falha')).rejects.toThrow(/Destilação do bastão falhou \(ETIMEDOUT: killed\)/)
  })

  it('output vazio vira erro em vez de briefing em branco', async () => {
    vi.mocked(findTranscriptPath).mockReturnValue(makeTranscript('vazio-out'))
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: '   \n', stderr: '' })

    await expect(distillBaton('cc-vazio-out')).rejects.toThrow(/briefing vazio/)
  })
})
