import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatTranscriptUpdate } from '../../../../shared/types/ipc'

type Listener = (u: ChatTranscriptUpdate) => void
const listeners = new Set<Listener>()
// O main mantém UM watcher por sessionId: watch é idempotente e unwatch apaga a
// entrada (chat-transcript-service.ts). Espelhamos isso para que um unwatch
// prematuro corte os broadcasts, como acontece de verdade.
const mainWatches = new Set<string>()

vi.mock('@/lib/ipc', () => ({
  chatApi: {
    watch: vi.fn((id: string) => {
      mainWatches.add(id)
    }),
    unwatch: vi.fn((id: string) => {
      mainWatches.delete(id)
    }),
    getTranscript: vi.fn(() => new Promise(() => {})),
    onTranscriptUpdate: vi.fn((h: Listener) => {
      listeners.add(h)
      return () => listeners.delete(h)
    }),
  },
}))

import { useChatTranscript } from './useChatTranscript'

function emitFromMain(u: ChatTranscriptUpdate) {
  if (!mainWatches.has(u.sessionId)) return
  for (const l of [...listeners]) l(u)
}

function Consumer({ id, testId }: { id: string; testId: string }) {
  const { messages } = useChatTranscript(id)
  return <div data-testid={testId}>{messages.length}</div>
}

describe('useChatTranscript com dois consumidores', () => {
  beforeEach(() => {
    listeners.clear()
    mainWatches.clear()
  })
  afterEach(cleanup)

  it('desmontar um consumidor não congela o outro da mesma sessão', () => {
    const a = render(<Consumer id="s1" testId="a" />)
    render(<Consumer id="s1" testId="b" />)
    a.unmount()

    act(() => {
      emitFromMain({
        sessionId: 's1',
        transcriptExists: true,
        messages: [{ id: 'm1' } as unknown as ChatTranscriptUpdate['messages'][number]],
        lastPlanFilePath: null,
      })
    })

    expect(screen.getByTestId('b').textContent).toBe('1')
  })
})
