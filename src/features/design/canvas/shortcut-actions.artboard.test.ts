import { describe, expect, it, vi } from 'vitest'
import type { DesignState } from '@/store/designStore'

vi.mock('@/lib/ipc', () => ({ api: { design: {} } }))

const { deleteSelection, duplicateSelection } = await import('./shortcut-actions')

function state(over: Partial<DesignState> = {}): DesignState {
  return {
    selection: { artboardId: 'ab1', nodeIds: [] },
    requestDeleteArtboard: vi.fn(),
    duplicateArtboard: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn(),
    select: vi.fn(),
    ...over,
  } as unknown as DesignState
}

describe('artboard-level shortcuts', () => {
  it('Cmd+D with no node selected duplicates the artboard', () => {
    const s = state()
    duplicateSelection(s)
    expect(s.duplicateArtboard).toHaveBeenCalledWith('ab1')
    expect(s.commit).not.toHaveBeenCalled()
  })

  it('Delete with no node selected only asks; it never deletes straight away', () => {
    const s = state()
    deleteSelection(s)
    expect(s.requestDeleteArtboard).toHaveBeenCalledWith('ab1')
    expect(s.commit).not.toHaveBeenCalled()
  })

  it('does nothing at all when no artboard is selected either', () => {
    const s = state({ selection: { artboardId: null, nodeIds: [] } })
    deleteSelection(s)
    duplicateSelection(s)
    expect(s.requestDeleteArtboard).not.toHaveBeenCalled()
    expect(s.duplicateArtboard).not.toHaveBeenCalled()
  })

  it('leaves the node path alone when nodes are selected', () => {
    const s = state({ selection: { artboardId: 'ab1', nodeIds: ['n1'] } })
    deleteSelection(s)
    duplicateSelection(s)
    expect(s.requestDeleteArtboard).not.toHaveBeenCalled()
    expect(s.duplicateArtboard).not.toHaveBeenCalled()
  })
})
