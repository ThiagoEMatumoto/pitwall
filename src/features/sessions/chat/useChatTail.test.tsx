import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatTranscriptTail } from '../../../../shared/types/ipc'

type Listener = (t: ChatTranscriptTail) => void
const listeners = new Set<Listener>()
// Espelha o main: watchTail idempotente, unwatchTail apaga e corta os broadcasts.
const mainTails = new Set<string>()

vi.mock('@/lib/ipc', () => ({
  chatApi: {
    watchTail: vi.fn((id: string) => {
      mainTails.add(id)
    }),
    unwatchTail: vi.fn((id: string) => {
      mainTails.delete(id)
    }),
    onTranscriptTail: vi.fn((h: Listener) => {
      listeners.add(h)
      return () => listeners.delete(h)
    }),
  },
}))

import { chatApi } from '@/lib/ipc'
import { useChatTail } from './useChatTail'

function emitFromMain(t: ChatTranscriptTail) {
  if (!mainTails.has(t.sessionId)) return
  for (const l of [...listeners]) l(t)
}

function Tile({ id, active }: { id: string; active: boolean }) {
  const { messages } = useChatTail(id, active)
  return <div data-testid="tile">{messages.map((m) => ('text' in m ? m.text : m.kind)).join('|')}</div>
}

describe('useChatTail', () => {
  beforeEach(() => {
    listeners.clear()
    mainTails.clear()
    vi.mocked(chatApi.watchTail).mockClear()
    vi.mocked(chatApi.unwatchTail).mockClear()
  })
  afterEach(cleanup)

  it('active true→false→true faz watch, unwatch, watch e mantém a última cauda pausado', () => {
    const r = render(<Tile id="m1" active />)
    expect(chatApi.watchTail).toHaveBeenCalledTimes(1)

    act(() => {
      emitFromMain({ sessionId: 'm1', transcriptExists: true, messages: [{ kind: 'user', text: 'oi mãe' }] })
    })
    expect(screen.getByTestId('tile').textContent).toBe('oi mãe')

    r.rerender(<Tile id="m1" active={false} />)
    expect(chatApi.unwatchTail).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('tile').textContent).toBe('oi mãe')

    r.rerender(<Tile id="m1" active />)
    expect(chatApi.watchTail).toHaveBeenCalledTimes(2)

    r.unmount()
    expect(chatApi.unwatchTail).toHaveBeenCalledTimes(2)
  })

  it('ignora a cauda de outra sessão', () => {
    render(<Tile id="m2" active />)
    mainTails.add('outra')
    act(() => {
      emitFromMain({ sessionId: 'outra', transcriptExists: true, messages: [{ kind: 'user', text: 'x' }] })
    })
    expect(screen.getByTestId('tile').textContent).toBe('')
  })
})
