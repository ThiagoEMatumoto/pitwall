import { create } from 'zustand'
import { meetingsApi } from '@/lib/ipc'
import type {
  Meeting,
  MeetingActionItemDecision,
  MeetingDetail,
  MeetingEvent,
  MeetingLiveState,
  MeetingSetupStatus,
} from '../../shared/types/ipc'

// Dono único da assinatura de onEvent — assinada uma vez (StrictMode-safe),
// mesmo padrão do tasksStore.
let offEvent: (() => void) | null = null
let eventStarted = false

interface MeetingsState {
  meetings: Meeting[]
  selectedId: string | null
  detail: MeetingDetail | null
  live: MeetingLiveState | null
  setup: MeetingSetupStatus | null
  loading: boolean
  error: string | null

  refresh: () => Promise<void>
  select: (id: string | null) => Promise<void>
  loadDetail: (id: string) => Promise<void>
  loadLive: () => Promise<void>
  start: (title?: string) => Promise<void>
  stop: () => Promise<void>
  updateNotes: (id: string, rawNotes: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  setThemLabel: (id: string, label: string) => Promise<void>
  remove: (id: string) => Promise<void>
  resummarize: (id: string) => Promise<void>
  decideActionItem: (id: string, status: MeetingActionItemDecision['status']) => Promise<void>
  toggleFloating: () => Promise<void>
  checkSetup: () => Promise<void>
  clearError: () => void

  startEventWatch: () => void
  stopEventWatch: () => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sortByStart(list: Meeting[]): Meeting[] {
  return [...list].sort((a, b) => b.startedAt - a.startedAt)
}

function withMeeting(state: MeetingsState, meeting: Meeting): Pick<MeetingsState, 'meetings' | 'detail'> {
  const exists = state.meetings.some((m) => m.id === meeting.id)
  const meetings = sortByStart(
    exists ? state.meetings.map((m) => (m.id === meeting.id ? meeting : m)) : [meeting, ...state.meetings],
  )
  const detail =
    state.detail && state.detail.meeting.id === meeting.id ? { ...state.detail, meeting } : state.detail
  return { meetings, detail }
}

export const useMeetingsStore = create<MeetingsState>((set, get) => {
  const attempt = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  }

  const applyEvent = (event: MeetingEvent): void => {
    const state = get()
    switch (event.type) {
      case 'state':
        set({ live: event.state })
        return
      case 'segment': {
        const { detail } = state
        if (!detail || detail.meeting.id !== event.segment.meetingId) return
        if (detail.segments.some((s) => s.id === event.segment.id)) return
        set({ detail: { ...detail, segments: [...detail.segments, event.segment] } })
        return
      }
      case 'meeting':
        set(withMeeting(state, event.meeting))
        return
      case 'action_items': {
        const { detail } = state
        if (!detail || detail.meeting.id !== event.meetingId) return
        set({ detail: { ...detail, actionItems: event.items } })
        return
      }
    }
  }

  return {
    meetings: [],
    selectedId: null,
    detail: null,
    live: null,
    setup: null,
    loading: false,
    error: null,

    refresh: async () => {
      set({ loading: true, error: null })
      try {
        const meetings = await meetingsApi.list()
        set({ meetings: sortByStart(meetings), loading: false })
      } catch (err) {
        set({ loading: false, error: errorMessage(err) })
      }
    },

    select: async (id) => {
      if (id === null) {
        set({ selectedId: null, detail: null })
        return
      }
      set({ selectedId: id, detail: get().detail?.meeting.id === id ? get().detail : null })
      await get().loadDetail(id)
    },

    loadDetail: async (id) =>
      attempt(async () => {
        const detail = await meetingsApi.get(id)
        // O usuário pode ter trocado de reunião enquanto o get() voava.
        if (get().selectedId !== id) return
        set({ detail })
      }),

    loadLive: async () =>
      attempt(async () => {
        set({ live: await meetingsApi.state() })
      }),

    start: async (title) =>
      attempt(async () => {
        const meeting = await meetingsApi.start(title ? { title } : undefined)
        set((s) => ({ ...withMeeting(s, meeting), error: null }))
        await get().select(meeting.id)
      }),

    stop: async () =>
      attempt(async () => {
        const meeting = await meetingsApi.stop()
        set((s) => withMeeting(s, meeting))
      }),

    updateNotes: async (id, rawNotes) =>
      attempt(async () => {
        const meeting = await meetingsApi.update({ id, rawNotes })
        set((s) => withMeeting(s, meeting))
      }),

    rename: async (id, title) =>
      attempt(async () => {
        const meeting = await meetingsApi.update({ id, title })
        set((s) => withMeeting(s, meeting))
      }),

    setThemLabel: async (id, themLabel) =>
      attempt(async () => {
        const meeting = await meetingsApi.update({ id, themLabel })
        set((s) => withMeeting(s, meeting))
      }),

    remove: async (id) =>
      attempt(async () => {
        await meetingsApi.delete(id)
        set((s) => ({
          meetings: s.meetings.filter((m) => m.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
          detail: s.detail?.meeting.id === id ? null : s.detail,
        }))
      }),

    resummarize: async (id) =>
      attempt(async () => {
        const meeting = await meetingsApi.resummarize(id)
        set((s) => withMeeting(s, meeting))
      }),

    decideActionItem: async (id, status) =>
      attempt(async () => {
        const item = await meetingsApi.actionItem({ id, status })
        set((s) => {
          if (!s.detail || s.detail.meeting.id !== item.meetingId) return {}
          return {
            detail: {
              ...s.detail,
              actionItems: s.detail.actionItems.map((a) => (a.id === item.id ? item : a)),
            },
          }
        })
      }),

    toggleFloating: async () =>
      attempt(async () => {
        await meetingsApi.floating('toggle')
      }),

    checkSetup: async () =>
      attempt(async () => {
        set({ setup: await meetingsApi.checkSetup() })
      }),

    clearError: () => set({ error: null }),

    startEventWatch: () => {
      if (eventStarted) return
      eventStarted = true
      offEvent = meetingsApi.onEvent(applyEvent)
    },

    stopEventWatch: () => {
      if (offEvent) {
        offEvent()
        offEvent = null
      }
      eventStarted = false
    },
  }
})
