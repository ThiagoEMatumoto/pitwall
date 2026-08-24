/** @vitest-environment node */
// Condensação do ditado com runClaude mockado — o teste NUNCA chama `claude -p`
// de verdade. Mesma técnica de baton/distill.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./claude-cli', () => ({
  runClaude: vi.fn(),
  TEXT_ONLY_CLAUDE_ARGS: ['--tools', '', '--strict-mcp-config'],
}))

import { runClaude } from './claude-cli'
import { condense, CONDENSE_INSTRUCTION } from './voice-condense'

const DITADO =
  'então, é, eu queria que você, deixa eu pensar, abrisse um com request ' +
  'e desse força de urgem se os cheques de qualidade passarem, por favor'

beforeEach(() => {
  vi.mocked(runClaude).mockReset()
})

describe('condense', () => {
  it('chama o claude com -p, texto, haiku e timeout de 60s; devolve o texto limpo', async () => {
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'abre um pull request e dá force merge se os checks passarem\n',
      stderr: '',
    })

    const result = await condense(DITADO)

    expect(result).toEqual({
      text: 'abre um pull request e dá force merge se os checks passarem',
      condensed: true,
    })
    expect(runClaude).toHaveBeenCalledTimes(1)
    const [args, opts] = vi.mocked(runClaude).mock.calls[0]
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe(CONDENSE_INSTRUCTION + DITADO)
    // Guard-rail: o ditado entra no prompt — o condensador roda sem NENHUMA
    // tool (built-in ou MCP) e nunca executa ação a partir do que foi falado.
    expect(args.slice(2)).toEqual([
      '--output-format',
      'text',
      '--model',
      'haiku',
      '--tools',
      '',
      '--strict-mcp-config',
    ])
    expect(opts?.timeoutMs).toBe(60_000)
  })

  it('o prompt exige preservar instruções e proíbe inventar conteúdo', () => {
    expect(CONDENSE_INSTRUCTION).toContain('preserve TODAS as instruções')
    expect(CONDENSE_INSTRUCTION).toContain('NÃO invente')
    expect(CONDENSE_INSTRUCTION).toContain('na dúvida entre cortar e manter, mantenha')
    expect(CONDENSE_INSTRUCTION).toContain('responda SÓ com o texto final')
  })

  it('falha do claude (exit != 0, inclui timeout) devolve o ditado original', async () => {
    vi.mocked(runClaude).mockResolvedValue({ code: 143, stdout: '', stderr: 'ETIMEDOUT: killed' })

    expect(await condense(DITADO)).toEqual({ text: DITADO, condensed: false })
  })

  it('output vazio devolve o ditado original', async () => {
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: '   \n', stderr: '' })

    expect(await condense(DITADO)).toEqual({ text: DITADO, condensed: false })
  })

  it('volta que inchou demais é invenção — descarta e devolve o original', async () => {
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: `Claro! Aqui está o texto condensado, com algumas melhorias extras: ${DITADO} — e também sugiro configurar CI, revisar o lint e documentar tudo.`,
      stderr: '',
    })

    expect(await condense(DITADO)).toEqual({ text: DITADO, condensed: false })
  })

  it('remove a cerca de código que o modelo às vezes envolve no output', async () => {
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: '```\nabre um pull request\n```',
      stderr: '',
    })

    expect(await condense(DITADO)).toEqual({ text: 'abre um pull request', condensed: true })
  })

  it('volta idêntica ao original conta como não-condensada', async () => {
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: `${DITADO}\n`, stderr: '' })

    expect(await condense(DITADO)).toEqual({ text: DITADO, condensed: false })
  })

  it('texto em branco não gasta LLM', async () => {
    expect(await condense('   ')).toEqual({ text: '', condensed: false })
    expect(runClaude).not.toHaveBeenCalled()
  })
})
