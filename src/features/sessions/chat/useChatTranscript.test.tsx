import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscript, ChatTranscriptUpdate } from '../../../../shared/types/ipc'

type Listener = (u: ChatTranscriptUpdate) => void
const listeners = new Set<Listener>()
// O main mantém UMA entrada por sessionId e só manda o update ao webContents que a
// observa; quando o último inscrito da janela sai, ela é liberada
// (chat-transcript-service.ts). Espelhamos isso para que um unwatch prematuro corte os
// updates, como acontece de verdade.
const mainWatches = new Set<string>()
// Cada chat:get-transcript fica pendente até o teste responder, como um invoke de verdade.
const reads: Array<(t: ChatTranscript) => void> = []

vi.mock('@/lib/ipc', () => ({
  chatApi: {
    watch: vi.fn((id: string) => {
      mainWatches.add(id)
    }),
    unwatch: vi.fn((id: string) => {
      mainWatches.delete(id)
    }),
    getTranscript: vi.fn(() => new Promise<ChatTranscript>((resolve) => reads.push(resolve))),
    readPlanFile: vi.fn(),
    onTranscriptUpdate: vi.fn((h: Listener) => {
      listeners.add(h)
      return () => listeners.delete(h)
    }),
  },
}))

import { chatApi } from '@/lib/ipc'
import { PLAN_FILE_POLL_MS, usePlanFile, useChatTranscript } from './useChatTranscript'

function emitFromMain(u: ChatTranscriptUpdate) {
  if (!mainWatches.has(u.sessionId)) return
  for (const l of [...listeners]) l(u)
}

const msg = (text: string): ChatMessage => ({ kind: 'user', text })
// O payload que o serviço emite: delta a partir de `base`, no rev `rev`.
const update = (rev: number, base: number, messages: ChatMessage[]): ChatTranscriptUpdate => ({
  sessionId: 's1',
  transcriptExists: true,
  base,
  rev,
  messages,
  lastPlanFilePath: null,
})
const snapshot = (rev: number, messages: ChatMessage[]): ChatTranscript => ({
  sessionId: 's1',
  ccSessionId: 'cc-1',
  path: '/p/cc-1.jsonl',
  mtimeMs: 1,
  messages,
  lastPlanFilePath: null,
  rev,
})

const seen = new Map<string, ChatMessage[]>()
function Consumer({ id, testId }: { id: string; testId: string }) {
  const { messages, loading } = useChatTranscript(id)
  seen.set(testId, messages)
  return (
    <div data-testid={testId} data-loading={String(loading)}>
      {messages.map((m) => (m.kind === 'user' ? m.text : m.kind)).join(',')}
    </div>
  )
}
const shown = (testId: string) => screen.getByTestId(testId).textContent

describe('useChatTranscript', () => {
  beforeEach(() => {
    listeners.clear()
    mainWatches.clear()
    reads.length = 0
    seen.clear()
    vi.mocked(chatApi.getTranscript).mockClear()
  })
  afterEach(cleanup)

  it('desmontar um consumidor não congela o outro da mesma sessão', () => {
    const a = render(<Consumer id="s1" testId="a" />)
    render(<Consumer id="s1" testId="b" />)
    a.unmount()

    act(() => emitFromMain(update(1, 0, [msg('m1')])))

    expect(shown('b')).toBe('m1')
  })

  it('dois consumidores da mesma sessão seguem sincronizados delta a delta', () => {
    render(<Consumer id="s1" testId="a" />)
    render(<Consumer id="s1" testId="b" />)

    act(() => emitFromMain(update(1, 0, [msg('m1'), msg('m2')])))
    act(() => emitFromMain(update(2, 2, [msg('m3')])))
    act(() => emitFromMain(update(3, 2, [msg('m3 editada'), msg('m4')])))

    expect(shown('a')).toBe('m1,m2,m3 editada,m4')
    expect(shown('b')).toBe('m1,m2,m3 editada,m4')
  })

  it('o delta mantém os objetos abaixo de base', () => {
    render(<Consumer id="s1" testId="a" />)
    act(() => emitFromMain(update(1, 0, [msg('m1'), msg('m2')])))
    const before = seen.get('a')!

    act(() => emitFromMain(update(2, 1, [msg('m2 editada'), msg('m3')])))

    const after = seen.get('a')!
    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(shown('a')).toBe('m1,m2 editada,m3')
  })

  it('rev antigo não altera o estado', () => {
    render(<Consumer id="s1" testId="a" />)
    act(() => emitFromMain(update(2, 0, [msg('m1'), msg('m2')])))

    act(() => emitFromMain(update(1, 0, [msg('velha')])))
    act(() => emitFromMain(update(2, 1, [msg('repetida')])))

    expect(shown('a')).toBe('m1,m2')
    expect(chatApi.getTranscript).toHaveBeenCalledTimes(1)
  })

  it('rev pulado dispara um getTranscript, e o snapshot repõe a lista', async () => {
    render(<Consumer id="s1" testId="a" />)
    act(() => emitFromMain(update(1, 0, [msg('m1')])))
    // O read inicial respondeu no mesmo rev: nada a trocar.
    await act(async () => reads[0](snapshot(1, [msg('m1')])))
    expect(chatApi.getTranscript).toHaveBeenCalledTimes(1)

    act(() => emitFromMain(update(3, 2, [msg('m3')])))

    expect(chatApi.getTranscript).toHaveBeenCalledTimes(2)
    expect(shown('a')).toBe('m1')
    await act(async () => reads[1](snapshot(3, [msg('m1'), msg('m2'), msg('m3')])))
    expect(shown('a')).toBe('m1,m2,m3')
  })

  it('updates que chegam durante o resync entram depois do snapshot, sem outro getTranscript', async () => {
    render(<Consumer id="s1" testId="a" />)
    act(() => emitFromMain(update(1, 0, [msg('m1')])))
    await act(async () => reads[0](snapshot(1, [msg('m1')])))

    act(() => emitFromMain(update(3, 2, [msg('m3')])))
    act(() => emitFromMain(update(4, 3, [msg('m4')])))
    expect(chatApi.getTranscript).toHaveBeenCalledTimes(2)
    await act(async () => reads[1](snapshot(3, [msg('m1'), msg('m2'), msg('m3')])))

    expect(shown('a')).toBe('m1,m2,m3,m4')
    expect(chatApi.getTranscript).toHaveBeenCalledTimes(2)
  })

  it('snapshot do mesmo rev que o update já aplicado não troca a lista', async () => {
    render(<Consumer id="s1" testId="a" />)
    act(() => emitFromMain(update(1, 0, [msg('m1')])))
    const before = seen.get('a')

    await act(async () => reads[0](snapshot(1, [msg('m1')])))

    expect(seen.get('a')).toBe(before)
  })

  it('snapshot mais velho que o update já aplicado é descartado', async () => {
    render(<Consumer id="s1" testId="a" />)
    act(() => emitFromMain(update(1, 0, [msg('m1')])))
    act(() => emitFromMain(update(2, 1, [msg('m2')])))

    await act(async () => reads[0](snapshot(1, [msg('m1')])))

    expect(shown('a')).toBe('m1,m2')
  })

  it('snapshot mais novo substitui, e o update seguinte emenda nele', async () => {
    render(<Consumer id="s1" testId="a" />)
    expect(screen.getByTestId('a').dataset.loading).toBe('true')

    await act(async () => reads[0](snapshot(4, [msg('m1'), msg('m2')])))
    expect(shown('a')).toBe('m1,m2')
    expect(screen.getByTestId('a').dataset.loading).toBe('false')

    act(() => emitFromMain(update(4, 0, [msg('reemissão do mesmo rev')])))
    act(() => emitFromMain(update(5, 2, [msg('m3')])))
    expect(shown('a')).toBe('m1,m2,m3')
  })

  it('sessão que o main não observa (rev 0): o snapshot entra e encerra o loading', async () => {
    render(<Consumer id="s1" testId="a" />)
    await act(async () => reads[0]({ ...snapshot(0, []), path: null }))
    expect(screen.getByTestId('a').dataset.loading).toBe('false')
    expect(shown('a')).toBe('')
  })
})

function PlanConsumer({ path }: { path: string | null }) {
  return <div data-testid="plan">{usePlanFile(path, 'fp') ?? 'null'}</div>
}

describe('usePlanFile', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('relê o arquivo editado com o diálogo aberto (Ctrl+G), sem o menu mudar', async () => {
    const read = vi.mocked(chatApi.readPlanFile)
    read.mockResolvedValueOnce('plano antigo').mockResolvedValue('plano editado')
    render(<PlanConsumer path="/p/plan.md" />)
    await act(async () => {})
    expect(screen.getByTestId('plan').textContent).toBe('plano antigo')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAN_FILE_POLL_MS)
    })
    expect(screen.getByTestId('plan').textContent).toBe('plano editado')
  })

  it('sem path não lê nem agenda releitura', async () => {
    const read = vi.mocked(chatApi.readPlanFile)
    read.mockClear()
    render(<PlanConsumer path={null} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAN_FILE_POLL_MS * 3)
    })
    expect(read).not.toHaveBeenCalled()
    expect(screen.getByTestId('plan').textContent).toBe('null')
  })
})
