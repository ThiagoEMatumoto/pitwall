// jsdom has no layout: rects are stubbed per element where the test needs
// them, animations end when the test says so.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignNode } from '../../../shared/types/design'
import { applyOp, renderBody } from './dom'
import { allRects, hitTest } from './hit'
import { marqueeKey, mount, onScroll, replay, setMotionMode, visibleIds } from './motion'
import { viewTransitionPairs } from './motion-navigate'

if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    value: { escape: (s: string) => s },
  })
}

function node(id: string, over: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    tag: 'div',
    kind: 'frame',
    style: {},
    attrs: {},
    children: [],
    ...over,
  }
}

const entrance = (over: Partial<NonNullable<DesignNode['motion']>['entrance']> = {}) => ({
  entrance: {
    preset: 'fade' as const,
    trigger: 'load' as const,
    duration: 220,
    delay: 0,
    easing: 'ease-out' as const,
    ...over,
  },
})

function tree(): DesignNode {
  return node('root', {
    children: [
      node('hero', { motion: entrance() }),
      node('below', { motion: entrance({ trigger: 'in-view' }) }),
      node('list', {
        motion: entrance({ preset: 'slide-up', stagger: 60 }),
        children: [node('c0'), node('c1'), node('c2')],
      }),
      node('ticker', {
        motion: { loop: { preset: 'marquee', duration: 1800 } },
        children: [node('t0', { tag: 'span', text: 'a' }), node('t1', { tag: 'span', text: 'b' })],
      }),
    ],
  })
}

const el = (id: string): HTMLElement => document.querySelector(`[data-pw-id="${id}"]`)!
const flushFrames = () => new Promise((r) => setTimeout(r, 40))

function stubRect(target: HTMLElement, y: number, h: number): void {
  target.getBoundingClientRect = () =>
    ({
      x: 0,
      y,
      top: y,
      left: 0,
      width: 100,
      height: h,
      bottom: y + h,
      right: 100,
    }) as DOMRect
}

function endAnimation(target: HTMLElement): void {
  target.dispatchEvent(new Event('animationend', { bubbles: true }))
}

beforeEach(() => {
  document.documentElement.setAttribute('data-pw-motion', 'final')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('visibleIds', () => {
  const rects = {
    top: { x: 0, y: 0, w: 10, h: 100 },
    edge: { x: 0, y: 880, w: 10, h: 100 },
    far: { x: 0, y: 3000, w: 10, h: 100 },
    thin: { x: 0, y: 500, w: 10, h: 0 },
  }

  it('keeps what shows at least a fifth of its height in the band', () => {
    expect(visibleIds(rects, 0, 900)).toEqual(['top', 'edge', 'thin'])
    // Only 10px of 100 visible: below the threshold.
    expect(visibleIds({ edge: { x: 0, y: 890, w: 10, h: 100 } }, 0, 900)).toEqual([])
    expect(visibleIds(rects, 2950, 900)).toEqual(['far'])
  })

  it('measures a rect taller than the viewport against the viewport', () => {
    expect(visibleIds({ tall: { x: 0, y: -4000, w: 10, h: 9000 } }, 0, 900)).toEqual(['tall'])
  })
})

describe('entrance state machine', () => {
  it('off: everything lands done and the document stays frozen', () => {
    renderBody(tree())
    mount('off')
    expect(el('hero').classList.contains('pw-m-done')).toBe(true)
    expect(el('below').classList.contains('pw-m-done')).toBe(true)
    expect(el('c1').classList.contains('pw-m-done')).toBe(true)
    expect(document.documentElement.getAttribute('data-pw-motion')).toBe('final')
  })

  it('on: load plays on the next frame, in-view waits for a scroll, done after animationend', async () => {
    renderBody(tree())
    mount('on')
    expect(document.documentElement.hasAttribute('data-pw-motion')).toBe(false)
    expect(el('hero').classList.contains('pw-m-play')).toBe(false)
    await flushFrames()
    expect(el('hero').classList.contains('pw-m-play')).toBe(true)
    expect(el('below').className).toBe('')
    stubRect(el('below'), 2000, 300)
    onScroll(0, 900)
    await flushFrames()
    expect(el('below').className).toBe('')
    onScroll(1500, 900)
    await flushFrames()
    expect(el('below').classList.contains('pw-m-play')).toBe(true)
    endAnimation(el('below'))
    expect(el('below').classList.contains('pw-m-done')).toBe(true)
    expect(el('below').classList.contains('pw-m-play')).toBe(false)
  })

  it('replay restarts done entrances, all or by id', async () => {
    renderBody(tree())
    mount('on')
    await flushFrames()
    endAnimation(el('hero'))
    endAnimation(el('c0'))
    expect(el('hero').classList.contains('pw-m-done')).toBe(true)
    replay(['hero'])
    expect(el('hero').className).toBe('')
    expect(el('c0').classList.contains('pw-m-done')).toBe(true)
    await flushFrames()
    expect(el('hero').classList.contains('pw-m-play')).toBe(true)
    replay()
    await flushFrames()
    expect(el('c0').classList.contains('pw-m-play')).toBe(true)
    expect(el('c0').classList.contains('pw-m-done')).toBe(false)
  })

  it('setMotionMode with the same mode does not replay', async () => {
    renderBody(tree())
    mount('on')
    await flushFrames()
    endAnimation(el('hero'))
    setMotionMode('on')
    expect(el('hero').classList.contains('pw-m-done')).toBe(true)
    setMotionMode('off')
    expect(document.documentElement.getAttribute('data-pw-motion')).toBe('final')
  })
})

describe('stagger', () => {
  it('renders the parent entrance on the children with their index and stagger', () => {
    renderBody(tree())
    mount('off')
    expect(el('list').hasAttribute('data-pw-m-in')).toBe(false)
    expect(el('list').getAttribute('data-pw-m-stagger')).toBe('60')
    expect(el('c2').getAttribute('data-pw-m-in')).toBe('slide-up')
    expect(el('c2').style.getPropertyValue('--pw-i')).toBe('2')
    expect(el('c2').style.getPropertyValue('--pw-stagger')).toBe('60ms')
  })

  it('setMotion on the parent re-derives the children; insert keeps the numbering', () => {
    renderBody(tree())
    mount('off')
    applyOp({ type: 'setMotion', id: 'list', motion: null })
    expect(el('list').hasAttribute('data-pw-m-stagger')).toBe(false)
    expect(el('c0').hasAttribute('data-pw-m-in')).toBe(false)
    expect(el('c0').style.getPropertyValue('--pw-i')).toBe('')
    applyOp({
      type: 'setMotion',
      id: 'list',
      motion: entrance({ stagger: 100 }),
    })
    expect(el('c1').style.getPropertyValue('--pw-stagger')).toBe('100ms')
    expect(el('c1').classList.contains('pw-m-done')).toBe(true)
    applyOp({
      type: 'insert',
      parentId: 'list',
      index: 0,
      node: node('c-new'),
    })
    expect(el('c-new').style.getPropertyValue('--pw-i')).toBe('0')
    expect(el('c0').style.getPropertyValue('--pw-i')).toBe('1')
    expect(el('c2').style.getPropertyValue('--pw-i')).toBe('3')
  })
})

describe('marquee clones', () => {
  it('exist only while motion is on, carry data-pw-clone and no id', () => {
    renderBody(tree())
    mount('off')
    expect(el('ticker').children.length).toBe(2)
    mount('on')
    const kids = Array.from(el('ticker').children)
    expect(kids.length).toBe(4)
    expect(kids[2].hasAttribute('data-pw-clone')).toBe(true)
    expect(kids[2].hasAttribute('data-pw-id')).toBe(false)
    expect(kids[2].getAttribute('aria-hidden')).toBe('true')
    expect(el('ticker').style.getPropertyValue('--pw-marquee-w')).toBe('0px')
    expect(Object.keys(allRects())).toEqual([
      'root',
      'hero',
      'below',
      'list',
      'c0',
      'c1',
      'c2',
      'ticker',
      't0',
      't1',
    ])
    mount('off')
    expect(el('ticker').children.length).toBe(2)
  })

  it('rebuilds the clones when an original changes and hit-test skips them', () => {
    renderBody(tree())
    mount('on')
    const before = marqueeKey(el('ticker'))
    applyOp({ type: 'setText', id: 't0', text: 'changed' })
    expect(marqueeKey(el('ticker'))).not.toBe(before)
    setMotionMode('off')
    setMotionMode('on')
    const clones = Array.from(el('ticker').children).filter((c) => c.hasAttribute('data-pw-clone'))
    expect(clones[0].textContent).toBe('changed')
    // jsdom has no elementsFromPoint: the clone's text comes first, as a
    // real pointer over the scrolled copy would report.
    document.elementsFromPoint = () => [clones[0], el('ticker')]
    expect(hitTest(0, 0, []).id).toBe('ticker')
  })
})

describe('viewTransitionPairs', () => {
  it('pairs names unique on both sides and drops duplicates', () => {
    const from = node('r', {
      children: [
        node('h1', { name: 'Header' }),
        node('x', { name: 'Card' }),
        node('y', { name: 'Card' }),
        node('z', { name: 'Only here' }),
      ],
    })
    const to = node('r2', {
      children: [node('h2', { name: 'header' }), node('c', { name: 'Card' })],
    })
    const pairs = viewTransitionPairs(from, to)
    expect([...pairs.from]).toEqual([['h1', 'pw-header']])
    expect([...pairs.to]).toEqual([['h2', 'pw-header']])
  })
})
