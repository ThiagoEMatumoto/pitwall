import { describe, expect, it, vi } from 'vitest'

const canvasApi = vi.hoisted(() => ({
  get: vi.fn(),
  setPositions: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ({ canvasApi }))
import { useCanvasStateStore, withKeptSizes } from './canvas-state-store'
import type { CanvasPosition } from '../../../shared/types/canvas'

const saved: CanvasPosition[] = [
  { scope: 'all', kind: 'session', entityId: 'a', x: 1, y: 2, w: 500, h: 300 },
  { scope: 'all', kind: 'note', entityId: 'a', x: 1, y: 2, w: 220, h: 132 },
]

describe('withKeptSizes', () => {
  it('arrastar (sem w/h) mantém o tamanho já salvo: o upsert do main gravaria NULL', () => {
    expect(withKeptSizes([{ kind: 'session', entityId: 'a', x: 9, y: 9 }], saved)).toEqual([
      { kind: 'session', entityId: 'a', x: 9, y: 9, w: 500, h: 300 },
    ])
  })

  it('null explícito volta ao tamanho padrão; valor novo substitui', () => {
    expect(
      withKeptSizes([{ kind: 'session', entityId: 'a', x: 9, y: 9, w: null, h: null }], saved),
    ).toEqual([{ kind: 'session', entityId: 'a', x: 9, y: 9, w: null, h: null }])
    expect(
      withKeptSizes([{ kind: 'session', entityId: 'a', x: 9, y: 9, w: 600, h: 400 }], saved)[0],
    ).toMatchObject({ w: 600, h: 400 })
  })

  it('arrastar um cartão que trocou de feature mantém o tamanho guardado sem posição', () => {
    expect(
      withKeptSizes([{ kind: 'session', entityId: 'g', x: 9, y: 9 }], saved, [
        { sessionId: 'g', w: 600, h: 500 },
      ]),
    ).toEqual([{ kind: 'session', entityId: 'g', x: 9, y: 9, w: 600, h: 500 }])
  })

  it('casa por kind + id, e sem nada salvo fica sem tamanho', () => {
    expect(withKeptSizes([{ kind: 'group', entityId: 'a', x: 0, y: 0 }], saved)).toEqual([
      { kind: 'group', entityId: 'a', x: 0, y: 0 },
    ])
  })
})

describe('useCanvasStateStore.load', () => {
  // Organizar: o broadcast do clear dispara um get que o main responde com o
  // canvas zerado DEPOIS da gravação otimista das posições novas.
  it('descarta um get iniciado antes de uma gravação e busca de novo', async () => {
    const empty = { scope: 'all', positions: [], views: [], sizes: [], notes: [], groups: [] }
    const tidied = {
      ...empty,
      positions: [{ scope: 'all', kind: 'session', entityId: 'g', x: 0, y: 0, w: 560, h: 472 }],
    }
    let answerStale!: (v: unknown) => void
    canvasApi.get
      .mockReturnValueOnce(Promise.resolve(empty))
      .mockReturnValueOnce(new Promise((r) => (answerStale = r)))
      .mockReturnValueOnce(Promise.resolve(tidied))
    canvasApi.setPositions.mockResolvedValue(undefined)
    const store = useCanvasStateStore.getState()
    await store.load('all')

    const staleLoad = store.load('all')
    await store.savePositions('all', [
      { kind: 'session', entityId: 'g', x: 0, y: 0, w: 560, h: 472 },
    ])
    answerStale(empty)
    await staleLoad

    expect(canvasApi.get).toHaveBeenCalledTimes(3)
    expect(useCanvasStateStore.getState().canvas?.positions[0]).toMatchObject({ w: 560, h: 472 })
  })
})
