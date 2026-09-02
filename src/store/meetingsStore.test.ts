import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingDetail, MeetingEvent, MeetingSegment } from '../../shared/types/ipc'

let eventHandler: ((event: MeetingEvent) => void) | null = null

const mockApi = {
  start: vi.fn(),
  stop: vi.fn(),
  state: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  resummarize: vi.fn(),
  actionItem: vi.fn(),
  floating: vi.fn(),
  checkSetup: vi.fn(),
  onEvent: vi.fn((h: (event: MeetingEvent) => void) => {
    eventHandler = h
    return () => {
      eventHandler = null
    }
  }),
}

vi.mock('@/lib/ipc', () => ({ meetingsApi: mockApi }))

const { useMeetingsStore } = await import('./meetingsStore')

function makeMeeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    title: 'Daily',
    status: 'recording',
    startedAt: 1000,
    endedAt: null,
    rawNotes: '',
    summaryMd: null,
    themLabel: 'Participante',
    error: null,
    sttModel: null,
    summaryModel: null,
    createdAt: 1000,
    updatedAt: 1000,
    segmentCount: 0,
    durationMs: 0,
    ...over,
  }
}

function makeSegment(over: Partial<MeetingSegment> = {}): MeetingSegment {
  return {
    id: 's1',
    meetingId: 'm1',
    speaker: 'them',
    text: 'Bom dia',
    startMs: 0,
    endMs: 1200,
    chunkIndex: 0,
    createdAt: 1001,
    ...over,
  }
}

function makeDetail(over: Partial<MeetingDetail> = {}): MeetingDetail {
  return { meeting: makeMeeting(), segments: [], actionItems: [], ...over }
}

describe('meetingsStore events', () => {
  beforeEach(() => {
    useMeetingsStore.getState().stopEventWatch()
    useMeetingsStore.setState({ meetings: [], selectedId: null, detail: null, live: null, error: null })
    eventHandler = null
  })

  it('aplica segment ao detail da reunião selecionada, imutavelmente', () => {
    const detail = makeDetail()
    useMeetingsStore.setState({ selectedId: 'm1', detail })
    useMeetingsStore.getState().startEventWatch()
    expect(eventHandler).not.toBeNull()

    eventHandler?.({ type: 'segment', segment: makeSegment() })

    const next = useMeetingsStore.getState().detail
    expect(next?.segments).toHaveLength(1)
    expect(next?.segments[0].text).toBe('Bom dia')
    expect(next).not.toBe(detail)
    expect(detail.segments).toHaveLength(0)
  })

  it('ignora segment de outra reunião', () => {
    useMeetingsStore.setState({ selectedId: 'm1', detail: makeDetail() })
    useMeetingsStore.getState().startEventWatch()

    eventHandler?.({ type: 'segment', segment: makeSegment({ meetingId: 'm2' }) })

    expect(useMeetingsStore.getState().detail?.segments).toHaveLength(0)
  })

  it('meeting event atualiza lista e detail; state event atualiza live', () => {
    useMeetingsStore.setState({ meetings: [makeMeeting()], selectedId: 'm1', detail: makeDetail() })
    useMeetingsStore.getState().startEventWatch()

    eventHandler?.({ type: 'meeting', meeting: makeMeeting({ status: 'done', summaryMd: '# Resumo' }) })
    const state = useMeetingsStore.getState()
    expect(state.meetings[0].status).toBe('done')
    expect(state.detail?.meeting.summaryMd).toBe('# Resumo')

    eventHandler?.({
      type: 'state',
      state: { active: null, elapsedMs: 0, levels: { me: 0, them: 0 }, sttOk: true, lastError: null, captureMode: 'pipewire' },
    })
    expect(useMeetingsStore.getState().live?.active).toBeNull()
  })

  it('assina onEvent uma única vez (StrictMode-safe)', () => {
    mockApi.onEvent.mockClear()
    useMeetingsStore.getState().startEventWatch()
    useMeetingsStore.getState().startEventWatch()
    expect(mockApi.onEvent).toHaveBeenCalledTimes(1)
  })
})
