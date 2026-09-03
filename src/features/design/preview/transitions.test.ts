import { describe, expect, it } from 'vitest'
import type { DesignNode } from '@shared/types/design'
import {
  TRANSITION_DURATION_MS,
  backHistory,
  canGoBack,
  canGoForward,
  createHistory,
  createNavState,
  currentId,
  forwardHistory,
  previewNavReducer,
  pushHistory,
  siblingArtboard,
  vtNames,
} from './transitions'

describe('history', () => {
  it('pushes, goes back and forward, and drops forward entries on a new push', () => {
    let h = createHistory('a')
    expect(currentId(h)).toBe('a')
    expect(canGoBack(h)).toBe(false)

    h = pushHistory(h, 'b')
    h = pushHistory(h, 'c')
    expect(h.entries).toEqual(['a', 'b', 'c'])

    h = backHistory(h)
    expect(currentId(h)).toBe('b')
    expect(canGoForward(h)).toBe(true)

    h = pushHistory(h, 'd')
    expect(h.entries).toEqual(['a', 'b', 'd'])
    expect(canGoForward(h)).toBe(false)

    h = forwardHistory(h)
    expect(currentId(h)).toBe('d')
  })

  it('pushing the current artboard again is a no-op', () => {
    const h = createHistory('a')
    expect(pushHistory(h, 'a')).toBe(h)
  })

  it('back at the start is a no-op', () => {
    const h = createHistory('a')
    expect(backHistory(h)).toBe(h)
  })
})

describe('siblingArtboard', () => {
  const order = ['home', 'menu', 'contact']
  it('steps in page order without wrapping', () => {
    expect(siblingArtboard(order, 'home', 1)).toBe('menu')
    expect(siblingArtboard(order, 'menu', -1)).toBe('home')
    expect(siblingArtboard(order, 'contact', 1)).toBeNull()
    expect(siblingArtboard(order, 'home', -1)).toBeNull()
    expect(siblingArtboard(order, 'ghost', 1)).toBeNull()
  })
})

describe('previewNavReducer', () => {
  it('navigate with a transition records it with the default duration; settle clears it', () => {
    let s = createNavState('home')
    s = previewNavReducer(s, {
      type: 'navigate',
      to: 'menu',
      transition: 'push',
    })
    expect(currentId(s.history)).toBe('menu')
    expect(s.transition).toEqual({
      from: 'home',
      to: 'menu',
      kind: 'push',
      direction: 'forward',
      duration: TRANSITION_DURATION_MS.push,
    })
    s = previewNavReducer(s, { type: 'settle' })
    expect(s.transition).toBeNull()
  })

  it('navigate keeps the link duration and easing', () => {
    const s = previewNavReducer(createNavState('home'), {
      type: 'navigate',
      to: 'menu',
      transition: 'smart',
      duration: 500,
      easing: 'spring-gentle',
    })
    expect(s.transition).toEqual({
      from: 'home',
      to: 'menu',
      kind: 'smart',
      direction: 'forward',
      duration: 500,
      easing: 'spring-gentle',
    })
  })

  it('navigate with none has no transition', () => {
    const s = previewNavReducer(createNavState('home'), {
      type: 'navigate',
      to: 'menu',
      transition: 'none',
    })
    expect(currentId(s.history)).toBe('menu')
    expect(s.transition).toBeNull()
  })

  it('back plays a push in reverse; forward replays it', () => {
    let s = createNavState('home')
    s = previewNavReducer(s, {
      type: 'navigate',
      to: 'menu',
      transition: 'fade',
    })
    s = previewNavReducer(s, { type: 'back' })
    expect(currentId(s.history)).toBe('home')
    expect(s.transition).toEqual({
      from: 'menu',
      to: 'home',
      kind: 'push',
      direction: 'back',
      duration: TRANSITION_DURATION_MS.push,
    })
    s = previewNavReducer(s, { type: 'forward' })
    expect(currentId(s.history)).toBe('menu')
    expect(s.transition?.direction).toBe('forward')
  })

  it('back with no history returns the same state', () => {
    const s = createNavState('home')
    expect(previewNavReducer(s, { type: 'back' })).toBe(s)
  })

  it('jump moves without animating and to the same id is a no-op', () => {
    const s0 = createNavState('home')
    const s1 = previewNavReducer(s0, { type: 'jump', to: 'menu' })
    expect(currentId(s1.history)).toBe('menu')
    expect(s1.transition).toBeNull()
    expect(previewNavReducer(s1, { type: 'jump', to: 'menu' })).toBe(s1)
  })
})

function node(id: string, name: string | undefined, children: DesignNode[] = []): DesignNode {
  const n: DesignNode = {
    id,
    tag: 'div',
    kind: 'frame',
    style: {},
    attrs: {},
    children,
  }
  return name === undefined ? n : { ...n, name }
}

describe('vtNames', () => {
  it('returns names present once on both sides, in origin order', () => {
    const from = node('r', 'Root', [
      node('a', 'Hero Title'),
      node('b', 'Card'),
      node('c', 'Only here'),
      node('d', undefined),
    ])
    const to = node('r2', 'Root', [node('x', 'Card'), node('y', 'hero title'), node('z', 'New')])
    expect(vtNames(from, to)).toEqual(['pw-root', 'pw-hero-title', 'pw-card'])
  })

  it('drops names duplicated on either side, including slug collisions', () => {
    const from = node('r', undefined, [
      node('a', 'Item'),
      node('b', 'Item'),
      node('c', 'Badge'),
      node('d', 'Logo'),
      node('e', 'Price Tag'),
    ])
    const to = node('r2', undefined, [
      node('x', 'Item'),
      node('y', 'Badge'),
      node('z', 'Badge'),
      node('w', 'Logo'),
      node('v', 'price-tag'),
      node('u', 'Price  Tag!'),
    ])
    expect(vtNames(from, to)).toEqual(['pw-logo'])
  })

  it('ignores names that slug to nothing', () => {
    expect(
      vtNames(node('r', '***', [node('a', 'ok')]), node('r2', '***', [node('b', 'ok')])),
    ).toEqual(['pw-ok'])
  })
})
