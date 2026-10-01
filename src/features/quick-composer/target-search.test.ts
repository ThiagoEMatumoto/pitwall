import { describe, expect, it } from 'vitest'
import { aliasOf, buildTargets, defaultWhen, searchTargets, type SendTarget } from './target-search'
import type { LiveSessionInfo, Repo } from '../../../shared/types/ipc'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

function repo(path: string, label: string): Repo {
  return { id: `r-${label}`, projectId: 'p', label, path } as Repo
}

function live(over: Partial<LiveSessionInfo>): LiveSessionInfo {
  return {
    id: 'pty-1',
    ccSessionId: 'cc-1',
    name: null,
    title: null,
    status: 'idle',
    repo: repo('/repos/alpha', 'alpha'),
    projectName: 'Alpha',
    projectIcon: null,
    projectColor: '#f00',
    lastActivityAt: null,
    lastText: null,
    ...over,
  }
}

function node(over: Partial<SessionGraphNode>): SessionGraphNode {
  return {
    sessionId: 'pty-1',
    ccSessionId: 'cc-1',
    title: 'x',
    projectId: null,
    repoId: null,
    repoLabel: null,
    provider: 'claude',
    status: 'idle',
    attentionReason: null,
    lastActivityAt: null,
    purposeHint: null,
    purpose: null,
    purposeSource: null,
    childOfHandoffId: null,
    ...over,
  } as SessionGraphNode
}

describe('aliasOf', () => {
  it('vira slug sem acento, espaço nem ponto', () => {
    expect(aliasOf('Maurício Refactor v2.1')).toBe('mauricio-refactor-v2-1')
    expect(aliasOf('  api  ')).toBe('api')
  })
})

describe('buildTargets', () => {
  it('usa o nome da sessão como alias, o repo como cwd e o propósito do grafo', () => {
    const [t] = buildTargets(
      [live({ name: 'mauricio', title: 'Refatorar auth' })],
      [node({ purpose: 'Tokens rotativos no auth', purposeHint: 'antigo' })],
    )
    expect(t).toMatchObject({
      sessionId: 'pty-1',
      alias: 'mauricio',
      label: 'Refatorar auth',
      cwd: '/repos/alpha',
      purpose: 'Tokens rotativos no auth',
      projectName: 'Alpha',
    })
  })

  it('sem propósito cai no purposeHint', () => {
    const [t] = buildTargets([live({})], [node({ purposeHint: 'tarefa do handoff' })])
    expect(t.purpose).toBe('tarefa do handoff')
  })

  it('encerradas ficam de fora', () => {
    expect(buildTargets([live({ status: 'ended' })], [])).toEqual([])
  })

  it('sem nome, o alias sai do rótulo (título ou repo)', () => {
    const [t] = buildTargets([live({})], [])
    expect(t.alias).toBe('alpha')
  })

  it('duas sessões com o mesmo nome ganham alias únicos (cada item do menu resolve uma)', () => {
    const ts = buildTargets(
      [
        live({ id: 'aaaa1111-x', ccSessionId: 'c1' }),
        live({ id: 'bbbb2222-y', ccSessionId: 'c2' }),
        live({ id: 'cccc3333-z', ccSessionId: 'c3', name: 'api' }),
      ],
      [],
    )
    expect(ts.map((t) => t.alias)).toEqual(['alpha-aaaa', 'alpha-bbbb', 'api'])
  })

  it('o cwd é o da sessão (worktree), não o checkout do repo', () => {
    const [t] = buildTargets([live({ cwd: '/repos/alpha/.worktrees/feat-x' })], [])
    expect(t.cwd).toBe('/repos/alpha/.worktrees/feat-x')
  })
})

describe('searchTargets', () => {
  const targets: SendTarget[] = buildTargets(
    [
      live({ id: 'a', ccSessionId: 'a', name: 'api', status: 'working' }),
      live({ id: 'b', ccSessionId: 'b', name: 'mauricio', projectName: 'Beta' }),
      live({ id: 'c', ccSessionId: 'c', name: 'otavio', status: 'waiting' }),
    ],
    [],
  )

  it('casa alias, projeto e propósito', () => {
    expect(searchTargets('mau', targets).map((t) => t.alias)).toEqual(['mauricio'])
    expect(searchTargets('beta', targets).map((t) => t.alias)).toEqual(['mauricio'])
  })

  it('sem query lista quem pode receber primeiro (esperando, ocioso, trabalhando)', () => {
    expect(searchTargets('', targets).map((t) => t.alias)).toEqual(['otavio', 'mauricio', 'api'])
  })
})

describe('defaultWhen', () => {
  it('agora se ociosa e sem menu, senão quando terminar', () => {
    const [t] = buildTargets([live({})], [])
    expect(defaultWhen(t, false)).toBe('now')
    expect(defaultWhen(t, true)).toBe('on-idle')
    expect(defaultWhen({ ...t, status: 'working' }, false)).toBe('on-idle')
    expect(defaultWhen({ ...t, attentionReason: 'permission' }, false)).toBe('on-idle')
  })
})
