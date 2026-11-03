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
