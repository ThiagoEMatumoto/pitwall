import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'
import type { DesignOrigin } from '../../../../shared/types/design'

let testDb: Database.Database
vi.mock('../db', () => ({
  getDb: () => testDb,
}))
// notify pulls electron.BrowserWindow; every call here injects `send`.
vi.mock('../notify', () => ({ broadcast: vi.fn() }))

import * as store from './design-store'
import { applyArtboardOps, setNodeMotion } from './mutate'

const origin: DesignOrigin = { kind: 'human', sessionId: null, nonce: 'n1' }

function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) {
      db.pragma('foreign_keys = OFF')
      try {
        m.up(db)
      } finally {
        db.pragma('foreign_keys = ON')
      }
    } else {
      m.up(db)
    }
  }
}

describe('mutate — setArtboard sizing and clamp warnings', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  function newArtboard() {
    const doc = store.createDocument({ title: 'T' })
    return store.createArtboard({ docId: doc.id, name: 'Home', width: 1440, height: 900 })
  }

  it('clamps width/height to the limits and reports each clamp as a warning', () => {
    const ab = newArtboard()
    const send = vi.fn()
    const result = applyArtboardOps({
      artboardId: ab.id,
      ops: [{ type: 'setArtboard', patch: { width: 20000, height: 4 } }],
      author: 'human',
      origin,
      send,
    })
    expect(result.warnings).toEqual(['width 20000 clamped to 16384', 'height 4 clamped to 16'])
    expect([result.artboard.width, result.artboard.height]).toEqual([16384, 16])
    expect(result.artboard.version).toBe(ab.version + 1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a patch inside the limits carries no warnings key at all', () => {
    const ab = newArtboard()
    const result = applyArtboardOps({
      artboardId: ab.id,
      ops: [{ type: 'setArtboard', patch: { width: 1920, height: 1080.4 } }],
      author: 'human',
      origin,
      send: vi.fn(),
    })
    expect(result).not.toHaveProperty('warnings')
    expect([result.artboard.width, result.artboard.height]).toEqual([1920, 1080])
  })

  it('persists sizing flow and ignores an unknown sizing with a warning', () => {
    const ab = newArtboard()
    const flow = applyArtboardOps({
      artboardId: ab.id,
      ops: [{ type: 'setArtboard', patch: { sizing: 'flow', height: 2340 } }],
      author: 'claude',
      origin,
      send: vi.fn(),
    })
    expect(flow.warnings).toBeUndefined()
    expect([flow.artboard.sizing, flow.artboard.height]).toEqual(['flow', 2340])
    expect(store.getArtboard(ab.id)!.sizing).toBe('flow')

    const odd = applyArtboardOps({
      artboardId: ab.id,
      ops: [{ type: 'setArtboard', patch: { sizing: 'fluid' as unknown as 'fixed' } }],
      author: 'human',
      origin,
      send: vi.fn(),
    })
    expect(odd.warnings).toEqual(["sizing fluid ignored; use 'fixed' or 'flow'"])
    expect(odd.artboard.sizing).toBe('flow')
  })
})

describe('mutate — setNodeMotion', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  function newArtboard() {
    const doc = store.createDocument({ title: 'T' })
    return store.createArtboard({
      docId: doc.id,
      name: 'Home',
      width: 1440,
      height: 900,
      tree: {
        id: 'root',
        tag: 'div',
        kind: 'frame',
        style: {},
        attrs: {},
        children: [
          { id: 'hero', tag: 'section', kind: 'frame', style: {}, attrs: {}, children: [] },
          { id: 'cta', tag: 'button', kind: 'element', style: {}, attrs: {}, children: [] },
        ],
      },
    })
  }

  it('normalises partial sections, emits one setMotion per item and clears with null', () => {
    const ab = newArtboard()
    const send = vi.fn()
    const result = setNodeMotion({
      artboardId: ab.id,
      items: [
        { id: 'hero', motion: { entrance: { preset: 'slide-up', stagger: 60 } } },
        { id: 'cta', motion: { hover: { preset: 'lift', intensity: 5 } } },
      ],
      author: 'claude',
      origin,
      send,
    })
    expect(result.event.ops).toEqual([
      {
        type: 'setMotion',
        id: 'hero',
        motion: {
          entrance: {
            preset: 'slide-up',
            trigger: 'load',
            duration: 220,
            delay: 0,
            easing: 'ease-out',
            stagger: 60,
          },
        },
      },
      {
        type: 'setMotion',
        id: 'cta',
        motion: { hover: { preset: 'lift', duration: 160, easing: 'ease-out', intensity: 3 } },
      },
    ])
    const saved = store.getArtboard(ab.id)!
    expect(saved.tree.children[1].motion).toEqual({
      hover: { preset: 'lift', duration: 160, easing: 'ease-out', intensity: 3 },
    })
    expect(send).toHaveBeenCalledTimes(1)

    setNodeMotion({
      artboardId: ab.id,
      items: [{ id: 'cta', motion: null }],
      author: 'human',
      origin,
      send,
    })
    expect('motion' in store.getArtboard(ab.id)!.tree.children[1]).toBe(false)
  })

  it('refuses the root, unknown nodes and unknown presets before writing', () => {
    const ab = newArtboard()
    const base = { artboardId: ab.id, author: 'human' as const, origin, send: vi.fn() }
    expect(() => setNodeMotion({ ...base, items: [{ id: 'root', motion: null }] })).toThrow(/root/)
    expect(() => setNodeMotion({ ...base, items: [{ id: 'nope', motion: null }] })).toThrow(
      /not found/,
    )
    expect(() =>
      setNodeMotion({ ...base, items: [{ id: 'hero', motion: { loop: { preset: 'wobble' } } }] }),
    ).toThrow(/loop preset/)
    expect(store.getArtboard(ab.id)!.version).toBe(ab.version)
  })
})
