import { describe, expect, it } from 'vitest'
import {
  branchFromTail,
  decideContinuous,
  inheritFeatureId,
  ownedFromSource,
  resolverSource,
  matchFuzzy,
  matchWorktree,
  pickMatch,
} from './feature-session-resolver'

const line = (o: object) => JSON.stringify(o)

describe('feature-session-resolver', () => {
  it('branchFromTail: a branch ATUAL do transcript (voltar para a main é visto)', () => {
    const onFeature = [
      line({ type: 'user', gitBranch: 'main' }),
      line({ type: 'assistant', gitBranch: 'feat/checkout-a' }),
      line({ type: 'user', gitBranch: 'feat/checkout-b' }),
    ]
    expect(branchFromTail(onFeature.join('\n'))).toBe('feat/checkout-b')
    const backToMain = [...onFeature, line({ type: 'user', gitBranch: 'main' })].join('\n')
    expect(branchFromTail(backToMain)).toBe('main')
    expect(branchFromTail(line({ type: 'user' }))).toBeNull()
    expect(branchFromTail(line({ gitBranch: 'HEAD' }))).toBeNull()
  })

  it('matchWorktree: cwd dentro do worktree registrado; a raiz do repo não conta', () => {
    const rows = [
      { featureId: 'root', worktreePath: '/r/api', repoPath: '/r/api' },
      { featureId: 'f1', worktreePath: '/r/api/.worktrees/checkout/', repoPath: '/r/api' },
      { featureId: 'f2', worktreePath: '/r/api/.worktrees/checkout/sub', repoPath: '/r/api' },
    ]
    expect(matchWorktree('/r/api', rows)).toBeNull()
    expect(matchWorktree('/r/api/.worktrees/checkout', rows)).toBe('f1')
    expect(matchWorktree('/r/api/.worktrees/checkout/src', rows)).toBe('f1')
    expect(matchWorktree('/r/api/.worktrees/checkout/sub/x', rows)).toBe('f2')
    expect(matchWorktree('/r/api/.worktrees/checkout-old', rows)).toBeNull()
    expect(matchWorktree(null, rows)).toBeNull()
  })

  it('matchFuzzy: só com o limiar de vínculo (0.75)', () => {
    const features = [
      { id: 'a', title: 'Checkout E2E' },
      { id: 'b', title: 'Painel de métricas novo' },
    ]
    expect(matchFuzzy('vamos fechar o checkout e2e hoje', features)).toBe('a')
    expect(matchFuzzy('o painel está lento', features)).toBeNull()
    expect(matchFuzzy(null, features)).toBeNull()
  })

  it('pickMatch: worktree > branch > fuzzy', () => {
    expect(pickMatch({ byBranch: 'b', byWorktree: 'w', byFuzzy: 'f' })).toEqual({
      featureId: 'w',
      by: 'worktree',
    })
    expect(pickMatch({ byBranch: 'b', byWorktree: null, byFuzzy: 'f' })?.by).toBe('branch')
    expect(pickMatch({ byBranch: null, byWorktree: null, byFuzzy: null })).toBeNull()
  })

  describe('decideContinuous', () => {
    const branch = (featureId: string) => ({ featureId, by: 'branch' as const })

    it('sem feature: vincula ao match', () => {
      expect(decideContinuous({ current: null, owned: null, match: branch('f1') })).toEqual({
        action: 'set',
        featureId: 'f1',
      })
    })

    it('vínculo do resolvedor migra quando a branch muda de feature', () => {
      expect(decideContinuous({ current: 'f1', owned: branch('f1'), match: branch('f2') })).toEqual(
        { action: 'set', featureId: 'f2' },
      )
    })

    it('vínculo manual (Mover para feature…) vence a heurística', () => {
      expect(decideContinuous({ current: 'manual', owned: null, match: branch('f2') })).toEqual({
        action: 'keep',
      })
      // O resolvedor já tinha posto f1, mas o usuário moveu pra outra: não é mais dele.
      expect(
        decideContinuous({ current: 'manual', owned: branch('f1'), match: branch('f2') }),
      ).toEqual({ action: 'keep' })
    })

    it('sinal sumiu: solta o vínculo de branch/worktree, mantém o fuzzy', () => {
      expect(decideContinuous({ current: 'f1', owned: branch('f1'), match: null })).toEqual({
        action: 'set',
        featureId: null,
      })
      expect(
        decideContinuous({ current: 'f1', owned: { featureId: 'f1', by: 'fuzzy' }, match: null }),
      ).toEqual({ action: 'keep' })
      expect(decideContinuous({ current: null, owned: null, match: null })).toEqual({
        action: 'keep',
      })
    })
  })

  describe('origem persistida (sessions.feature_source)', () => {
    it('só o que o resolvedor pôs é dele, e sobrevive ao restart (vem do banco)', () => {
      expect(ownedFromSource('f1', resolverSource('branch'))).toEqual({ featureId: 'f1', by: 'branch' })
      expect(ownedFromSource('f1', resolverSource('worktree'))).toEqual({
        featureId: 'f1',
        by: 'worktree',
      })
      expect(ownedFromSource('f1', 'manual')).toBeNull()
      expect(ownedFromSource('f1', null)).toBeNull()
      expect(ownedFromSource(null, resolverSource('branch'))).toBeNull()
    })

    it('depois do restart a troca de branch ainda migra o vínculo do resolvedor', () => {
      const owned = ownedFromSource('f1', resolverSource('branch'))
      expect(
        decideContinuous({ current: 'f1', owned, match: { featureId: 'f2', by: 'branch' } }),
      ).toEqual({ action: 'set', featureId: 'f2' })
    })

    it('"Sem feature" escolhido pelo usuário não é revinculado pela heurística', () => {
      expect(
        decideContinuous({
          current: null,
          owned: null,
          manual: true,
          match: { featureId: 'f1', by: 'branch' },
        }),
      ).toEqual({ action: 'keep' })
    })

    it('confirmar a mesma feature que o resolvedor pôs a torna do usuário', () => {
      expect(
        decideContinuous({
          current: 'f1',
          owned: null,
          manual: true,
          match: { featureId: 'f2', by: 'branch' },
        }),
      ).toEqual({ action: 'keep' })
    })
  })

  it('inheritFeatureId: explícito > feature da mãe', () => {
    expect(inheritFeatureId('x', 'mae')).toBe('x')
    expect(inheritFeatureId(null, 'mae')).toBe('mae')
    expect(inheritFeatureId(undefined, null)).toBeNull()
  })
})
