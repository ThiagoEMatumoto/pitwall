import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingLiveState } from '../../../shared/types/ipc'

const meeting: Meeting = {
  id: 'm1',
  title: 'Reunião',
  status: 'recording',
  startedAt: Date.now() - 5_000,
  endedAt: null,
  rawNotes: '',
  summaryMd: null,
  themLabel: 'Participante',
  error: null,
  sttModel: null,
  summaryModel: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  segmentCount: 0,
  durationMs: 0,
}

const base: MeetingLiveState = {
  active: null,
  elapsedMs: 0,
  levels: { me: 0, them: 0 },
  sttOk: true,
  lastError: null,
  captureMode: 'pipewire',
  detection: null,
  linkedStreamId: null,
}

const mockApi = vi.hoisted(() => ({
  state: vi.fn(),
  onEvent: vi.fn(() => () => {}),
}))
vi.mock('@/lib/ipc', () => ({ meetingsApi: mockApi }))
vi.mock('@/lib/nav', () => ({ navigateToMeeting: vi.fn() }))

const { RecordingPill } = await import('./RecordingPill')
const { useMeetingsStore } = await import('@/store/meetingsStore')

describe('RecordingPill', () => {
  beforeEach(() => {
    useMeetingsStore.getState().stopEventWatch()
    useMeetingsStore.setState({ live: null })
  })

  it('mostra "Gravando" com o tempo quando há gravação ativa', async () => {
    mockApi.state.mockResolvedValue({ ...base, active: meeting, elapsedMs: 5_000 })
    render(<RecordingPill />)
    const pill = await screen.findByRole('button', { name: /Gravando 00:0\d/ })
    expect(pill).toHaveAttribute('title', 'Clique para abrir · Ctrl+Shift+R para parar')
    expect(mockApi.onEvent).toHaveBeenCalled()
  })

  it('não renderiza nada sem gravação', async () => {
    mockApi.state.mockResolvedValue(base)
    const { container } = render(<RecordingPill />)
    await vi.waitFor(() => expect(mockApi.state).toHaveBeenCalled())
    expect(screen.queryByText(/Gravando/)).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })
})
