import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScreenTailFeed, readStyledTail, type TailSnapshot } from './screen-tail'
import type { ScreenTailUpdate } from '../../../shared/types/send-prompt'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

const FIXTURES = join(__dirname, '..', '..', '..', 'shared', 'tui', '__fixtures__')

function write(term: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('readStyledTail', () => {
  it('lê o fim da tela com cor de paleta, RGB, bold e dim, sem as linhas em branco do fim', async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    await write(
      term,
      'plain\r\n\x1b[31mred\x1b[0m ok\r\n\x1b[1;38;2;255;128;0mclaude\x1b[0m\r\n\x1b[2mdim\x1b[0m',
    )
    expect(readStyledTail(term, 12)).toEqual([
      [{ t: 'plain' }],
      [{ t: 'red', fg: 1 }, { t: ' ok' }],
      [{ t: 'claude', fg: '#ff8000', b: true }],
      [{ t: 'dim', d: true }],
    ])
    term.dispose()
  })

  it('corta a caixa de input do claude e o rodapé abaixo dela', async () => {
    const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
    const rule = '─'.repeat(30)
    await write(
      term,
      `● Rodando os testes\r\n  ⎿  3 passed\r\n\r\n${rule}\r\n❯ \r\n${rule}\r\n  ? for shortcuts`,
    )
    expect(readStyledTail(term, 12)).toEqual([
      [{ t: '● Rodando os testes' }],
      [{ t: '  ⎿  3 passed' }],
    ])
    term.dispose()
  })

  // Bytes reais do node-pty (claude 2.1.286): o que o espelho de fato recebe.
  it('captura real: tela ociosa sem a caixa de input; menu de permissão inteiro', async () => {
    const read = async (file: string) => {
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      await write(term, readFileSync(join(FIXTURES, file), 'utf8'))
      const text = readStyledTail(term, 12).map((l) => l.map((seg) => seg.t).join(''))
      term.dispose()
      return text
    }
    const idle = await read('claude-2.1.286-idle-prompt.ansi')
    expect(idle.some((l) => l.includes('Claude Code v2.1.286'))).toBe(true)
    expect(idle.some((l) => l.trimStart().startsWith('❯'))).toBe(false)
    const permission = await read('claude-2.1.286-permission-bash.ansi')
    expect(permission).toContain(' Do you want to proceed?')
    expect(permission.some((l) => l.includes('1. Yes'))).toBe(true)
  })

  it('tira réguas, prompt vazio e brancos repetidos ANTES de cortar as últimas n', async () => {
    const term = new Terminal({ cols: 40, rows: 12, allowProposedApi: true })
    const rule = '─'.repeat(30)
    await write(term, `● um\r\n${rule}\r\n› \r\n\r\n\r\n● dois\r\n╌╌╌╌╌╌\r\n● três\r\n${rule}`)
    const text = readStyledTail(term, 4).map((l) => l.map((seg) => seg.t).join(''))
    expect(text).toEqual(['● um', '', '● dois', '● três'])
    term.dispose()
  })

  // Contra a tela REAL (bytes do node-pty), não só a sintética acima.
  it('captura real do menu de permissão: nenhuma linha só de moldura sobra', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    await write(term, readFileSync(join(FIXTURES, 'claude-2.1.286-permission-bash.ansi'), 'utf8'))
    const text = readStyledTail(term, 12).map((l) => l.map((seg) => seg.t).join(''))
    term.dispose()
    expect(text.some((l) => /^[\s─╌]+$/.test(l) && l.trim() !== '')).toBe(false)
    expect(text.some((l, i) => l === '' && text[i + 1] === '')).toBe(false)
    // O conteúdo útil continua: a pergunta e as opções.
    expect(text).toContain(' Do you want to proceed?')
    expect(text).toContain(' touch permissao-fixture.txt')
  })

  it('devolve só as últimas n linhas', async () => {
    const term = new Terminal({ cols: 20, rows: 10, allowProposedApi: true })
    await write(term, 'a\r\nb\r\nc\r\nd')
    expect(readStyledTail(term, 2)).toEqual([[{ t: 'c' }], [{ t: 'd' }]])
    term.dispose()
  })
})

describe('ScreenTailFeed', () => {
  let screens: Map<string, TailSnapshot>
  let sent: Array<{ subscriber: number; update: ScreenTailUpdate }>
  let reads: string[]
  let feed: ScreenTailFeed

  const snap = (text: string): TailSnapshot => ({
    lines: [[{ t: text }]],
    hasMenu: false,
    inputDirty: false,
  })

  beforeEach(() => {
    vi.useFakeTimers()
    screens = new Map([
      ['a', snap('a1')],
      ['b', snap('b1')],
    ])
    sent = []
    reads = []
    feed = new ScreenTailFeed({
      read: async (id) => {
        reads.push(id)
        return screens.get(id) ?? null
      },
      send: (subscriber, update) => sent.push({ subscriber, update }),
      throttleMs: 400,
      cap: 3,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('empurra a tela atual assim que o cartão assina', async () => {
    feed.subscribe(1, ['a'])
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([{ subscriber: 1, update: { sessionId: 'a', ...snap('a1') } }])
  })

  it('só lê sessões assinadas: saída de quem não está aberto/visível não custa nada', async () => {
    feed.subscribe(1, ['a'])
    await vi.advanceTimersByTimeAsync(0)
    feed.onData('b')
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toEqual(['a'])
  })

  it('throttle: uma rajada de saída vira no máximo uma leitura a cada 400ms', async () => {
    feed.subscribe(1, ['a'])
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) {
      screens.set('a', snap(`a${i + 2}`))
      feed.onData('a')
      await vi.advanceTimersByTimeAsync(50)
    }
    // 1000ms de rajada depois da 1ª leitura: leituras em ~400 e ~800.
    expect(reads.length).toBe(3)
    await vi.advanceTimersByTimeAsync(400)
    expect(sent.at(-1)!.update.lines).toEqual([[{ t: 'a21' }]])
  })

  it('não reenvia quando a tela não mudou', async () => {
    feed.subscribe(1, ['a'])
    await vi.advanceTimersByTimeAsync(0)
    feed.onData('a')
    await vi.advanceTimersByTimeAsync(400)
    expect(reads.length).toBe(2)
    expect(sent.length).toBe(1)
  })

  it('cap de assinaturas por janela', () => {
    feed.subscribe(1, ['a', 'b', 'c', 'd', 'e'])
    expect(feed.subscribedCount(1)).toBe(3)
  })

  it('a lista nova substitui a anterior; quem volta recebe a tela de novo', async () => {
    feed.subscribe(1, ['a'])
    await vi.advanceTimersByTimeAsync(0)
    feed.subscribe(1, ['b'])
    await vi.advanceTimersByTimeAsync(400)
    feed.onData('a')
    await vi.advanceTimersByTimeAsync(400)
    expect(reads).toEqual(['a', 'b'])
    feed.subscribe(1, ['a', 'b'])
    await vi.advanceTimersByTimeAsync(400)
    expect(sent.map((s) => s.update.sessionId)).toEqual(['a', 'b', 'a'])
  })

  it('janela fechada solta as assinaturas', async () => {
    feed.subscribe(1, ['a'])
    await vi.advanceTimersByTimeAsync(0)
    feed.drop(1)
    feed.onData('a')
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toEqual(['a'])
  })

  it('cada janela recebe a sua cópia, uma leitura só', async () => {
    feed.subscribe(1, ['a'])
    feed.subscribe(2, ['a'])
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toEqual(['a'])
    expect(sent.map((s) => s.subscriber).sort()).toEqual([1, 2])
  })
})
