import { describe, expect, it } from 'vitest'
import type { DesignNode, DesignOp } from '../types/design'
import {
  applyOps,
  cloneWithNewIds,
  findNode,
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

// Same shape as ops.test.ts: root > header(h) > [title(t), nav(n)], main(m) > img(i).
const makeTree = (): DesignNode =>
  node({
    id: 'root',
    children: [
      node({
        id: 'h',
        tag: 'header',
        name: 'Header',
        children: [
          node({ id: 't', tag: 'h1', kind: 'text', text: 'Hello' }),
          node({
            id: 'n',
            tag: 'nav',
            children: [node({ id: 'a1', tag: 'a', kind: 'text', text: 'One' })],
          }),
        ],
      }),
      node({ id: 'm', tag: 'main', children: [node({ id: 'i', tag: 'img', kind: 'image' })] }),
    ],
  })

describe('setMotion op', () => {
  const motion = {
    entrance: {
      preset: 'fade' as const,
      trigger: 'load' as const,
      duration: 220,
      delay: 0,
      easing: 'ease-out' as const,
    },
    hover: { preset: 'lift' as const, duration: 160, easing: 'ease-out' as const },
  }

  it('sets, replaces and clears node.motion; the inverse restores the previous motion', () => {
    const tree = makeTree()
    const set: DesignOp = { type: 'setMotion', id: 't', motion }
    const inverse = invertOps(tree, [set])
    const withMotion = applyOps(tree, [set]).tree
    expect(findNode(withMotion, 't')!.node.motion).toEqual(motion)
    // The stored motion is a copy: mutating the op afterwards changes nothing.
    expect(findNode(withMotion, 't')!.node.motion).not.toBe(motion)
    expect(inverse).toEqual([{ type: 'setMotion', id: 't', motion: null }])
    const cleared = applyOps(withMotion, inverse).tree
    expect('motion' in findNode(cleared, 't')!.node).toBe(false)
    expect(cleared).toEqual(tree)

    const replace: DesignOp = {
      type: 'setMotion',
      id: 't',
      motion: { loop: { preset: 'spin', duration: 2000 } },
    }
    expect(invertOps(withMotion, [replace])).toEqual([{ type: 'setMotion', id: 't', motion }])
    expect(findNode(applyOps(withMotion, [replace]).tree, 't')!.node.motion).toEqual({
      loop: { preset: 'spin', duration: 2000 },
    })
  })

  it('clone copies motion deeply and never leaves motion: undefined behind', () => {
    const tree = applyOps(makeTree(), [{ type: 'setMotion', id: 'h', motion }]).tree
    const { node: cloned, idMap } = cloneWithNewIds(findNode(tree, 'h')!.node)
    const copy = findNode(cloned, idMap.h)!.node
    expect(copy.motion).toEqual(motion)
    expect(copy.motion).not.toBe(findNode(tree, 'h')!.node.motion)
    expect(copy.motion!.entrance).not.toBe(findNode(tree, 'h')!.node.motion!.entrance)
    walk(cloned, (n) => {
      if (n.id !== idMap.h) expect('motion' in n).toBe(false)
    })
    expect(validateTree(cloned)).toEqual([])
  })

  it('validateTree rejects an invalid motion and a reserved --pw-* style key', () => {
    const tree = makeTree()
    const bad = applyOps(tree, [
      { type: 'setMotion', id: 't', motion: { entrance: { preset: 'wiggle' } } as never },
      { type: 'setStyle', id: 'i', patch: { '--pw-dur': '1s' } },
    ]).tree
    expect(validateTree(bad)).toEqual([
      't: invalid motion',
      'i: reserved style property "--pw-dur"',
    ])
  })

  it('summary carries the motion line', () => {
    const tree = applyOps(makeTree(), [{ type: 'setMotion', id: 't', motion }]).tree
    const summary = summarize(tree, 2)
    expect(summary.children![0].children![0].motion).toBe('in: fade 220ms · hover: lift')
    expect(summaryToText(summary)).toContain(
      't h1.text "Hello" [motion in: fade 220ms · hover: lift]',
    )
  })

  it('link accepts smart + duration/easing and rejects them out of range', () => {
    const ok = applyOps(makeTree(), [
      {
        type: 'setLink',
        id: 't',
        link: { artboardId: 'ab2', transition: 'smart', duration: 400, easing: 'spring-gentle' },
      },
    ]).tree
    expect(validateTree(ok)).toEqual([])
    const bad = applyOps(makeTree(), [
      {
        type: 'setLink',
        id: 't',
        link: { artboardId: 'ab2', transition: 'smart', duration: 6000 },
      },
      {
        type: 'setLink',
        id: 'i',
        link: { artboardId: 'ab2', transition: 'fade', easing: 'ease' as never },
      },
    ]).tree
    expect(validateTree(bad)).toEqual(['t: invalid link', 'i: invalid link'])
  })
})
