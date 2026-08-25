// O contrato central do rework: o áudio NUNCA toca sozinho. O chip só exibe o
// resumo que chega por voice:summary; a fala é sob demanda (▶) e o ⏹ para.
// Audio/URL.createObjectURL não existem no jsdom — stubs mínimos aqui.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceSummaryEvent } from '@shared/types/ipc'

vi.mock('@/lib/ipc', () => ({
  voiceApi: {
    onSummary: vi.fn(),
    tts: vi.fn(),
    configStatus: vi.fn(),
  },
}))

import { voiceApi } from '@/lib/ipc'
import { stopSpeaking } from './useVoiceSpeaker'
import { SummaryChip } from './SummaryChip'

class FakeAudio {
  static instances: FakeAudio[] = []
  src: string
  playbackRate = 1
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn().mockResolvedValue(undefined)
  pause = vi.fn()
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }
}

// Handler registrado pelo chip — o teste emite eventos por ele.
let emitSummary: (event: VoiceSummaryEvent) => void

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal('Audio', FakeAudio)
  URL.createObjectURL = vi.fn(() => 'blob:fake')
  URL.revokeObjectURL = vi.fn()
  vi.mocked(voiceApi.onSummary).mockImplementation((handler) => {
    emitSummary = handler
    return () => {}
  })
  vi.mocked(voiceApi.tts).mockResolvedValue({
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'audio/mpeg',
  })
  vi.mocked(voiceApi.configStatus).mockResolvedValue({
    ok: false,
    path: '/dev/null',
    error: 'sem config no teste',
  })
})

afterEach(() => {
  // O speaker é singleton de módulo — cada teste começa em repouso.
  stopSpeaking()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('SummaryChip', () => {
  it('resumo chegando NÃO toca sozinho: nada de TTS nem Audio', async () => {
    render(<SummaryChip ccSessionId="s1" />)
    act(() =>
      emitSummary({
        ccSessionId: 's1',
        summary: 'Claude terminou o refactor.',
      }),
    )

    expect(await screen.findByText('Claude terminou o refactor.')).toBeInTheDocument()
    expect(screen.getByTitle('Ouvir o resumo')).toBeInTheDocument()
    expect(voiceApi.tts).not.toHaveBeenCalled()
    expect(FakeAudio.instances).toHaveLength(0)
  })

  it('resumo de OUTRA sessão não aparece', () => {
    render(<SummaryChip ccSessionId="s1" />)
    act(() => emitSummary({ ccSessionId: 's2', summary: 'resumo alheio' }))

    expect(screen.queryByText('resumo alheio')).not.toBeInTheDocument()
  })

  it('▶ toca sob demanda e ⏹ para a reprodução', async () => {
    render(<SummaryChip ccSessionId="s1" />)
    act(() => emitSummary({ ccSessionId: 's1', summary: 'Resumo tocável.' }))

    fireEvent.click(screen.getByTitle('Ouvir o resumo'))

    await waitFor(() => expect(voiceApi.tts).toHaveBeenCalledWith('Resumo tocável.'))
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
    const audio = FakeAudio.instances[0]
    expect(audio.play).toHaveBeenCalledTimes(1)

    // Tocando, o ▶ dá lugar ao ⏹ — e parar pausa o MESMO Audio.
    const stop = await screen.findByTitle('Parar o áudio')
    fireEvent.click(stop)
    expect(audio.pause).toHaveBeenCalledTimes(1)
    expect(await screen.findByTitle('Ouvir o resumo')).toBeInTheDocument()
    // O texto continua visível — parar o áudio não dispensa o resumo.
    expect(screen.getByText('Resumo tocável.')).toBeInTheDocument()
  })

  it('dispensar (X) esconde o chip', async () => {
    render(<SummaryChip ccSessionId="s1" />)
    act(() => emitSummary({ ccSessionId: 's1', summary: 'Resumo dispensável.' }))

    fireEvent.click(await screen.findByTitle('Dispensar o resumo'))
    expect(screen.queryByText('Resumo dispensável.')).not.toBeInTheDocument()
  })

  // Áudio órfão: qualquer caminho que esconda o chip (ou troque o texto) para a
  // reprodução — áudio nunca continua sem um ⏹ visível que corresponda a ele.
  it('dispensar (X) com áudio tocando também PARA o áudio', async () => {
    render(<SummaryChip ccSessionId="s1" />)
    act(() => emitSummary({ ccSessionId: 's1', summary: 'Resumo falante.' }))
    fireEvent.click(screen.getByTitle('Ouvir o resumo'))
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))

    fireEvent.click(screen.getByTitle('Dispensar o resumo'))

    expect(FakeAudio.instances[0].pause).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Resumo falante.')).not.toBeInTheDocument()
  })

  it('resumo NOVO chegando com áudio antigo tocando para o áudio antigo', async () => {
    render(<SummaryChip ccSessionId="s1" />)
    act(() => emitSummary({ ccSessionId: 's1', summary: 'Resumo antigo.' }))
    fireEvent.click(screen.getByTitle('Ouvir o resumo'))
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))

    act(() => emitSummary({ ccSessionId: 's1', summary: 'Resumo novo.' }))

    expect(FakeAudio.instances[0].pause).toHaveBeenCalledTimes(1)
    // O texto novo aparece parado (▶) — nada toca sem o usuário pedir de novo.
    expect(await screen.findByText('Resumo novo.')).toBeInTheDocument()
    expect(screen.getByTitle('Ouvir o resumo')).toBeInTheDocument()
  })

  it('trocar de sessão (ccSessionId) limpa o chip E para o áudio', async () => {
    const { rerender } = render(<SummaryChip ccSessionId="s1" />)
    act(() => emitSummary({ ccSessionId: 's1', summary: 'Resumo da s1.' }))
    fireEvent.click(screen.getByTitle('Ouvir o resumo'))
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))

    rerender(<SummaryChip ccSessionId="s2" />)

    expect(FakeAudio.instances[0].pause).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Resumo da s1.')).not.toBeInTheDocument()
  })
})
