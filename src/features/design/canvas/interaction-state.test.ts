import { describe, expect, it } from 'vitest'
import { resolveClickTarget, resolveDiveTarget, resolveHoverTarget } from './interaction-state'

// root > section > card > title
const path = ['root', 'section', 'card', 'title']

describe('resolveClickTarget', () => {
  it('lands on the top-level child without scope and on the deepest with deep', () => {
    expect(resolveClickTarget(path, null, false)).toBe('section')
    expect(resolveClickTarget(path, null, true)).toBe('title')
    expect(resolveClickTarget(path, 'section', false)).toBe('card')
  })
})

const rect = (x: number) => ({ x, y: 0, w: 10, h: 10 })
const hit = { path, pathRects: { section: rect(1), card: rect(2), title: rect(3) } }

describe('resolveHoverTarget', () => {
  it('highlights the node the click would take, with its own box', () => {
    expect(resolveHoverTarget(hit, null, false)).toEqual({ nodeId: 'section', rect: rect(1) })
    expect(resolveHoverTarget(hit, 'section', false)).toEqual({ nodeId: 'card', rect: rect(2) })
    expect(resolveHoverTarget(hit, null, true)).toEqual({ nodeId: 'title', rect: rect(3) })
  })

  it('has nothing to highlight without a hit or without a rect for the target', () => {
    expect(resolveHoverTarget({ path: [], pathRects: {} }, null, false)).toBeNull()
    expect(resolveHoverTarget({ path, pathRects: {} }, null, false)).toBeNull()
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
