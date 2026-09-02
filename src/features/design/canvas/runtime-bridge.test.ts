import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@shared/design/protocol'
import { isIncoming } from './runtime-bridge'

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
