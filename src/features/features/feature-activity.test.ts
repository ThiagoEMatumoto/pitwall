import { describe, expect, it } from 'vitest'
import { featureActivity, selectPickableFeatures } from './feature-activity'
import type { Feature } from '../../../shared/types/ipc'

function feat(over: Partial<Feature> & { id: string; lastRecordAt?: number | null }) {
  return {
    projectId: 'p1',
    slug: over.id,
    title: over.id,
    status: 'in-progress' as const,
    objective: null,
    docPath: `/tmp/${over.id}.md`,
    synthMode: 'auto' as const,
    model: null,
    repos: [{ repoId: 'r1', branch: null, worktreePath: null }],
    origin: 'manual' as const,
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
    ...over,
  }
}

describe('featureActivity', () => {
  it('usa o último session record quando existe', () => {
    expect(featureActivity(feat({ id: 'a', updatedAt: 10, lastRecordAt: 50 }))).toBe(50)
  })

  it('cai no updated_at quando não há registro', () => {
    expect(featureActivity(feat({ id: 'a', updatedAt: 10, lastRecordAt: null }))).toBe(10)
    expect(featureActivity(feat({ id: 'a', updatedAt: 10 }))).toBe(10)
  })
})

describe('selectPickableFeatures', () => {
  it('em foco primeiro (na ordem da parede), depois atividade recente', () => {
    const out = selectPickableFeatures([
      feat({ id: 'recent', updatedAt: 100 }),
      feat({ id: 'pin2', updatedAt: 1, pinned: true, focusRank: 2 }),
      feat({ id: 'old', updatedAt: 5 }),
      feat({ id: 'pin1', updatedAt: 0, pinned: true, focusRank: 1 }),
    ])
    expect(out.map((f) => f.id)).toEqual(['pin1', 'pin2', 'recent', 'old'])
  })

  it('exclui arquivadas', () => {
    const out = selectPickableFeatures([
      feat({ id: 'viva' }),
      feat({ id: 'morta', archivedAt: 1 }),
      // Arquivada em foco também sai — a parede já a ignora.
      feat({ id: 'morta-pin', archivedAt: 1, pinned: true }),
    ])
    expect(out.map((f) => f.id)).toEqual(['viva'])
  })

  it('filtra pelo repo quando o consumidor informa', () => {
    const out = selectPickableFeatures(
      [
        feat({ id: 'aqui' }),
        feat({ id: 'la', repos: [{ repoId: 'r2', branch: null, worktreePath: null }] }),
      ],
      { repoId: 'r1' },
    )
    expect(out.map((f) => f.id)).toEqual(['aqui'])
  })

  it('busca por título, sem sensibilidade a caixa', () => {
    const out = selectPickableFeatures(
      [feat({ id: 'a', title: 'Loop das features' }), feat({ id: 'b', title: 'Voz sob demanda' })],
      { query: 'VOZ' },
    )
    expect(out.map((f) => f.id)).toEqual(['b'])
  })

  it('ordena por lastRecordAt quando ele existe (atividade real > metadado)', () => {
    const out = selectPickableFeatures([
      feat({ id: 'metadado', updatedAt: 900, lastRecordAt: null }),
      feat({ id: 'trabalhada', updatedAt: 1, lastRecordAt: 1000 }),
    ])
    expect(out.map((f) => f.id)).toEqual(['trabalhada', 'metadado'])
  })
})
