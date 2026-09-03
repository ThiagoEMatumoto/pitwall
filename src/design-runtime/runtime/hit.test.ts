// jsdom has no layout: the body's sizes and the viewport are stubbed, the
// frame callback runs at once. What is under test is which measure a flow
// artboard reports and when it stays quiet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyBodySize } from './dom'
import { resetChangeTracking, scheduleChanges } from './hit'

function stubBody(sizes: { offsetHeight: number; scrollHeight: number }): void {
  Object.defineProperty(document.body, 'offsetHeight', {
    configurable: true,
    get: () => sizes.offsetHeight,
  })
  Object.defineProperty(document.body, 'scrollHeight', {
    configurable: true,
    get: () => sizes.scrollHeight,
  })
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => sizes.scrollHeight,
  })
}

function stubViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h })
}

describe('contentSize', () => {
  const posted: Array<{ type: string; w?: number; h?: number }> = []

  beforeEach(() => {
    posted.length = 0
    vi.spyOn(window.parent, 'postMessage').mockImplementation((msg: unknown) => {
      posted.push(msg as { type: string })
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    stubViewport(1440, 600)
    resetChangeTracking()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const sizes = () => posted.filter((m) => m.type === 'contentSize').map((m) => m.h)

  it('flow reports the body layout box, fixed the scroll size', () => {
    stubBody({ offsetHeight: 300, scrollHeight: 600 })
    applyBodySize({ sizing: 'flow' })
    scheduleChanges()
    expect(sizes()).toEqual([300])

    resetChangeTracking()
    applyBodySize({ sizing: 'fixed' })
    scheduleChanges()
    expect(sizes()).toEqual([300, 600])
  })

  it('flow stays quiet on the height-only resize that echoes its own report', () => {
    const body = { offsetHeight: 800, scrollHeight: 800 }
    stubBody(body)
    applyBodySize({ sizing: 'flow' })
    scheduleChanges()
    expect(sizes()).toEqual([800])

    // The parent applied 800; with vh content the body would now be taller.
    stubViewport(1440, 800)
    body.offsetHeight = 1000
    scheduleChanges()
    expect(sizes()).toEqual([800])

    // A width change is a real relayout.
    stubViewport(1200, 800)
    body.offsetHeight = 1100
    scheduleChanges()
    expect(sizes()).toEqual([800, 1100])

    // Content that changed (a mutation, a font) reports whatever the viewport did.
    stubViewport(1200, 1100)
    body.offsetHeight = 500
    resetChangeTracking()
    scheduleChanges()
    expect(sizes()).toEqual([800, 1100, 500])
  })

  it('fixed reports every resize', () => {
    const body = { offsetHeight: 400, scrollHeight: 700 }
    stubBody(body)
    applyBodySize({ sizing: 'fixed' })
    scheduleChanges()
    stubViewport(1440, 800)
    body.scrollHeight = 900
    scheduleChanges()
    expect(sizes()).toEqual([700, 900])
  })
})
