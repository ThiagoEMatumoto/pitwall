import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FeatureWithActivity } from './feature-activity'

const { FeaturePicker } = await import('./FeaturePicker')

const features = [
  {
    id: 'f1',
    projectId: 'p1',
    slug: 'f1',
    title: 'Frente 1',
    status: 'in-progress',
    objective: null,
    docPath: '/tmp/f1.md',
    synthMode: 'auto',
    model: null,
    repos: [],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    pinned: false,
    focusRank: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
  } as unknown as FeatureWithActivity,
]

const containers: HTMLElement[] = []

// A âncora real é o wrapper `relative` do consumidor; em jsdom todo rect é zero,
// então o container do render é quem finge a medida.
function renderWithAnchorWidth(width: number) {
  const container = document.createElement('div')
  container.getBoundingClientRect = () =>
    ({ width, height: 30, left: 100, right: 100 + width, top: 400, bottom: 430 }) as DOMRect
  document.body.appendChild(container)
  containers.push(container)
  render(
    <FeaturePicker features={features} value={null} onPick={() => {}} onClose={() => {}} />,
    { container },
  )
  return screen.getByTestId('feature-picker')
}

afterEach(() => {
  for (const c of containers.splice(0)) c.remove()
})

describe('FeaturePicker — largura casa com a âncora', () => {
  it('assume a largura do campo quando a âncora é larga', () => {
    expect(renderWithAnchorWidth(448).style.width).toBe('448px')
  })

  it('respeita o piso quando a âncora é um botão de ícone (header)', () => {
    expect(renderWithAnchorWidth(40).style.width).toBe('288px')
  })

  it('não passa do teto em âncora esticada', () => {
    expect(renderWithAnchorWidth(1200).style.width).toBe('480px')
  })
})
