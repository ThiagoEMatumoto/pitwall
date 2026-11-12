import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHud } from './AgentHud'
import type { SessionActivity } from '../../../shared/types/ipc'

const START = Date.parse('2026-11-12T12:00:00.000Z')

const activity: SessionActivity = {
  ccSessionId: 'cc-1',
  status: 'working',
  name: null,
  title: null,
  lastText: null,
  lastActivityAt: START - 3_000,
  model: null,
}

describe('AgentHud — tempo relativo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => vi.useRealTimers())

  it('avança sozinho, sem o pai re-renderizar', () => {
    render(<AgentHud activity={activity} />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Trabalhando há 3s')
    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getByRole('status')).toHaveAccessibleName('Trabalhando há 8s')
  })

  it('sem atividade datada não liga o relógio', () => {
    render(<AgentHud activity={{ ...activity, lastActivityAt: null }} />)
    expect(vi.getTimerCount()).toBe(0)
    expect(screen.getByRole('status')).toHaveAccessibleName('Trabalhando')
  })
})
