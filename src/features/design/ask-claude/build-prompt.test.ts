import { describe, expect, it } from 'vitest'
import type { DesignNode } from '@shared/types/design'
import {
  TREE_SUMMARY_MAX_LINES,
  buildAskPrompt,
  buildTreeSummary,
  selectionLabel,
  truncateLines,
} from './build-prompt'

function node(
  id: string,
  tag: string,
  children: DesignNode[] = [],
  extra: Partial<DesignNode> = {},
): DesignNode {
  return {
    id,
    tag,
    kind: children.length > 0 ? 'frame' : 'text',
    style: {},
    attrs: {},
    children,
    ...extra,
  }
}

const tree = node('root', 'div', [
  node(
    'hero',
    'section',
    [
      node('h1', 'h1', [], { text: 'Breads do Breno' }),
      node('p1', 'p', [], { text: 'Pão de verdade' }),
    ],
    {
      name: 'Hero',
    },
  ),
  node('menu', 'section', [node('item1', 'div', [node('deep', 'span', [], { text: 'deep' })])], {
    name: 'Menu',
  }),
])

describe('buildAskPrompt', () => {
  it('follows the header / tree / instruction / request layout', () => {
    const prompt = buildAskPrompt({
      docId: 'doc1',
      docTitle: 'Breads',
      artboardId: 'ab1',
      artboardName: 'Home',
      selection: [{ id: 'hero', name: 'Hero', tag: 'section', kind: 'frame' }],
      treeSummaryText: 'hero section.frame "Hero"',
      request: '  deixa o hero mais quente  ',
    })
    const lines = prompt.split('\n')
    expect(lines[0]).toBe(
      '[Pitwall Design Studio] doc="Breads" docId=doc1 artboardId=ab1 artboard="Home" selection=[hero]',
    )
    expect(lines[1]).toBe('Seleção: hero section.frame "Hero"')
    expect(lines[2]).toBe('Tree:')
    expect(lines[3]).toBe('hero section.frame "Hero"')
    expect(lines[4]).toContain('SOMENTE as tools mcp__pitwall__design_*')
    expect(lines[4]).toContain('design_nodes_finish')
    expect(lines[5]).toBe('Pedido: deixa o hero mais quente')
  })

  it('omits selection and tree sections when empty', () => {
    const prompt = buildAskPrompt({
      docId: 'doc1',
      docTitle: 'Breads',
      artboardId: null,
      artboardName: null,
      selection: [],
      request: 'cria uma home',
    })
    expect(prompt).toContain('artboardId=none selection=[]')
    expect(prompt).not.toContain('Seleção:')
    expect(prompt).not.toContain('Tree:')
    expect(prompt.split('\n')).toHaveLength(3)
  })

  it('caps an oversized tree summary at TREE_SUMMARY_MAX_LINES', () => {
    const big = Array.from({ length: 100 }, (_, i) => `n${i} div.frame`).join('\n')
    const prompt = buildAskPrompt({
      docId: 'd',
      docTitle: 't',
      artboardId: 'a',
      artboardName: 'A',
      selection: [],
      treeSummaryText: big,
      request: 'x',
    })
    const treeLines = prompt.split('\n').slice(2, -2)
    expect(treeLines).toHaveLength(TREE_SUMMARY_MAX_LINES + 1)
    expect(treeLines.at(-1)).toBe('… (+60 linhas)')
  })
})

describe('buildTreeSummary', () => {
  it('summarizes the selected subtrees at depth 2', () => {
    const text = buildTreeSummary(tree, ['menu'])
    expect(text).toContain('menu section.frame "Menu"')
    expect(text).toContain('  item1 div.frame')
    expect(text).toContain('    deep span.text')
    expect(text).not.toContain('hero')
  })

  it('falls back to the artboard root when nothing (or nothing known) is selected', () => {
    const text = buildTreeSummary(tree, ['ghost'])
    expect(text.split('\n')[0]).toBe('root div.frame')
    expect(text).toContain('  hero section.frame "Hero"')
    // depth 2 stops at the grandchildren: 'deep' is at depth 3.
    expect(text).toContain('    item1 div.frame (1 children)')
    expect(text).not.toContain('deep')
  })

  it('truncates to the line cap', () => {
    const wide = node(
      'root',
      'div',
      Array.from({ length: 60 }, (_, i) => node(`c${i}`, 'div')),
    )
    const lines = buildTreeSummary(wide, []).split('\n')
    expect(lines).toHaveLength(TREE_SUMMARY_MAX_LINES + 1)
    expect(lines.at(-1)).toBe('… (+21 linhas)')
  })
})

describe('helpers', () => {
  it('truncateLines leaves short text untouched', () => {
    expect(truncateLines('a\nb', 5)).toBe('a\nb')
  })

  it('selectionLabel prefers the node name', () => {
    expect(selectionLabel({ id: 'n1', name: 'Hero', tag: 'section', kind: 'frame' })).toBe(
      'Hero (section#n1)',
    )
    expect(selectionLabel({ id: 'n2', tag: 'p', kind: 'text' })).toBe('p#n2')
  })
})
