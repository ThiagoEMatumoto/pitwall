import { describe, expect, it } from 'vitest'
import { resolveClickTarget, resolveDiveTarget } from './interaction-state'

// root > section > card > title
const path = ['root', 'section', 'card', 'title']

describe('resolveClickTarget', () => {
  it('lands on the top-level child without scope and on the deepest with deep', () => {
    expect(resolveClickTarget(path, null, false)).toBe('section')
    expect(resolveClickTarget(path, null, true)).toBe('title')
    expect(resolveClickTarget(path, 'section', false)).toBe('card')
  })
})

describe('resolveDiveTarget', () => {
  it('goes one level below the deepest selected ancestor', () => {
    expect(resolveDiveTarget(path, ['section'], null)).toEqual({
      scopeId: 'section',
      nodeId: 'card',
    })
    expect(resolveDiveTarget(path, ['card'], 'section')).toEqual({
      scopeId: 'card',
      nodeId: 'title',
    })
  })

  it('has nowhere deeper to go from the hit node itself', () => {
    expect(resolveDiveTarget(path, ['title'], 'card')).toBeNull()
  })

  it('acts like a plain click when nothing on the path is selected', () => {
    expect(resolveDiveTarget(path, ['other'], null)).toEqual({
      scopeId: 'root',
      nodeId: 'section',
    })
    expect(resolveDiveTarget([], [], null)).toBeNull()
  })
})
