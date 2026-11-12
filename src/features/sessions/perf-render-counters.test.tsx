import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../shared/types/chat'

// A sonda REAL, ligada: a flag é lida na carga do módulo, então window.api tem de
// existir antes dos imports. O jsdom não tem PerformanceObserver nem ResizeObserver.
const { transcript } = vi.hoisted(() => {
  ;(window as unknown as { api: unknown }).api = { perf: { enabled: true, report: () => {} } }
  const NoopObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.PerformanceObserver = NoopObserver as unknown as typeof PerformanceObserver
  globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver
  return { transcript: { messages: [] as ChatMessage[] } }
})

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    {
      get: (_t, key: string) =>
        key.startsWith('on') ? () => () => {} : () => Promise.resolve(null),
    },
  )
  // vi.mock confere as chaves exportadas: lista explícita das apis que estes componentes tocam.
  return Object.fromEntries(
    ['sessionsApi', 'chatApi', 'shellApi', 'prefsApi', 'fsApi', 'voiceApi', 'attentionApi'].map(
      (k) => [k, inert],
    ),
  )
})
vi.mock('./chat/useChatTranscript', () => ({
  useChatTranscript: () => ({
    messages: transcript.messages,
    loading: false,
    transcriptExists: true,
    lastPlanFilePath: null,
  }),
  usePlanFile: () => null,
}))
vi.mock('@/features/quick-composer/quick-composer-store', () => ({ useSendTargets: () => [] }))
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '0' } }))

import { startPerfProbe } from '@/lib/perf-probe'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { ChatView } from './chat/ChatView'
import { Composer } from './Composer'
import { parseChatMessages } from '../../../electron/main/services/chat-transcript'
import { buildLongMotherLines } from '../../../electron/main/services/__fixtures__/long-mother-jsonl'

startPerfProbe()
const renders = (name: string) => window.__cmPerf!.counters[name] ?? 0

beforeEach(() => {
  transcript.messages = []
})

describe('contadores de render da sonda', () => {
  it('MarkdownViewer conta um por render', () => {
    const before = renders('MarkdownViewer')
    const view = render(<MarkdownViewer content="um" />)
    expect(renders('MarkdownViewer')).toBe(before + 1)
    view.rerender(<MarkdownViewer content="dois" />)
    expect(renders('MarkdownViewer')).toBe(before + 2)
  })

  it('ChatView conta os próprios renders e os do markdown das mensagens', () => {
    transcript.messages = parseChatMessages(buildLongMotherLines(2).join('\n'))
    const chat = renders('ChatView')
    const markdown = renders('MarkdownViewer')
    const view = render(<ChatView sessionId="s1" status="idle" />)
    const mounted = renders('ChatView')
    expect(mounted).toBeGreaterThan(chat)
    expect(renders('MarkdownViewer')).toBeGreaterThan(markdown)
    view.rerender(<ChatView sessionId="s1" status="working" />)
    expect(renders('ChatView')).toBeGreaterThan(mounted)
  })

  it('Composer conta um por render', () => {
    const before = renders('Composer')
    const view = render(<Composer sessionId="s1" onSend={vi.fn()} onInsert={vi.fn()} />)
    const mounted = renders('Composer')
    expect(mounted).toBeGreaterThan(before)
    view.rerender(<Composer sessionId="s1" onSend={vi.fn()} onInsert={vi.fn()} compact />)
    expect(renders('Composer')).toBeGreaterThan(mounted)
  })
})
