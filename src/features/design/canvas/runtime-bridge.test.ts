import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@shared/design/protocol'
import type { DesignNode } from '@shared/types/design'
import { ArtboardBridge, isIncoming } from './runtime-bridge'

const v = PROTOCOL_VERSION

describe('runtime-bridge isIncoming', () => {
  it('accepts well-formed runtime messages', () => {
    expect(isIncoming({ v, type: 'ready', artboardId: 'ab', protocol: 1 })).toBe(true)
    expect(isIncoming({ v, type: 'rendered' })).toBe(true)
    expect(isIncoming({ v, type: 'opResult', reqId: 'r1', ok: true })).toBe(true)
    expect(isIncoming({ v, type: 'hit', reqId: 'r2', id: null, rect: null, path: [] })).toBe(true)
    expect(isIncoming({ v, type: 'rects', reqId: 'r3', rects: {} })).toBe(true)
    expect(isIncoming({ v, type: 'rectsChanged', rects: { a: { x: 0, y: 0, w: 1, h: 1 } } })).toBe(
      true,
    )
    expect(isIncoming({ v, type: 'computed', reqId: 'r4', values: {} })).toBe(true)
    expect(isIncoming({ v, type: 'linkClick', toArtboardId: 'ab2', transition: 'smart' })).toBe(
      true,
    )
    expect(isIncoming({ v, type: 'navigated', artboardId: 'ab2' })).toBe(true)
    expect(isIncoming({ v, type: 'linkClick', transition: 'smart' })).toBe(false)
    expect(isIncoming({ v, type: 'navigated' })).toBe(false)
  })

  it('rejects the wrong version, unknown types and non-objects', () => {
    expect(isIncoming(null)).toBe(false)
    expect(isIncoming('ready')).toBe(false)
    expect(isIncoming([])).toBe(false)
    expect(isIncoming({ v: 99, type: 'rendered' })).toBe(false)
    expect(isIncoming({ v, type: 'bogus' })).toBe(false)
    expect(isIncoming({ v })).toBe(false)
  })

  it('rejects replies with a malformed reqId, rects or path without throwing', () => {
    expect(isIncoming({ v, type: 'opResult', reqId: 7, ok: true })).toBe(false)
    expect(isIncoming({ v, type: 'rects', reqId: 'r', rects: [] })).toBe(false)
    expect(isIncoming({ v, type: 'rects', reqId: 'r', rects: null })).toBe(false)
    expect(isIncoming({ v, type: 'rectsChanged', rects: 'x' })).toBe(false)
    expect(isIncoming({ v, type: 'hit', reqId: 'r', id: null, rect: null, path: 'root' })).toBe(
      false,
    )
    expect(isIncoming({ v, type: 'hit', reqId: 'r', id: 3, rect: null, path: [] })).toBe(false)
    expect(isIncoming({ v, type: 'computed', reqId: 'r', values: 1 })).toBe(false)
  })
})

const tree: DesignNode = { id: 'r', tag: 'div', kind: 'frame', style: {}, attrs: {}, children: [] }

function mountBridge() {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const target = iframe.contentWindow!
  const posted: unknown[] = []
  vi.spyOn(target, 'postMessage').mockImplementation((msg: unknown) => {
    posted.push(msg)
  })
  const bridge = new ArtboardBridge(iframe, 'ab1', 'tok')
  const incoming = (data: unknown): void => {
    window.dispatchEvent(new MessageEvent('message', { data, source: target }))
  }
  return { bridge, iframe, posted, incoming }
}

describe('ArtboardBridge motion & navigate', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('posts motionMode, motionReplay and scroll, and remembers the mode for a re-init', () => {
    const { bridge, posted, incoming } = mountBridge()
    bridge.init({ tree, tokens: {}, fonts: [], mode: 'edit', sizing: 'flow' })
    incoming({ v, type: 'ready', artboardId: 'ab1', protocol: 1 })
    bridge.setMotionMode('on')
    bridge.replayMotion(['a'])
    bridge.scroll(120, 900)
    expect(posted.slice(1)).toEqual([
      { v, type: 'motionMode', mode: 'on' },
      { v, type: 'motionReplay', ids: ['a'] },
      { v, type: 'scroll', y: 120, viewportH: 900 },
    ])
    bridge.reinit()
    expect(posted.at(-1)).toMatchObject({ type: 'init', sizing: 'flow', motion: 'on' })
    bridge.dispose()
  })

  it('navigate resolves on the matching navigated and emits linkClick/navigated', async () => {
    const { bridge, posted, incoming } = mountBridge()
    const clicks: string[] = []
    const navigated: string[] = []
    bridge.on('linkClick', (m) => clicks.push(`${m.toArtboardId}:${m.transition}:${m.duration}`))
    bridge.on('navigated', (m) => navigated.push(m.artboardId))
    const done = bridge.navigate({
      artboardId: 'ab2',
      tree,
      width: 390,
      height: 844,
      sizing: 'fixed',
      transition: 'smart',
      direction: 'forward',
      duration: 400,
    })
    expect(posted.at(-1)).toMatchObject({
      type: 'navigate',
      artboardId: 'ab2',
      transition: 'smart',
    })
    incoming({ v, type: 'linkClick', toArtboardId: 'ab2', transition: 'push', duration: 250 })
    incoming({ v, type: 'navigated', artboardId: 'other' })
    incoming({ v, type: 'navigated', artboardId: 'ab2' })
    await expect(done).resolves.toBeUndefined()
    expect(clicks).toEqual(['ab2:push:250'])
    expect(navigated).toEqual(['other', 'ab2'])
    bridge.dispose()
  })

  it('a second navigate supersedes the first; dispose rejects the pending one', async () => {
    const { bridge } = mountBridge()
    const payload = {
      tree,
      width: 1,
      height: 1,
      sizing: 'fixed' as const,
      transition: 'fade' as const,
      direction: 'back' as const,
    }
    const first = bridge.navigate({ artboardId: 'a', ...payload })
    const second = bridge.navigate({ artboardId: 'b', ...payload })
    await expect(first).rejects.toThrow('superseded')
    bridge.dispose()
    await expect(second).rejects.toThrow('disposed')
  })
})
