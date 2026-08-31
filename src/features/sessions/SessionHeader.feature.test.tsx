import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionFeature } from './useSessionFeature'

const navigateToFeature = vi.fn()
vi.mock('@/lib/nav', () => ({
  navigateToFeature: (id: string) => navigateToFeature(id),
  navigateToObjective: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}))

const { SessionHeader } = await import('./SessionHeader')

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const feature: SessionFeature = {
  id: 'f-42',
  title: 'Extração TRF4',
  liveness: 'quiet',
  lastActivityAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
  issues: [],
}

function renderHeader(over: Partial<Parameters<typeof SessionHeader>[0]> = {}) {
  render(
    <SessionHeader
      projectName="pitwall"
      repoLabel="claude-manager"
      repoPath="/repo"
      displayTitle="sessão"
      nameValue="sessão"
      isNamed
      canRename
      onCommitRename={() => {}}
      exited={false}
      activity={null}
      now={Date.now()}
      claudeNotFound={false}
      exitCode={null}
      error={null}
      mode="terminal"
      onMinimize={() => {}}
      onEndSession={() => {}}
      {...over}
    />,
  )
}

describe('SessionHeader — volta pra feature', () => {
  it('mostra o chip com título + vitalidade e navega pra feature no clique', () => {
    renderHeader({ feature })
    const chip = screen.getByTestId('header-feature-chip')
    expect(chip).toHaveTextContent('Extração TRF4')
    expect(screen.getByTestId('liveness-chip')).toHaveAttribute('data-liveness', 'quiet')

    fireEvent.click(chip)
    expect(navigateToFeature).toHaveBeenCalledWith('f-42')
  })

  it('sessão sem feature não ganha chip', () => {
    renderHeader()
    expect(screen.queryByTestId('header-feature-chip')).not.toBeInTheDocument()
  })
})
