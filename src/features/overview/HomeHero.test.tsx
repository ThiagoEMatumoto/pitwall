import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Handoff, LiveSessionInfo, OverviewCounts } from '../../../shared/types/ipc'

vi.mock('@/lib/ipc', () => ({ sessionsApi: {}, handoffsApi: {} }))

const { HomeHero } = await import('./HomeHero')
const { SessionsCard } = await import('./SessionsCard')
const { useAppStore } = await import('@/store/appStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')

function live(id: string, status: LiveSessionInfo['status']): LiveSessionInfo {
  return {
    id,
    ccSessionId: `cc-${id}`,
    name: id,
    title: null,
    status,
    repo: null,
    projectName: null,
    projectIcon: null,
    projectColor: null,
    lastActivityAt: 1,
    lastText: null,
  }
}

afterEach(cleanup)

describe('Home — hero e "Sessões agora" contam o mesmo conjunto', () => {
  it('filha de handoff esperando (vive no Crew Dock) não vira "1 no box" com o card vazio', () => {
    useAppStore.setState({ liveSessions: [live('kid', 'waiting')], panes: [] })
    useHandoffsStore.setState({
      handoffs: [
        { id: 'h1', status: 'running', childSessionId: 'kid', dismissedAt: null } as Handoff,
      ],
    })
    render(
      <>
        <HomeHero counts={{} as OverviewCounts} onRefresh={() => {}} />
        <SessionsCard />
      </>,
    )
    expect(screen.getByText('no box').parentElement?.textContent).toContain('0 no box')
    expect(screen.getByText('Nenhuma sessão viva.')).toBeInTheDocument()
  })

  it('sessão comum esperando aparece nos dois', () => {
    useAppStore.setState({ liveSessions: [live('main', 'waiting')], panes: [] })
    useHandoffsStore.setState({ handoffs: [] })
    render(
      <>
        <HomeHero counts={{} as OverviewCounts} onRefresh={() => {}} />
        <SessionsCard />
      </>,
    )
    expect(screen.getByText('no box').parentElement?.textContent).toContain('1 no box')
    expect(screen.queryByText('Nenhuma sessão viva.')).toBeNull()
  })
})
