import { describe, expect, it } from 'vitest'
import {
  buildRepoArchitectureContent,
  type ArchEdge,
} from './repo-architecture'

describe('buildRepoArchitectureContent', () => {
  const edges: ArchEdge[] = [
    {
      kind: 'calls-api',
      label: null,
      direction: 'outgoing',
      other: { label: 'backend', role: 'API REST' },
    },
    {
      kind: 'work-hub',
      label: null,
      direction: 'incoming',
      other: { label: 'ops-hub', role: 'hub' },
    },
  ]

  const block = buildRepoArchitectureContent({
    repo: { label: 'frontend', role: 'SPA' },
    edges,
  })

  it('monta o cabeçalho e o papel do repo', () => {
    expect(block).toContain('## Arquitetura deste repo (frontend)')
    expect(block).toContain('- papel: SPA')
  })

  it('descreve a aresta outgoing com este repo como sujeito', () => {
    // calls-api outgoing: este repo consome a API do vizinho
    expect(block).toContain(
      'este repo (frontend) consome a API o repo backend (API REST)',
    )
  })

  it('descreve a aresta incoming com o vizinho como sujeito', () => {
    // work-hub incoming: o vizinho coordena o trabalho sobre este repo
    expect(block).toContain(
      'o repo ops-hub (hub) coordena o trabalho sobre este repo (frontend)',
    )
  })

  it('inclui a instrução de preferir session_handoff', () => {
    expect(block).toContain('session_handoff')
    expect(block).toContain('repo_connections_get')
    // O gate humano saiu na v0.53: o texto não pode prometer aprovação que não existe.
    expect(block).not.toContain('gate humano')
    expect(block).toContain('sem aprovação')
  })

  it('retorna null quando não há arestas', () => {
    expect(
      buildRepoArchitectureContent({ repo: { label: 'x', role: null }, edges: [] }),
    ).toBeNull()
  })

  it('usa "—" quando o papel é nulo', () => {
    const b = buildRepoArchitectureContent({
      repo: { label: 'x', role: null },
      edges: [
        {
          kind: 'depends-on',
          label: null,
          direction: 'outgoing',
          other: { label: 'lib', role: null },
        },
      ],
    })
    expect(b).toContain('- papel: —')
    // sem role do vizinho, não há parênteses de papel
    expect(b).toContain('este repo (x) depende de o repo lib')
  })
})
