import { describe, expect, it } from 'vitest'
import type { PullRepoResult } from '../../../shared/types/ipc'
import { formatStuckAlert, isStuck, reposToAlert, STUCK_RUN_THRESHOLD } from './repo-pull-alerts'

// Shapes copiados do que pullRepo devolve de verdade (ver
// repo-pull-detached.integration.test.ts), não inventados.
const detachedStuck: PullRepoResult = {
  repoId: 'lc',
  label: 'legal-core',
  path: '/x/legal-core',
  status: 'pulled',
  detail: 'main: pulled · HEAD: skipped(detached-dirty)',
  branches: [
    { branch: 'main', status: 'pulled', behind: 0 },
    { branch: 'HEAD', status: 'skipped', detail: 'detached-dirty', behind: 480 },
  ],
}
const healthy: PullRepoResult = {
  repoId: 'lc',
  label: 'legal-core',
  path: '/x/legal-core',
  status: 'pulled',
  branches: [
    { branch: 'main', status: 'pulled', behind: 0 },
    { branch: 'HEAD', status: 'reattached', detail: 'abc1234→main', behind: 0 },
  ],
}
const errored: PullRepoResult = {
  repoId: 'at',
  label: 'atelier',
  path: '/x/atelier',
  status: 'error',
  detail: 'origin: error(fatal: could not read from remote)',
  branches: [{ branch: 'origin', status: 'error', detail: 'fatal: could not read from remote' }],
}
const userDirty: PullRepoResult = {
  repoId: 'w',
  label: 'work',
  path: '/x/work',
  status: 'skipped',
  branches: [{ branch: 'main', status: 'skipped', detail: 'dirty', behind: 5 }],
}

describe('isStuck', () => {
  it('erro e pulo estrutural com atraso contam; trabalho do usuário em andamento não', () => {
    expect(isStuck(errored)).toBe(true)
    expect(isStuck(detachedStuck)).toBe(true)
    expect(isStuck(healthy)).toBe(false)
    expect(isStuck(userDirty)).toBe(false)
  })
})

describe('reposToAlert', () => {
  // Simula o loop real: a cada run, o histórico ganha uma entrada no topo e o
  // caller lê threshold+1 runs (como notifyStuckRepos em ipc/git.ts).
  function simulate(sequence: PullRepoResult[]): number[] {
    const history: Array<{ results: PullRepoResult[] }> = []
    const alertedAt: number[] = []
    sequence.forEach((result, i) => {
      history.unshift({ results: [result] })
      const alerts = reposToAlert(history.slice(0, STUCK_RUN_THRESHOLD + 1))
      if (alerts.length > 0) alertedAt.push(i)
    })
    return alertedAt
  }

  it('dispara uma vez na 3ª run travada seguida, não repete, e reseta após recuperar', () => {
    const seq = [
      detachedStuck,
      detachedStuck,
      detachedStuck, // 3ª seguida → avisa (índice 2)
      detachedStuck,
      detachedStuck, // segue travado → não repete
      healthy, // recuperou
      detachedStuck,
      detachedStuck,
      detachedStuck, // nova sequência de 3 → avisa de novo (índice 8)
    ]
    expect(simulate(seq)).toEqual([2, 8])
  })

  it('duas runs travadas e uma boa no meio não disparam', () => {
    expect(simulate([errored, errored, healthy, errored, errored])).toEqual([])
  })

  it('trabalho do usuário (dirty) nunca dispara', () => {
    expect(simulate([userDirty, userDirty, userDirty, userDirty])).toEqual([])
  })

  it('o aviso carrega motivo e atraso da branch travada', () => {
    const runs = [1, 2, 3].map(() => ({ results: [detachedStuck] }))
    expect(reposToAlert(runs)).toEqual([
      { repoId: 'lc', label: 'legal-core', reason: 'detached-dirty', behind: 480 },
    ])
  })
})

describe('formatStuckAlert', () => {
  it('título por repo e corpo com motivo + atraso', () => {
    const { title, body } = formatStuckAlert([
      { repoId: 'lc', label: 'legal-core', reason: 'detached-dirty', behind: 480 },
    ])
    expect(title).toBe('Auto-pull travado em legal-core')
    expect(body).toBe('legal-core: detached-dirty, 480 commits atrás (3 runs seguidas)')
  })
})
