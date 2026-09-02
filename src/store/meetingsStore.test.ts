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
  detection: vi.fn(),
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
      state: { active: null, elapsedMs: 0, levels: { me: 0, them: 0 }, sttOk: true, lastError: null, captureMode: 'pipewire', detection: null, linkedStreamId: null },
    })
    expect(useMeetingsStore.getState().live?.active).toBeNull()
  })

  it('meeting event recording com outra selecionada → seleciona e carrega detail', async () => {
    mockApi.get.mockReset()
    mockApi.get.mockResolvedValue(makeDetail({ meeting: makeMeeting({ id: 'm2', title: 'Detectada' }) }))
    useMeetingsStore.setState({ meetings: [makeMeeting()], selectedId: 'm1', detail: makeDetail() })
    useMeetingsStore.getState().startEventWatch()

    eventHandler?.({ type: 'meeting', meeting: makeMeeting({ id: 'm2', title: 'Detectada', startedAt: 2000 }) })

    expect(useMeetingsStore.getState().selectedId).toBe('m2')
    expect(mockApi.get).toHaveBeenCalledWith('m2')
    await vi.waitFor(() => expect(useMeetingsStore.getState().detail?.meeting.id).toBe('m2'))
    expect(useMeetingsStore.getState().meetings.map((m) => m.id)).toEqual(['m2', 'm1'])
  })

  it('meeting event done de outra reunião não muda a seleção', () => {
    mockApi.get.mockReset()
    useMeetingsStore.setState({ meetings: [makeMeeting()], selectedId: 'm1', detail: makeDetail() })
    useMeetingsStore.getState().startEventWatch()

    eventHandler?.({ type: 'meeting', meeting: makeMeeting({ id: 'm2', status: 'done', startedAt: 2000 }) })

    const state = useMeetingsStore.getState()
    expect(state.selectedId).toBe('m1')
    expect(state.detail?.meeting.id).toBe('m1')
    expect(mockApi.get).not.toHaveBeenCalled()
    expect(state.meetings.map((m) => m.id)).toEqual(['m2', 'm1'])
  })

  it('assina onEvent uma única vez (StrictMode-safe)', () => {
    mockApi.onEvent.mockClear()
    useMeetingsStore.getState().startEventWatch()
    useMeetingsStore.getState().startEventWatch()
    expect(mockApi.onEvent).toHaveBeenCalledTimes(1)
  })
})

describe('meetingsStore decideDetection', () => {
  beforeEach(() => {
    mockApi.detection.mockReset()
    useMeetingsStore.setState({ error: null })
  })

  it('encaminha a decisão para a API', async () => {
    mockApi.detection.mockResolvedValue(undefined)
    await useMeetingsStore.getState().decideDetection('record')
    await useMeetingsStore.getState().decideDetection('ignore')
    expect(mockApi.detection.mock.calls).toEqual([['record'], ['ignore']])
    expect(useMeetingsStore.getState().error).toBeNull()
  })

  it('expõe erro da API sem lançar', async () => {
    mockApi.detection.mockRejectedValue(new Error('sem stream'))
    await useMeetingsStore.getState().decideDetection('record')
    expect(useMeetingsStore.getState().error).toBe('sem stream')
  })
})
