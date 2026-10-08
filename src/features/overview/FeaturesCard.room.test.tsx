import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Feature, OverviewFeatureActivity } from '../../../shared/types/ipc'

// "Abrir Room" nos cards da Home: ação secundária, o clique principal não muda.
const list = vi.fn()
vi.mock('@/lib/ipc', () => ({
  featuresApi: { list: () => list(), onUpdated: vi.fn(() => () => {}) },
  loopApi: { snapshot: () => Promise.resolve(null), onUpdated: vi.fn(() => () => {}) },
}))
const select = vi.fn()
vi.mock('@/store/featuresStore', () => ({
  useFeaturesStore: Object.assign(() => undefined, { getState: () => ({ select }) }),
}))

const { FeaturesCard } = await import('./FeaturesCard')
const { useFeatureRoomStore } = await import('@/features/feature-room/feature-room-store')
const { useAppStore } = await import('@/store/appStore')

const pinned = {
  id: 'a',
  title: 'Extração TRF4',
  status: 'in-progress',
  pinned: true,
  updatedAt: 1,
  archivedAt: null,
}
const activity: OverviewFeatureActivity = {
  id: 'x1',
  title: 'Frente por atividade',
  status: 'in-progress',
  projectId: 'p1',
  lastSessionAt: null,
  sessionCount: 2,
  objectiveLinkCount: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({ area: 'overview' })
  useFeatureRoomStore.setState({ featureId: null })
})

describe('FeaturesCard → Room', () => {
  it('linha de atividade: "Abrir Room" abre a Room daquela feature', async () => {
    list.mockResolvedValue([])
    render(<FeaturesCard features={[activity]} />)
    fireEvent.click(await screen.findByTestId('home-feature-open-room'))
    expect(useAppStore.getState().area).toBe('room')
    expect(useFeatureRoomStore.getState().featureId).toBe('x1')
  })

  it('linha em foco: o botão abre a Room e o clique na linha segue indo para Features', async () => {
    list.mockResolvedValue([pinned as unknown as Feature])
    render(<FeaturesCard features={[activity]} />)
    await screen.findByTestId('home-pinned-feature')
    fireEvent.click(screen.getByTestId('home-feature-open-room'))
    expect(useAppStore.getState().area).toBe('room')
    expect(useFeatureRoomStore.getState().featureId).toBe('a')
    expect(select).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('home-pinned-feature'))
    expect(select).toHaveBeenCalledWith('a')
    expect(useAppStore.getState().area).toBe('features')
  })
})
