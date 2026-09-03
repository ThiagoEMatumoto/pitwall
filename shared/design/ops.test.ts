import { describe, expect, it } from 'vitest'
import type { DesignNode, DesignOp } from '../types/design'
import {
  applyOp,
  applyOps,
  buildIndex,
  cloneWithNewIds,
  findNode,
  invertOp,
  invertOps,
  summarize,
  summaryToText,
  validateTree,
  walk,
} from './ops'

const node = (partial: Partial<DesignNode> & { id: string }): DesignNode => ({
  tag: 'div',
  kind: 'frame',
  style: {},
  attrs: {},
  children: [],
  ...partial,
})

// root
// ├─ header (h)
// │   ├─ title (t)  text
// │   └─ nav (n)
// │       ├─ a1  text
// │       └─ a2  text
// └─ main (m)
//     └─ img (i)
const makeTree = (): DesignNode =>
  node({
    id: 'root',
    style: { display: 'flex' },
    children: [
      node({
        id: 'h',
        tag: 'header',
        name: 'Header',
        children: [
          node({
            id: 't',
            tag: 'h1',
            kind: 'text',
            text: 'Hello',
            style: { color: 'red', margin: '0' },
          }),
          node({
            id: 'n',
            tag: 'nav',
            children: [
              node({ id: 'a1', tag: 'a', kind: 'text', text: 'One', attrs: { href: '/one' } }),
              node({ id: 'a2', tag: 'a', kind: 'text', text: 'Two', attrs: { href: '/two' } }),
            ],
          }),
        ],
      }),
      node({
        id: 'm',
        tag: 'main',
        children: [node({ id: 'i', tag: 'img', kind: 'image', attrs: { src: 'x.png' } })],
      }),
    ],
  })

const childIds = (tree: DesignNode, id: string): string[] =>
  findNode(tree, id)!.node.children.map((child) => child.id)

// Inverse computed before applying; applying it after must restore the tree.
function roundTrip(op: DesignOp): DesignNode {
  const original = makeTree()
  const snapshot = structuredClone(original)
  const inverse = invertOp(original, op)
  const applied = applyOp(original, op).tree
  const restored = applyOps(applied, inverse).tree
  expect(restored).toEqual(snapshot)
  // Input never mutated.
  expect(original).toEqual(snapshot)
  return applied
}

describe('findNode / buildIndex / walk', () => {
  it('finds nodes with parent and index', () => {
    const tree = makeTree()
    expect(findNode(tree, 'a2')).toMatchObject({ parent: { id: 'n' }, index: 1 })
    expect(findNode(tree, 'root')).toMatchObject({ parent: null, index: -1 })
    expect(findNode(tree, 'nope')).toBeNull()
  })

  it('indexes every node with its parent id', () => {
    const index = buildIndex(makeTree())
    expect(index.size).toBe(8)
    expect(index.get('root')!.parentId).toBeNull()
    expect(index.get('i')!.parentId).toBe('m')
  })

  it('walks in document order with depth and stops on false', () => {
    const seen: string[] = []
    walk(makeTree(), (n, depth) => {
      seen.push(`${n.id}:${depth}`)
      if (n.id === 'n') return false
    })
    expect(seen).toEqual(['root:0', 'h:1', 't:2', 'n:2'])
  })
})

describe('applyOp', () => {
  it('insert appends when index is past the end and defaults to root', () => {
    const tree = makeTree()
    const { tree: next, touched } = applyOp(tree, {
      type: 'insert',
      parentId: null,
      index: 99,
      node: node({ id: 'footer', tag: 'footer' }),
    })
    expect(childIds(next, 'root')).toEqual(['h', 'm', 'footer'])
    expect(touched).toEqual(['footer'])
    expect(childIds(tree, 'root')).toEqual(['h', 'm'])
  })

  it('insert rejects ids already in the tree', () => {
    expect(() =>
      applyOp(makeTree(), { type: 'insert', parentId: 'm', index: 0, node: node({ id: 'a1' }) }),
    ).toThrow('duplicate id: a1')
  })

  it('remove drops only the ancestors when ids are nested', () => {
    const { tree, touched } = applyOp(makeTree(), { type: 'remove', ids: ['a1', 'h', 't'] })
    expect(childIds(tree, 'root')).toEqual(['m'])
    expect(touched).toEqual(['h'])
  })

  it('move keeps the relative order of several ids', () => {
    const { tree, touched } = applyOp(makeTree(), {
      type: 'move',
      ids: ['a2', 't'],
      parentId: 'm',
      index: 0,
    })
    expect(childIds(tree, 'm')).toEqual(['t', 'a2', 'i'])
    expect(childIds(tree, 'h')).toEqual(['n'])
    expect(childIds(tree, 'n')).toEqual(['a1'])
    expect(touched).toEqual(['t', 'a2'])
  })

  it('move within the same parent uses the index after detaching', () => {
    const { tree } = applyOp(makeTree(), { type: 'move', ids: ['a1'], parentId: 'n', index: 1 })
    expect(childIds(tree, 'n')).toEqual(['a2', 'a1'])
  })

  it('move refuses to put a node inside itself', () => {
    expect(() =>
      applyOp(makeTree(), { type: 'move', ids: ['h'], parentId: 'n', index: 0 }),
    ).toThrow('cannot move node into itself: h')
  })

  it('setStyle / setAttrs delete keys on null', () => {
    const { tree } = applyOps(makeTree(), [
      { type: 'setStyle', id: 't', patch: { color: null, padding: '4px' } },
      { type: 'setAttrs', id: 'a1', patch: { href: null, target: '_blank' } },
    ])
    expect(findNode(tree, 't')!.node.style).toEqual({ margin: '0', padding: '4px' })
    expect(findNode(tree, 'a1')!.node.attrs).toEqual({ target: '_blank' })
  })

  it('setText / rename / replaceTree / setArtboard', () => {
    const tree = makeTree()
    expect(
      findNode(applyOp(tree, { type: 'setText', id: 't', text: 'Bye' }).tree, 't')!.node.text,
    ).toBe('Bye')
    expect(
      findNode(applyOp(tree, { type: 'rename', id: 'm', name: 'Main' }).tree, 'm')!.node.name,
    ).toBe('Main')
    expect(
      findNode(applyOp(tree, { type: 'rename', id: 'h', name: '' }).tree, 'h')!.node,
    ).not.toHaveProperty('name')
    const fresh = node({ id: 'r2' })
    expect(applyOp(tree, { type: 'replaceTree', tree: fresh })).toEqual({
      tree: fresh,
      touched: ['r2'],
    })
    const untouched = applyOp(tree, { type: 'setArtboard', patch: { width: 100 } })
    expect(untouched.tree).toBe(tree)
    expect(untouched.touched).toEqual([])
  })

  it('throws node not found', () => {
    expect(() => applyOp(makeTree(), { type: 'setText', id: 'zz', text: '' })).toThrow(
      'node not found: zz',
    )
    expect(() => applyOp(makeTree(), { type: 'remove', ids: ['zz'] })).toThrow('node not found: zz')
    expect(() =>
      applyOp(makeTree(), { type: 'insert', parentId: 'zz', index: 0, node: node({ id: 'q' }) }),
    ).toThrow('node not found: zz')
  })

  it('applyOps dedupes touched ids', () => {
    const { touched } = applyOps(makeTree(), [
      { type: 'setText', id: 't', text: 'a' },
      { type: 'setStyle', id: 't', patch: { color: 'blue' } },
    ])
    expect(touched).toEqual(['t'])
  })
})

describe('invertOp restores the tree', () => {
  it('insert', () => {
    roundTrip({
      type: 'insert',
      parentId: 'n',
      index: 1,
      node: node({ id: 'a15', tag: 'a', kind: 'text', text: 'x' }),
    })
  })

  it('remove of siblings and nested ids', () => {
    const inverse = invertOp(makeTree(), { type: 'remove', ids: ['a2', 'h', 'i'] })
    expect(inverse.map((op) => op.type)).toEqual(['insert', 'insert'])
    expect(inverse[0]).toMatchObject({ parentId: 'root', index: 0, node: { id: 'h' } })
    roundTrip({ type: 'remove', ids: ['a2', 'h', 'i'] })
    roundTrip({ type: 'remove', ids: ['a1', 'a2'] })
  })

  it('move across and within parents', () => {
    expect(
      invertOp(makeTree(), { type: 'move', ids: ['a2', 't'], parentId: 'm', index: 0 }),
    ).toEqual([
      { type: 'move', ids: ['t'], parentId: 'h', index: 0 },
      { type: 'move', ids: ['a2'], parentId: 'n', index: 1 },
    ])
    roundTrip({ type: 'move', ids: ['a2', 't'], parentId: 'm', index: 0 })
    roundTrip({ type: 'move', ids: ['h'], parentId: 'root', index: 5 })
    roundTrip({ type: 'move', ids: ['t', 'a1'], parentId: 'h', index: 1 })
  })

  it('setStyle / setAttrs record old values and null for absent keys', () => {
    expect(
      invertOp(makeTree(), { type: 'setStyle', id: 't', patch: { color: 'blue', padding: '1px' } }),
    ).toEqual([{ type: 'setStyle', id: 't', patch: { color: 'red', padding: null } }])
    roundTrip({ type: 'setStyle', id: 't', patch: { color: null, padding: '1px' } })
    roundTrip({ type: 'setAttrs', id: 'a1', patch: { href: null, rel: 'nofollow' } })
  })

  it('setText / rename / replaceTree', () => {
    roundTrip({ type: 'setText', id: 't', text: 'Changed' })
    roundTrip({ type: 'rename', id: 'h', name: 'Top' })
    roundTrip({ type: 'rename', id: 'm', name: 'Main' })
    roundTrip({ type: 'replaceTree', tree: node({ id: 'other' }) })
  })

  it('setArtboard takes the current values from the caller', () => {
    const op: DesignOp = { type: 'setArtboard', patch: { width: 800, name: 'Wide' } }
    expect(
      invertOp(makeTree(), op, { x: 0, y: 0, width: 1440, height: 900, name: 'Home' }),
    ).toEqual([{ type: 'setArtboard', patch: { width: 1440, name: 'Home' } }])
    expect(invertOp(makeTree(), op)).toEqual([{ type: 'setArtboard', patch: {} }])
  })

  it('setArtboard sizing: leaves the tree alone and inverts to the previous sizing', () => {
    const tree = makeTree()
    const op: DesignOp = { type: 'setArtboard', patch: { sizing: 'flow' } }
    const applied = applyOp(tree, op)
    expect(applied.tree).toBe(tree)
    expect(applied.touched).toEqual([])
    expect(invertOp(tree, op, { sizing: 'fixed', height: 900 })).toEqual([
      { type: 'setArtboard', patch: { sizing: 'fixed' } },
    ])
  })

  it('invertOps undoes a batch in reverse', () => {
    const original = makeTree()
    const ops: DesignOp[] = [
      { type: 'remove', ids: ['a1'] },
      { type: 'move', ids: ['t'], parentId: 'n', index: 0 },
      { type: 'setText', id: 't', text: 'x' },
      { type: 'insert', parentId: 'root', index: 0, node: node({ id: 'new' }) },
    ]
    const inverse = invertOps(original, ops)
    const applied = applyOps(original, ops).tree
    expect(applyOps(applied, inverse).tree).toEqual(makeTree())
  })
})

describe('summarize / summaryToText', () => {
  it('limits depth, truncates text and counts children', () => {
    const tree = makeTree()
    findNode(tree, 't')!.node.text = 'x'.repeat(70)
    const summary = summarize(tree, 1)
    expect(summary.children!.map((c) => c.id)).toEqual(['h', 'm'])
    expect(summary.children![0]).toMatchObject({ name: 'Header', childCount: 2 })
    expect(summary.children![0].children).toBeUndefined()
    const deep = summarize(tree, 5)
    expect(deep.children![0].children![0].text).toBe(`${'x'.repeat(60)}…`)
    expect(summarize(tree, 0).children).toBeUndefined()
  })

  it('renders indented lines for the agent', () => {
    expect(summaryToText(summarize(makeTree(), 2))).toBe(
      [
        'root div.frame',
        '  h header.frame "Header"',
        '    t h1.text "Hello"',
        '    n nav.frame (2 children)',
        '  m main.frame',
        '    i img.image',
      ].join('\n'),
    )
  })
})

describe('cloneWithNewIds', () => {
  it('gives every node a fresh id and maps old to new', () => {
    const source = makeTree()
    const { node: cloned, idMap } = cloneWithNewIds(source)
    expect(Object.keys(idMap).sort()).toEqual(['a1', 'a2', 'h', 'i', 'm', 'n', 'root', 't'])
    const newIds = new Set(Object.values(idMap))
    expect(newIds.size).toBe(8)
    walk(cloned, (n) => {
      expect(newIds.has(n.id)).toBe(true)
    })
    expect(cloned.id).toBe(idMap.root)
    expect(findNode(cloned, idMap.t)!.node.style).toEqual({ color: 'red', margin: '0' })
    expect(findNode(cloned, idMap.t)!.node.style).not.toBe(findNode(source, 't')!.node.style)
    expect(validateTree(cloned)).toEqual([])
  })
})

describe('validateTree', () => {
  it('accepts a sane tree', () => {
    expect(validateTree(makeTree())).toEqual([])
  })

  it('reports every problem', () => {
    const tree = node({
      id: 'root',
      children: [
        node({ id: 'dup' }),
        node({ id: 'dup', tag: 'SCRIPT' }),
        node({
          id: 'bad',
          kind: 'widget' as DesignNode['kind'],
          attrs: { onclick: 'x()', href: ' JavaScript:alert(1)' },
        }),
        node({ id: 'txt', kind: 'text', children: [node({ id: 'inner' })] }),
        node({ id: '' }),
      ],
    })
    expect(validateTree(tree)).toEqual([
      'duplicate id: dup',
      'dup: forbidden tag <SCRIPT>',
      'bad: invalid kind "widget"',
      'bad: event handler attribute "onclick"',
      'bad: unsafe URL in "href"',
      'txt: text node must not have children',
      'node with empty id',
    ])
  })
})

describe('validateTree — limits and links', () => {
  it('refuses trees nesting deeper than the limit without blowing the stack', () => {
    let tree: DesignNode = node({ id: 'leaf' })
    for (let i = 0; i < 5000; i++) tree = node({ id: `n${i}`, children: [tree] })
    const errors = validateTree(tree)
    expect(errors).toEqual(['tree nests deeper than 256 levels'])
  })

  it('reports invalid attribute names, obfuscated schemes and malformed links', () => {
    const tree = node({
      id: 'root',
      children: [
        node({ id: 'a', attrs: { 'bad name': '1', href: 'java\nscript:alert(1)' } }),
        node({ id: 'b', attrs: { src: 'vbscript:x', 'xlink:href': 'data:text/html,x' } }),
        node({ id: 'c', link: { artboardId: 'x', transition: 'wipe' } as never }),
        node({ id: 'd', tag: 'area' }),
        node({ id: 'e', attrs: { href: '#top', src: 'data:image/png;base64,AA==' } }),
      ],
    })
    expect(validateTree(tree)).toEqual([
      'a: invalid attribute name "bad name"',
      'a: unsafe URL in "href"',
      'b: unsafe URL in "src"',
      'b: unsafe URL in "xlink:href"',
      'c: invalid link',
      'd: forbidden tag <area>',
    ])
  })
})

describe('setLink op', () => {
  it('sets, replaces and clears node.link; inverse restores the previous link', () => {
    const tree = makeTree()
    const set: DesignOp = {
      type: 'setLink',
      id: 't',
      link: { artboardId: 'ab2', transition: 'push' },
    }
    const inverse = invertOps(tree, [set])
    const linked = applyOps(tree, [set]).tree
    expect(findNode(linked, 't')!.node.link).toEqual({ artboardId: 'ab2', transition: 'push' })
    expect(inverse).toEqual([{ type: 'setLink', id: 't', link: null }])
    const cleared = applyOps(linked, inverse).tree
    expect('link' in findNode(cleared, 't')!.node).toBe(false)
    expect(cleared).toEqual(tree)
  })
})
