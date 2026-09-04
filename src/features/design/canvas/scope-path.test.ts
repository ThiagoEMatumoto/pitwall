import { describe, expect, it } from 'vitest'
import { crumbTarget, nodePath, scopeAfterSelect } from './scope-path'

// root > section > card > title
const parents: Record<string, string | null> = {
  root: null,
  section: 'root',
  card: 'section',
  title: 'card',
  aside: 'root',
}
const parentOf = (id: string): string | null => parents[id] ?? null
const ancestorsOf = (id: string): string[] => nodePath(id, parentOf).slice(0, -1)

describe('nodePath', () => {
  it('runs from the root down to the node', () => {
    expect(nodePath('title', parentOf)).toEqual(['root', 'section', 'card', 'title'])
    expect(nodePath('root', parentOf)).toEqual(['root'])
  })
})

describe('crumbTarget', () => {
  const path = ['root', 'section', 'card', 'title']

  it('scopes to the crumb parent, and to nothing on the root crumb', () => {
    expect(crumbTarget(path, 0)).toEqual({ nodeId: null, scopeId: null })
    expect(crumbTarget(path, 1)).toEqual({ nodeId: 'section', scopeId: null })
    expect(crumbTarget(path, 3)).toEqual({ nodeId: 'title', scopeId: 'card' })
  })
})

describe('scopeAfterSelect', () => {
  it('keeps the scope while the selection stays inside it', () => {
    expect(scopeAfterSelect('section', ['card'], ancestorsOf)).toBe('section')
    expect(scopeAfterSelect('section', ['card', 'title'], ancestorsOf)).toBe('section')
  })

  it('drops the scope for a selection outside it, or for the scope itself', () => {
    expect(scopeAfterSelect('section', ['aside'], ancestorsOf)).toBeNull()
    expect(scopeAfterSelect('section', ['card', 'aside'], ancestorsOf)).toBeNull()
    expect(scopeAfterSelect('section', ['section'], ancestorsOf)).toBeNull()
  })

  it('leaves the scope alone when nothing is selected', () => {
    expect(scopeAfterSelect('section', [], ancestorsOf)).toBe('section')
  })
})
