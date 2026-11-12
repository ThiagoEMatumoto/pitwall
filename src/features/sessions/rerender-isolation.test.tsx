import { useMemo, useRef, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A sonda REAL, ligada: a flag é lida na carga do módulo, então window.api tem de
// existir antes dos imports. O jsdom não tem PerformanceObserver; o ResizeObserver
// daqui entrega uma pane larga, senão o rodapé manda o microfone para o "⋯".
const { voiceApi } = vi.hoisted(() => {
  ;(window as unknown as { api: unknown }).api = { perf: { enabled: true, report: () => {} } }
  globalThis.PerformanceObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof PerformanceObserver
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb(
        [{ contentRect: { width: 1000 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  return {
    voiceApi: {
      transcribe: vi.fn(),
      condense: vi.fn(),
      summarizeNow: vi.fn(),
      autoSummaryGet: vi.fn(),
      autoSummarySet: vi.fn(),
    },
  }
})

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    {
      get: (_t, key: string) =>
        key.startsWith('on') ? () => () => {} : () => Promise.resolve(null),
    },
  )
  return {
    ...Object.fromEntries(
      ['sessionsApi', 'chatApi', 'shellApi', 'prefsApi', 'fsApi', 'attentionApi'].map((k) => [
        k,
        inert,
      ]),
    ),
    voiceApi,
  }
})
vi.mock('./chat/useChatTranscript', () => ({
  useChatTranscript: () => ({
    messages: [],
    loading: false,
    transcriptExists: true,
    lastPlanFilePath: null,
  }),
  usePlanFile: () => null,
}))
vi.mock('@/features/quick-composer/quick-composer-store', () => ({ useSendTargets: () => [] }))
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '0' } }))

import { startPerfProbe } from '@/lib/perf-probe'
import { useStableCallback } from '@/lib/use-stable-callback'
import { ChatView } from './chat/ChatView'
import { Composer, type ComposerHandle } from './Composer'
import { ComposerToolbar } from './ComposerToolbar'
import { useAutoSummary } from './voice/useAutoSummary'
import { useSummarizeNow } from './voice/useSummarizeNow'
import { useVoiceRecorder } from './voice/useVoiceRecorder'

startPerfProbe()
const renders = (name: string) => window.__cmPerf!.counters[name] ?? 0

// O gravador do browser: só o que o useVoiceRecorder toca.
class FakeRecorder {
  static last: FakeRecorder | null = null
  mimeType = 'audio/webm'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(public stream: MediaStream) {
    FakeRecorder.last = this
  }
  static isTypeSupported() {
    return true
  }
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(['audio']) })
    this.onstop?.()
  }
}

// O Blob do jsdom não lê os próprios bytes; o conteúdo do áudio não importa aqui.
Blob.prototype.arrayBuffer ??= async () => new ArrayBuffer(0)

const NO_PENDING = {}

// O mesmo arranjo do TerminalHost: os três controles de voz moram no dono da pane e
// descem pelo slot `toolbar` de um Composer em memo.
function Pane() {
  const [, setTick] = useState(0)
  const composerRef = useRef<ComposerHandle>(null)
  const dictation = useVoiceRecorder((text) => composerRef.current?.appendText(text))
  const summarize = useSummarizeNow('cc-1')
  const autoSummary = useAutoSummary('cc-1')
  const send = useStableCallback(async () => {})
  const noop = useStableCallback(() => {})
  const toolbar = useMemo(
    () => (
      <ComposerToolbar
        activity={null}
        canSwitch
        pending={NO_PENDING}
        activeEffort={null}
        xhighCapable={false}
        ultracodeActive={false}
        currentMode={null}
        onSelectModel={noop}
        onSelectEffort={noop}
        voice={dictation}
        summarize={summarize}
        autoSummary={autoSummary}
      />
    ),
    [noop, dictation, summarize, autoSummary],
  )
  return (
    <>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        re-render do pai
      </button>
      <Composer ref={composerRef} sessionId="s1" onSend={send} onInsert={send} toolbar={toolbar} />
    </>
  )
}

const rerenderParent = () => fireEvent.click(screen.getByText('re-render do pai'))

beforeEach(() => {
  voiceApi.transcribe.mockReset()
  voiceApi.summarizeNow.mockReset()
  voiceApi.autoSummaryGet.mockReset().mockResolvedValue(false)
  voiceApi.autoSummarySet.mockReset().mockResolvedValue(undefined)
  FakeRecorder.last = null
  globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
  })
})

describe('re-render do pai com as mesmas props', () => {
  it('ChatView não renderiza de novo', () => {
    const view = render(<ChatView sessionId="s1" status="idle" />)
    const mounted = renders('ChatView')
    view.rerender(<ChatView sessionId="s1" status="idle" />)
    expect(renders('ChatView')).toBe(mounted)
    view.rerender(<ChatView sessionId="s1" status="working" />)
    expect(renders('ChatView')).toBeGreaterThan(mounted)
  })

  it('Composer não renderiza de novo, nem com os controles de voz no rodapé', async () => {
    render(<Pane />)
    await screen.findByRole('button', { name: 'Resumo auto', pressed: false })
    const mounted = renders('Composer')
    rerenderParent()
    rerenderParent()
    expect(renders('Composer')).toBe(mounted)
  })
})

describe('controles de voz atrás do Composer em memo', () => {
  it('o ditado alternado depois de um re-render do pai enxerga o estado novo', async () => {
    voiceApi.transcribe.mockResolvedValue({ ok: true, text: 'texto ditado' })
    const clock = vi.spyOn(Date, 'now')
    render(<Pane />)
    rerenderParent()

    clock.mockReturnValue(1_000)
    fireEvent.click(screen.getByRole('button', { name: 'Voz' }))
    const recording = await screen.findByRole('button', { name: 'Gravando…' })

    rerenderParent()
    clock.mockReturnValue(3_000)
    fireEvent.click(recording)

    await waitFor(() => expect(voiceApi.transcribe).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('texto ditado'))
    expect(await screen.findByRole('button', { name: 'Voz' })).toBeEnabled()
    clock.mockRestore()
  })

  it('o resumo em voo aparece e um segundo pedido não duplica', async () => {
    let finish: (res: { ok: true }) => void = () => {}
    voiceApi.summarizeNow.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    render(<Pane />)
    rerenderParent()

    fireEvent.click(screen.getByRole('button', { name: 'Resumir' }))
    expect(await screen.findByRole('button', { name: 'Resumindo…' })).toBeDisabled()
    expect(voiceApi.summarizeNow).toHaveBeenCalledTimes(1)

    await act(async () => finish({ ok: true }))
    fireEvent.click(await screen.findByRole('button', { name: 'Resumir' }))
    expect(voiceApi.summarizeNow).toHaveBeenCalledTimes(2)
  })

  it('o resumo automático liga e depois desliga', async () => {
    render(<Pane />)
    rerenderParent()

    fireEvent.click(await screen.findByRole('button', { name: 'Resumo auto', pressed: false }))
    expect(voiceApi.autoSummarySet).toHaveBeenLastCalledWith('cc-1', true)

    rerenderParent()
    fireEvent.click(screen.getByRole('button', { name: 'Resumo auto', pressed: true }))
    expect(voiceApi.autoSummarySet).toHaveBeenLastCalledWith('cc-1', false)
  })
})
