import { describe, expect, it } from 'vitest'
import {
  duplicateCandidate,
  issueAction,
  OKR_MISSING,
  selectTriage,
  sortIssues,
  withOkrIssue,
  type FeatureIssue,
} from './feature-issues'

const issue = (over: Partial<FeatureIssue>): FeatureIssue => ({
  level: 'warn',
  code: 'pulse_missing',
  message: 'Sem pulso.',
  ...over,
})

describe('feature-issues', () => {
  it('ordena por nível (error → warn → info) preservando a ordem interna', () => {
    const sorted = sortIssues([
      issue({ level: 'info', code: 'no_repo_linked' }),
      issue({ level: 'warn', code: 'pulse_missing' }),
      issue({ level: 'error', code: 'pulse_too_long' }),
      issue({ level: 'warn', code: 'objective_missing' }),
    ])
    expect(sorted.map((i) => i.code)).toEqual([
      'pulse_too_long',
      'pulse_missing',
      'objective_missing',
      'no_repo_linked',
    ])
  })

  it('duplicate_suspect sem candidateId não vira ação (não há pra onde levar)', () => {
    expect(duplicateCandidate(issue({ code: 'duplicate_suspect' }))).toBeNull()
    expect(
      duplicateCandidate(
        issue({ code: 'duplicate_suspect', candidateId: 'f9', candidateTitle: 'Extração TRF4' }),
      ),
    ).toEqual({ id: 'f9', title: 'Extração TRF4' })
  })

  it('cada code conhecido tem uma ação concreta', () => {
    expect(issueAction('duplicate_suspect')).toBe('open-candidate')
    expect(issueAction('pulse_missing')).toBe('edit-pulse')
    expect(issueAction('objective_missing')).toBe('edit-objective')
    expect(issueAction(OKR_MISSING)).toBe('link-okr')
    expect(issueAction('metric_point_orphan')).toBeNull()
  })

  it('a issue de OKR é sintetizada só quando falta vínculo e o backend calou', () => {
    expect(withOkrIssue([], 0).map((i) => i.code)).toEqual([OKR_MISSING])
    expect(withOkrIssue([], 2)).toEqual([])
    const fromBackend = issue({ level: 'warn', code: 'objective_link_missing' })
    expect(withOkrIssue([fromBackend], 0)).toEqual([fromBackend])
  })

  it('a fila de triagem junta auto-criadas e suspeitas de duplicata', () => {
    const feats = [
      { id: 'a', origin: 'auto' },
      { id: 'b', origin: 'manual' },
      { id: 'c', origin: 'manual' },
    ]
    expect(selectTriage(feats, new Set(['c'])).map((f) => f.id)).toEqual(['a', 'c'])
  })
})
