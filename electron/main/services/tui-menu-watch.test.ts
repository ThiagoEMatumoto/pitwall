import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TuiMenuWatch,
  SCAN_DEBOUNCE_MS,
  RESPOND_LOCK_MS,
  SCAN_MAX_WAIT_MS,
  UNPARSED_STABLE_MS,
  MIRROR_SCROLLBACK,
} from './tui-menu-watch'
import { TAIL_WINDOWS } from '../../../shared/tui/tui-read-window'

const FIXTURES = join(__dirname, '..', '..', '..', 'shared', 'tui', '__fixtures__')
const PERMISSION = readFileSync(join(FIXTURES, 'claude-2.1.286-permission-bash.ansi'), 'utf8')
const TRUST_UNNUMBERED = readFileSync(
  join(FIXTURES, 'claude-2.1.286-trust-unnumbered.ansi'),
  'utf8',
)
const IDLE_PROMPT = readFileSync(join(FIXTURES, 'claude-2.1.286-idle-prompt.ansi'), 'utf8')
// Limpa tela + scrollback e volta ao topo: o que a TUI faz ao trocar de tela.
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

// Stand-in do ptyManager: mesmos eventos (spawn/resize/data/exit) e write().
class FakePty extends EventEmitter {
  writes: string[] = []
  write(_sessionId: string, data: string): void {
    this.writes.push(data)
  }
}

function setup(raw: string) {
  const pty = new FakePty()
  const watch = new TuiMenuWatch()
  watch.attach(pty)
  pty.emit('spawn', { sessionId: 's1', cols: 80, rows: 24 })
  pty.emit('data', { sessionId: 's1', data: raw })
  return { pty, watch }
}

describe('TuiMenuWatch — parse headless no main', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('parseia o prompt de permissão REAL depois do debounce e avisa a mudança', async () => {
    const { watch } = setup(PERMISSION)
    const changed = vi.fn()
    watch.on('change', changed)
    expect(watch.current('s1')?.menu).toBeNull()
    await vi.advanceTimersByTimeAsync(SCAN_DEBOUNCE_MS + 10)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('s1'))
    expect(watch.current('s1')?.menu?.kind).toBe('permission')
  })

  it('não reparseia a cada byte: um só scan por rajada', async () => {
    const pty = new FakePty()
    const watch = new TuiMenuWatch()
    watch.attach(pty)
    pty.emit('spawn', { sessionId: 's1', cols: 80, rows: 24 })
    const spy = vi.spyOn(watch, 'rescan')
    for (const ch of PERMISSION.slice(0, 200)) pty.emit('data', { sessionId: 's1', data: ch })
    await vi.advanceTimersByTimeAsync(SCAN_DEBOUNCE_MS + 10)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('saída contínua (spinner) não adia o scan pra sempre: varre no teto do debounce', async () => {
    const pty = new FakePty()
    const watch = new TuiMenuWatch()
    watch.attach(pty)
    pty.emit('spawn', { sessionId: 's1', cols: 80, rows: 24 })
    const spy = vi.spyOn(watch, 'rescan')
    for (let t = 0; t < SCAN_MAX_WAIT_MS * 2; t += 50) {
      pty.emit('data', { sessionId: 's1', data: '.' })
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('descarta o terminal quando a PTY encerra', async () => {
    const { pty, watch } = setup(PERMISSION)
    await vi.advanceTimersByTimeAsync(SCAN_DEBOUNCE_MS + 10)
    pty.emit('exit', { sessionId: 's1', exitCode: 0, signal: null })
    expect(watch.has('s1')).toBe(false)
    expect(watch.current('s1')).toBeNull()
  })
})

describe('TuiMenuWatch — escopo do espelho', () => {
  it('PTY recusada pelo seletor (shell, dev server) não ganha xterm nem índice', () => {
    const pty = new FakePty()
    const watch = new TuiMenuWatch()
    watch.attach(pty, (id) => (id === 'agent' ? { ccSessionId: 'cc-agent' } : null))
    pty.emit('spawn', { sessionId: 'shell', cols: 80, rows: 24 })
    pty.emit('spawn', { sessionId: 'agent', cols: 80, rows: 24 })
    pty.emit('data', { sessionId: 'shell', data: 'npm run dev\r\n' })
    expect(watch.has('shell')).toBe(false)
    expect(watch.has('agent')).toBe(true)
    expect(watch.ptyForCc('cc-agent')).toBe('agent')
  })

  it('índice cc→pty segue a PTY viva: resume troca, exit da antiga não apaga a nova', () => {
    const pty = new FakePty()
    const watch = new TuiMenuWatch()
    watch.attach(pty, () => ({ ccSessionId: 'cc-1' }))
    pty.emit('spawn', { sessionId: 'old', cols: 80, rows: 24 })
    pty.emit('spawn', { sessionId: 'new', cols: 80, rows: 24 })
    pty.emit('exit', { sessionId: 'old', exitCode: 0, signal: null })
    expect(watch.ptyForCc('cc-1')).toBe('new')
    pty.emit('exit', { sessionId: 'new', exitCode: 0, signal: null })
    expect(watch.ptyForCc('cc-1')).toBeUndefined()
  })
})

describe('TuiMenuWatch — contador attention_reason_unparsed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  // O write() do xterm drena em setTimeout: com relógio falso, avança junto.
  async function rescanNow(watch: TuiMenuWatch) {
    const scan = watch.rescan('s1')
    await vi.advanceTimersByTimeAsync(1)
    return scan
  }

  it('conta waiting com tela não reconhecida estável por 1,5s, uma vez por tela', async () => {
    const { watch } = setup(TRUST_UNNUMBERED)
    await rescanNow(watch)
    watch.noteUnparsed('s1', 'waiting')
    await vi.advanceTimersByTimeAsync(UNPARSED_STABLE_MS - 100)
    expect(watch.counters().attentionReasonUnparsed).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    await vi.waitFor(() => expect(watch.counters().attentionReasonUnparsed).toBe(1))
    watch.noteUnparsed('s1', 'waiting')
    await rescanNow(watch)
    watch.noteUnparsed('s1', 'waiting')
    await vi.advanceTimersByTimeAsync(UNPARSED_STABLE_MS * 2)
    expect(watch.counters().attentionReasonUnparsed).toBe(1)
    expect(watch.counters().lastUnparsedAt).not.toBeNull()
  })

  it('sequência real pós-resposta: menu some, tela transitória em waiting, input box volta → não conta', async () => {
    const { pty, watch } = setup(PERMISSION)
    await rescanNow(watch)
    expect(watch.current('s1')?.menu?.kind).toBe('permission')
    watch.noteUnparsed('s1', 'waiting')
    // Usuário respondeu: o menu sai da tela, o sessions/<pid>.json ainda diz waiting.
    pty.emit('data', { sessionId: 's1', data: CLEAR + TRUST_UNNUMBERED })
    await rescanNow(watch)
    expect(watch.current('s1')?.menu).toBeNull()
    watch.noteUnparsed('s1', 'waiting')
    await vi.advanceTimersByTimeAsync(600)
    pty.emit('data', { sessionId: 's1', data: CLEAR + IDLE_PROMPT })
    await vi.advanceTimersByTimeAsync(SCAN_DEBOUNCE_MS + 10)
    expect(watch.current('s1')?.inputPrompt).toBe(true)
    watch.noteUnparsed('s1', 'waiting')
    await vi.advanceTimersByTimeAsync(UNPARSED_STABLE_MS * 2)
    expect(watch.counters().attentionReasonUnparsed).toBe(0)
  })

  it('status sai de waiting antes de 1,5s: não conta', async () => {
    const { watch } = setup(TRUST_UNNUMBERED)
    await rescanNow(watch)
    watch.noteUnparsed('s1', 'waiting')
    await vi.advanceTimersByTimeAsync(500)
    watch.noteUnparsed('s1', 'working')
    await vi.advanceTimersByTimeAsync(UNPARSED_STABLE_MS * 2)
    expect(watch.counters().attentionReasonUnparsed).toBe(0)
  })

  it('não conta quando o menu foi reconhecido ou o status não é waiting', async () => {
    const { watch } = setup(PERMISSION)
    await rescanNow(watch)
    watch.noteUnparsed('s1', 'waiting')
    const other = setup(TRUST_UNNUMBERED).watch
    await rescanNow(other)
    other.noteUnparsed('s1', 'working')
    await vi.advanceTimersByTimeAsync(UNPARSED_STABLE_MS * 2)
    expect(watch.counters().attentionReasonUnparsed).toBe(0)
    expect(other.counters().attentionReasonUnparsed).toBe(0)
  })
})

describe('TuiMenuWatch.respond — checagem de menu-mudou', () => {
  it('menu igual: digita a tecla da opção escolhida (dígito, sem Enter)', async () => {
    const { pty, watch } = setup(PERMISSION)
    const snap = await watch.snapshot('s1')
    expect(snap).not.toBeNull()
    const res = await watch.respond({
      sessionId: 's1',
      fingerprint: snap!.fingerprint,
      menuSeq: snap!.menuSeq,
      action: { kind: 'select', optionIndex: 3 },
    })
    expect(res).toEqual({ ok: true })
    expect(pty.writes).toEqual(['4'])
  })

  it('menu mudou desde o snapshot: recusa, devolve o menu novo e não digita nada', async () => {
    const { pty, watch } = setup(PERMISSION)
    const snap = await watch.snapshot('s1')
    const res = await watch.respond({
      sessionId: 's1',
      fingerprint: snap!.fingerprint + 'x',
      menuSeq: snap!.menuSeq,
      action: { kind: 'select', optionIndex: 0 },
    })
    expect(res).toMatchObject({ ok: false, error: 'menu-changed' })
    expect(res.ok === false && res.snapshot?.fingerprint).toBe(snap!.fingerprint)
    expect(pty.writes).toEqual([])
  })

  // Captura real: o comando só aparece no context, os labels não o citam. O clique
  // no popover do 'touch' não pode aprovar outro comando que tomou a tela.
  it('outro comando no mesmo prompt de permissão: recusa (menu-changed)', async () => {
    const { watch } = setup(PERMISSION)
    const shown = await watch.snapshot('s1')
    const other = setup(PERMISSION.replaceAll('permissao-fixture.txt', 'deletando-tudo-xx.txt'))
    const res = await other.watch.respond({
      sessionId: 's1',
      fingerprint: shown!.fingerprint,
      menuSeq: shown!.menuSeq,
      action: { kind: 'select', optionIndex: 0 },
    })
    expect(shown!.menu.context).toContain('permissao-fixture.txt')
    expect(res).toMatchObject({ ok: false, error: 'menu-changed' })
    expect(other.pty.writes).toEqual([])
  })

  it('sem menu na tela ou PTY desconhecida: recusa sem digitar', async () => {
    const { pty, watch } = setup(TRUST_UNNUMBERED)
    const noMenu = await watch.respond({
      sessionId: 's1',
      fingerprint: 'qualquer',
      menuSeq: 1,
      action: { kind: 'select', optionIndex: 0 },
    })
    const gone = await watch.respond({
      sessionId: 'nao-existe',
      fingerprint: 'qualquer',
      menuSeq: 1,
      action: { kind: 'select', optionIndex: 0 },
    })
    expect(noMenu).toMatchObject({ ok: false, error: 'no-menu' })
    expect(gone).toMatchObject({ ok: false, error: 'not-running' })
    expect(pty.writes).toEqual([])
  })

  it('opção inexistente: recusa (invalid-action)', async () => {
    const { pty, watch } = setup(PERMISSION)
    const snap = await watch.snapshot('s1')
    const res = await watch.respond({
      sessionId: 's1',
      fingerprint: snap!.fingerprint,
      menuSeq: snap!.menuSeq,
      action: { kind: 'select', optionIndex: 7 },
    })
    expect(res).toMatchObject({ ok: false, error: 'invalid-action' })
    expect(pty.writes).toEqual([])
  })
})

// O fingerprint identifica o CONTEÚDO do menu, não a aparição: o mesmo comando
// retentado gera um prompt idêntico. menuSeq distingue as aparições, e a trava por
// sessão impede que duas respostas (dois popovers, clique duplo) saiam pro mesmo menu.
describe('TuiMenuWatch.respond — menuSeq e trava por sessão', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  async function drain<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(1)
    return p
  }
  async function showScreen(pty: FakePty, watch: TuiMenuWatch, raw: string) {
    pty.emit('data', { sessionId: 's1', data: CLEAR + raw })
    await drain(watch.rescan('s1'))
  }
  function approve(watch: TuiMenuWatch, snap: { fingerprint: string; menuSeq: number }) {
    return watch.respond({
      sessionId: 's1',
      fingerprint: snap.fingerprint,
      menuSeq: snap.menuSeq,
      action: { kind: 'select', optionIndex: 0 },
    })
  }

  it('prompt idêntico repetido (comando retentado): menuSeq antigo é recusado', async () => {
    const { pty, watch } = setup(PERMISSION)
    const first = (await drain(watch.snapshot('s1')))!
    expect(await drain(approve(watch, first))).toEqual({ ok: true })
    // A TUI processa a resposta, roda o comando e pede o MESMO comando de novo.
    await showScreen(pty, watch, IDLE_PROMPT)
    await showScreen(pty, watch, PERMISSION)
    const second = (await drain(watch.snapshot('s1')))!
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.menuSeq).toBeGreaterThan(first.menuSeq)

    const stale = await drain(approve(watch, first))
    expect(stale).toMatchObject({ ok: false, error: 'menu-changed' })
    expect(stale.ok === false && stale.snapshot?.menuSeq).toBe(second.menuSeq)
    expect(pty.writes).toEqual(['1'])
    expect(await drain(approve(watch, second))).toEqual({ ok: true })
    expect(pty.writes).toEqual(['1', '1'])
  })

  it('duas respostas concorrentes ao mesmo menu: a 2ª recebe busy e não digita', async () => {
    const { pty, watch } = setup(PERMISSION)
    const snap = (await drain(watch.snapshot('s1')))!
    const [a, b] = await drain(Promise.all([approve(watch, snap), approve(watch, snap)]))
    expect(a).toEqual({ ok: true })
    expect(b).toMatchObject({ ok: false, error: 'busy' })
    expect(pty.writes).toEqual(['1'])
  })

  it('resposta em voo: o menu ainda na tela recusa com busy até sumir', async () => {
    const { pty, watch } = setup(PERMISSION)
    const snap = (await drain(watch.snapshot('s1')))!
    expect(await drain(approve(watch, snap))).toEqual({ ok: true })
    expect(await drain(approve(watch, snap))).toMatchObject({ ok: false, error: 'busy' })
    await showScreen(pty, watch, IDLE_PROMPT)
    await showScreen(pty, watch, PERMISSION)
    const next = (await drain(watch.snapshot('s1')))!
    expect(await drain(approve(watch, next))).toEqual({ ok: true })
    expect(pty.writes).toEqual(['1', '1'])
  })

  it('trava expira sem o menu sumir: libera, mas o menu vira outra aparição', async () => {
    const { pty, watch } = setup(PERMISSION)
    const snap = (await drain(watch.snapshot('s1')))!
    expect(await drain(approve(watch, snap))).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(RESPOND_LOCK_MS + 10)
    // Não dá pra provar que a tela é a que o usuário viu: exige reler o menu.
    expect(await drain(approve(watch, snap))).toMatchObject({ ok: false, error: 'menu-changed' })
    const fresh = (await drain(watch.snapshot('s1')))!
    expect(fresh.menuSeq).toBeGreaterThan(snap.menuSeq)
    expect(await drain(approve(watch, fresh))).toEqual({ ok: true })
    expect(pty.writes).toEqual(['1', '1'])
  })

  it('resposta recusada (menu mudou) não deixa a trava presa', async () => {
    const { pty, watch } = setup(PERMISSION)
    const snap = (await drain(watch.snapshot('s1')))!
    const bad = await drain(approve(watch, { ...snap, menuSeq: snap.menuSeq + 99 }))
    expect(bad).toMatchObject({ ok: false, error: 'menu-changed' })
    expect(await drain(approve(watch, snap))).toEqual({ ok: true })
    expect(pty.writes).toEqual(['1'])
  })
})

describe('TuiMenuWatch — custo do espelho sempre ligado', () => {
  it('o scrollback guarda só a maior janela que o parser lê', () => {
    expect(MIRROR_SCROLLBACK).toBe(Math.max(...TAIL_WINDOWS))
  })

  it('um menu depois de muita saída continua reconhecido com o scrollback curto', async () => {
    const noise = Array.from({ length: 2000 }, (_, i) => `linha ${i}`).join('\r\n')
    const { watch } = setup(`${noise}\r\n${PERMISSION}`)
    const scan = await watch.rescan('s1')
    expect(scan?.menu?.kind).toBe('permission')
  })
})
