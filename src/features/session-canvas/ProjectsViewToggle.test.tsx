import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
}))

import { ProjectsViewToggle } from './ProjectsViewToggle'
import { useProjectsViewStore } from './projects-view-store'
import { useAppStore } from '@/store/appStore'

describe('ProjectsViewToggle', () => {
  beforeEach(() => {
    localStorage.clear()
    useProjectsViewStore.setState({ view: 'terminals', scopeMode: 'all' })
    useAppStore.setState({ area: 'projects' })
  })

  it('clicar em Mapa troca a vista e lembra a escolha', () => {
    render(<ProjectsViewToggle />)
    fireEvent.click(screen.getByTestId('projects-view-map'))
    expect(useProjectsViewStore.getState().view).toBe('map')
    expect(JSON.parse(localStorage.getItem('cm:projects-view')!)).toMatchObject({ view: 'map' })
  })

  it('Ctrl+Shift+G alterna só com a área Projetos na frente', () => {
    render(<ProjectsViewToggle />)
    fireEvent.keyDown(window, { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true })
    expect(useProjectsViewStore.getState().view).toBe('map')

    useAppStore.setState({ area: 'design' })
    fireEvent.keyDown(window, { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true })
    expect(useProjectsViewStore.getState().view).toBe('map')
  })
})
