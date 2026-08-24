import { describe, expect, it } from 'vitest'
import { parseExcalidrawLibrary } from './diagram-library'

const el = (id: string) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
})

describe('parseExcalidrawLibrary', () => {
  it('v2: preserva id, name, status, created e elements de cada item', () => {
    const items = parseExcalidrawLibrary({
      type: 'excalidrawlib',
      version: 2,
      libraryItems: [
        {
          id: 'a1',
          status: 'published',
          name: 'Seta dupla',
          created: 1_700_000_000_000,
          elements: [el('e1'), el('e2')],
        },
        {
          id: 'b2',
          status: 'unpublished',
          created: 1_700_000_000_001,
          elements: [el('e3')],
        },
      ],
    })

    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      id: 'a1',
      name: 'Seta dupla',
      status: 'published',
      elements: [el('e1'), el('e2')],
      created: 1_700_000_000_000,
    })
    // name ausente vira null (SQL não tem undefined).
    expect(items[1].name).toBeNull()
    expect(items[1].id).toBe('b2')
  })

  it('v1: cada entrada é um array de elements sem wrapper → item com id gerado', () => {
    const items = parseExcalidrawLibrary({
      type: 'excalidrawlib',
      version: 1,
      library: [[el('e1')], [el('e2'), el('e3')]],
    })

    expect(items).toHaveLength(2)
    expect(items[0].id).toBeTruthy()
    expect(items[0].status).toBe('unpublished')
    expect(items[0].name).toBeNull()
    expect(items[0].elements).toEqual([el('e1')])
    expect(items[1].elements).toHaveLength(2)
    expect(items[0].created).toBeGreaterThan(0)
    // ids gerados são únicos entre si.
    expect(items[0].id).not.toBe(items[1].id)
  })

  it('item v2 sem id ganha id aleatório; sem created ganha now', () => {
    const before = Date.now()
    const [item] = parseExcalidrawLibrary({
      type: 'excalidrawlib',
      libraryItems: [{ status: 'unpublished', elements: [el('e1')] }],
    })
    expect(item.id).toBeTruthy()
    expect(item.created).toBeGreaterThanOrEqual(before)
  })

  it('rejeita type errado, libraryItems não-array e item sem elements', () => {
    expect(() => parseExcalidrawLibrary({ type: 'excalidraw', libraryItems: [] })).toThrow(
      /type deve ser "excalidrawlib"/,
    )
    expect(() => parseExcalidrawLibrary({ type: 'excalidrawlib', libraryItems: 'nope' })).toThrow(
      /libraryItems deve ser um array/,
    )
    expect(() =>
      parseExcalidrawLibrary({
        type: 'excalidrawlib',
        libraryItems: [{ id: 'x' }],
      }),
    ).toThrow(/sem campo elements/)
  })

  it('rejeita não-objeto, sem nenhum dos campos, e v1 com entrada não-array', () => {
    expect(() => parseExcalidrawLibrary(null)).toThrow(/esperado um objeto/)
    expect(() => parseExcalidrawLibrary([1, 2])).toThrow(/esperado um objeto/)
    expect(() => parseExcalidrawLibrary({ type: 'excalidrawlib' })).toThrow(
      /sem libraryItems \(v2\) nem library \(v1\)/,
    )
    expect(() => parseExcalidrawLibrary({ type: 'excalidrawlib', library: [{ id: 'x' }] })).toThrow(
      /formato v1/,
    )
  })
})
