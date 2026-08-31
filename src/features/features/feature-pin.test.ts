import { describe, expect, it, vi } from 'vitest'
import type { Feature } from '../../../shared/types/ipc'

const featuresApi: Record<string, unknown> = {}
vi.mock('@/lib/ipc', () => ({
  get featuresApi() {
    return featuresApi
  },
}))

const { compareFocus, focusRankOf, isPinned, selectPinned, setFeaturePinned } = await import(
  './feature-pin'
)

function makeFeature(over: Partial<Feature> & Record<string, unknown> = {}): Feature {
  return {
    id: 'f1',
    projectId: 'p1',
    slug: 'trf4',
    title: 'Extração TRF4',
    status: 'in-progress',
    objective: null,
    docPath: '/tmp/f1.md',
    synthMode: 'auto',
    model: null,
    repos: [],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
    ...over,
  } as Feature
}

const activity = (f: Feature) => f.updatedAt

describe('feature-pin', () => {
  it('feature sem os campos do backend não é pinada nem tem rank', () => {
    const f = makeFeature()
    expect(isPinned(f)).toBe(false)
    expect(focusRankOf(f)).toBeNull()
  })

  it('selectPinned ordena por focusRank e deixa arquivada de fora', () => {
    const feats = [
      makeFeature({ id: 'a', pinned: true, focusRank: 2, updatedAt: 100 }),
      makeFeature({ id: 'b', pinned: true, focusRank: 1, updatedAt: 1 }),
      makeFeature({ id: 'c', pinned: false, updatedAt: 999 }),
      makeFeature({ id: 'd', pinned: true, focusRank: 1, archivedAt: 5 }),
    ]
    expect(selectPinned(feats, activity).map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('sem focusRank a pinada cai pro fim e desempata por atividade', () => {
    const feats = [
      makeFeature({ id: 'sem-rank-velha', pinned: true, updatedAt: 10 }),
      makeFeature({ id: 'sem-rank-nova', pinned: true, updatedAt: 50 }),
      makeFeature({ id: 'com-rank', pinned: true, focusRank: 3, updatedAt: 1 }),
    ]
    expect([...feats].sort(compareFocus(activity)).map((f) => f.id)).toEqual([
      'com-rank',
      'sem-rank-nova',
      'sem-rank-velha',
    ])
  })

  it('sem o canal de pin no preload o toggle vira no-op declarado (false)', async () => {
    delete featuresApi.pin
    await expect(setFeaturePinned('f1', true)).resolves.toBe(false)
  })

  it('com o canal presente chama pin/unpin conforme o alvo', async () => {
    const pin = vi.fn().mockResolvedValue(undefined)
    const unpin = vi.fn().mockResolvedValue(undefined)
    featuresApi.pin = pin
    featuresApi.unpin = unpin

    await expect(setFeaturePinned('f1', true)).resolves.toBe(true)
    expect(pin).toHaveBeenCalledWith('f1')
    await expect(setFeaturePinned('f1', false)).resolves.toBe(true)
    expect(unpin).toHaveBeenCalledWith('f1')

    delete featuresApi.pin
    delete featuresApi.unpin
  })
})
