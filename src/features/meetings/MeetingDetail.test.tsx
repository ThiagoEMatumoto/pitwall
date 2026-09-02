import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingDetail as Detail, MeetingSetupStatus } from '../../../shared/types/ipc'

const api = vi.hoisted(() => ({
  meetingsApi: {
    renameSpeaker: vi.fn(),
    downloadModels: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(() => () => {}),
  },
  prefsApi: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('@/lib/ipc', () => api)

const storeState = vi.hoisted(() => ({
  detail: null as unknown,
  live: null as unknown,
  setup: null as unknown,
  rename: vi.fn(),
  setThemLabel: vi.fn(),
  updateNotes: vi.fn(),
  resummarize: vi.fn(),
  decideActionItems: vi.fn(),
  loadDetail: vi.fn().mockResolvedValue(undefined),
  checkSetup: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/store/meetingsStore', () => {
  const useMeetingsStore = (selector: (s: typeof storeState) => unknown) => selector(storeState)
  useMeetingsStore.getState = () => storeState
  return { useMeetingsStore }
})
vi.mock('./ActionItemsList', () => ({ ActionItemsList: () => null }))
vi.mock('./NotesEditor', () => ({ NotesEditor: () => null }))

const { MeetingDetail } = await import('./MeetingDetail')

function meeting(partial: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    title: 'Kickoff',
    status: 'done',
    startedAt: Date.UTC(2026, 8, 2, 12, 0),
    endedAt: null,
    rawNotes: '',
    summaryMd: '## Resumo\nok',
    themLabel: 'Participante',
    error: null,
    sttModel: null,
    summaryModel: 'sonnet',
    createdAt: 0,
    updatedAt: 0,
    segmentCount: 0,
    durationMs: 60_000,
    speakers: [],
    lastError: null,
    respawns: 0,
    micLevelDbfs: null,
    diarization: 'on',
    ...partial,
  }
}

function setup(partial: Partial<MeetingSetupStatus['diarization']> = {}): MeetingSetupStatus {
  return {
    pipewire: true,
    sink: null,
    source: null,
    stt: { ok: true, url: null, error: null },
    micLevel: { dbfs: null, source: null, low: false },
    diarization: {
      supported: true,
      addon: true,
      models: { segmentation: 'ready', embedding: 'ready', progress: null },
      ...partial,
    },
  }
}

function detailOf(m: Meeting): Detail {
  return { meeting: m, segments: [], actionItems: [] }
}

describe('MeetingDetail › Participantes', () => {
  beforeEach(() => {
    api.meetingsApi.renameSpeaker.mockReset()
    api.meetingsApi.downloadModels.mockClear()
    storeState.loadDetail.mockClear()
    storeState.live = null
    storeState.setup = setup()
  })

  it('lista speakers com turnos, badge de voz salva e renomeia inline via meetingsApi', async () => {
    const m = meeting({
      speakers: [
        {
          id: 's1',
          meetingId: 'm1',
          label: 'Bianca',
          voiceId: 'v1',
          turnCount: 3,
        },
        {
          id: 's2',
          meetingId: 'm1',
          label: 'Participante 2',
          voiceId: null,
          turnCount: 1,
        },
      ],
    })
    storeState.detail = detailOf(m)
    api.meetingsApi.renameSpeaker.mockResolvedValue(m)
    render(<MeetingDetail activeElapsedMs={0} />)

    expect(screen.getByRole('heading', { name: 'Participantes' })).toBeInTheDocument()
    expect(screen.getByText('3 turnos')).toBeInTheDocument()
    expect(screen.getByText('1 turno')).toBeInTheDocument()
    expect(screen.getAllByText('voz salva')).toHaveLength(1)
    expect(screen.getByText('Vozes identificadas automaticamente')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Participante 2' }))
    const input = screen.getByRole('textbox', {
      name: 'Renomear Participante 2',
    })
    fireEvent.change(input, { target: { value: 'Pedro' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.meetingsApi.renameSpeaker).toHaveBeenCalledWith({
      meetingId: 'm1',
      speakerId: 's2',
      name: 'Pedro',
    })
    await vi.waitFor(() => expect(storeState.loadDetail).toHaveBeenCalledWith('m1'))
  })

  it('diarização indisponível mostra o aviso curto', () => {
    storeState.setup = setup({ supported: false, addon: false })
    storeState.detail = detailOf(meeting({ diarization: 'unavailable' }))
    render(<MeetingDetail activeElapsedMs={0} />)
    expect(screen.getByText('Diarização indisponível nesta plataforma')).toBeInTheDocument()
  })

  it('modelo de embedding ausente → botão de download que chama meetingsApi.downloadModels', () => {
    storeState.setup = setup({
      models: { segmentation: 'ready', embedding: 'missing', progress: null },
    })
    storeState.detail = detailOf(meeting({ diarization: 'unavailable' }))
    render(<MeetingDetail activeElapsedMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /Baixar modelo \(39 MB\)/ }))
    expect(api.meetingsApi.downloadModels).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Baixando modelo de voz… 0 %/)).toBeInTheDocument()
  })

  it('download em andamento no setup mostra a porcentagem', () => {
    storeState.setup = setup({
      models: {
        segmentation: 'ready',
        embedding: 'downloading',
        progress: 0.42,
      },
    })
    storeState.detail = detailOf(meeting())
    render(<MeetingDetail activeElapsedMs={0} />)
    expect(screen.getByText('Baixando modelo de voz… 42 %')).toBeInTheDocument()
  })

  it('gravando usa o status ao vivo', () => {
    storeState.live = { diarization: 'loading' }
    storeState.detail = detailOf(meeting({ status: 'recording', diarization: null }))
    render(<MeetingDetail activeElapsedMs={1000} />)
    expect(screen.getByText('Carregando modelo de voz…')).toBeInTheDocument()
    expect(screen.getByText('Nenhuma voz identificada ainda.')).toBeInTheDocument()
  })
})
