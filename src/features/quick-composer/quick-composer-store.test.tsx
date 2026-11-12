import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

vi.mock('@/lib/ipc', () => ({
  sendToApi: {},
  sessionsApi: {},
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
}))

const liveSessions: LiveSessionInfo[] = []
const panes: Array<{ session: { id: string; ccSessionId: string } }> = []
vi.mock('@/store/appStore', () => ({
  pendingEndSessionIds: () => new Set<string>(),
  useAppStore: (sel: (s: unknown) => unknown) => sel({ liveSessions, panes }),
}))

const { useSendTargets } = await import('./quick-composer-store')
const { useHandoffsStore } = await import('@/store/handoffsStore')

function session(id: string, over: Partial<LiveSessionInfo> = {}): LiveSessionInfo {
  return {
    id,
    ccSessionId: `cc-${id}`,
    name: id,
    title: null,
    status: 'working',
    lastActivityAt: 1,
    repo: null,
    projectName: 'pitwall',
    projectIcon: null,
    projectColor: null,
    ...over,
  } as LiveSessionInfo
}

// Os campos que childSessionIds lê; a cadeia com o handoff do store real está em
// crew.test.ts (backgroundChildrenByMother).
const running = (id: string, childSessionId: string) =>
  ({ id, status: 'running', childSessionId, dismissedAt: null }) as Handoff

beforeEach(() => {
  liveSessions.length = 0
  panes.length = 0
  useHandoffsStore.setState({ handoffs: [] })
})

describe('useSendTargets — para quem dá pra mandar um prompt', () => {
  it('filha viva sem aba (segundo plano) é alvo, junto das visíveis', () => {
    liveSessions.push(session('mae'), session('helena-auth'))
    useHandoffsStore.setState({ handoffs: [running('h1', 'helena-auth')] })

    const { result } = renderHook(() => useSendTargets())
    expect(result.current.map((t) => t.sessionId)).toEqual(['mae', 'helena-auth'])
  })

  it('filha com a aba aberta entra uma vez só; encerrada não entra', () => {
    liveSessions.push(session('mae'), session('helena-auth'), session('velha', { status: 'ended' }))
    panes.push({ session: { id: 'helena-auth', ccSessionId: 'cc-helena-auth' } })
    useHandoffsStore.setState({
      handoffs: [running('h1', 'helena-auth'), running('h2', 'velha')],
    })

    const { result } = renderHook(() => useSendTargets())
    expect(result.current.map((t) => t.sessionId)).toEqual(['mae', 'helena-auth'])
  })
})
