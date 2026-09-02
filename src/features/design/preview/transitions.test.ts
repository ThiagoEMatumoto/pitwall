import { describe, expect, it } from 'vitest'
import {
  backHistory,
  canGoBack,
  canGoForward,
  createHistory,
  createNavState,
  currentId,
  fitScale,
  forwardHistory,
  frameStyle,
  previewNavReducer,
  pushHistory,
  siblingArtboard,
  type ActiveTransition,
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
  it('navigate with a transition records it; settle clears it', () => {
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
    })
    s = previewNavReducer(s, { type: 'settle' })
    expect(s.transition).toBeNull()
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

describe('frameStyle', () => {
  const push: ActiveTransition = {
    from: 'a',
    to: 'b',
    kind: 'push',
    direction: 'forward',
  }
  const back: ActiveTransition = { ...push, direction: 'back' }
  const fade: ActiveTransition = { ...push, kind: 'fade' }

  it('push forward: incoming enters from the right, outgoing leaves to the left', () => {
    expect(frameStyle(push, 'incoming', 'start', 0.5).transform).toBe('scale(0.5) translateX(100%)')
    expect(frameStyle(push, 'incoming', 'end', 0.5).transform).toBe('scale(0.5) translateX(0%)')
    expect(frameStyle(push, 'outgoing', 'start', 0.5).transform).toBe('scale(0.5) translateX(0%)')
    expect(frameStyle(push, 'outgoing', 'end', 0.5).transform).toBe('scale(0.5) translateX(-100%)')
  })

  it('push back mirrors the direction', () => {
    expect(frameStyle(back, 'incoming', 'start', 1).transform).toBe('scale(1) translateX(-100%)')
    expect(frameStyle(back, 'outgoing', 'end', 1).transform).toBe('scale(1) translateX(100%)')
  })

  it('fade only touches opacity', () => {
    expect(frameStyle(fade, 'incoming', 'start', 1).opacity).toBe(0)
    expect(frameStyle(fade, 'incoming', 'end', 1).opacity).toBe(1)
    expect(frameStyle(fade, 'outgoing', 'end', 1).opacity).toBe(0)
    expect(frameStyle(fade, 'outgoing', 'end', 1).transform).toBe('scale(1)')
  })
})

describe('fitScale', () => {
  it('never upscales and respects padding', () => {
    expect(fitScale({ w: 390, h: 844 }, { w: 1920, h: 1080 }, 'fit')).toBe(1)
    expect(fitScale({ w: 1440, h: 900 }, { w: 720, h: 900 }, 'fit')).toBe(0.5)
    expect(fitScale({ w: 1000, h: 1000 }, { w: 600, h: 1000 }, 'fit', 50)).toBe(0.5)
  })

  it('actual is always 1', () => {
    expect(fitScale({ w: 1440, h: 900 }, { w: 100, h: 100 }, 'actual')).toBe(1)
  })
})

describe('frameStyle transition property', () => {
  const push: ActiveTransition = { from: 'a', to: 'b', kind: 'push', direction: 'forward' }
  it('snaps to the start pose and tweens only towards the end pose', () => {
    expect(frameStyle(push, 'incoming', 'start', 1).transition).toBe('none')
    expect(frameStyle(push, 'incoming', 'end', 1).transition).toContain('transform 280ms')
  })
})
