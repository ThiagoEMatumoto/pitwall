import { describeEdge } from './kind-phrase'

// Builder PURO (sem I/O) do bloco conciso de arquitetura injetado no system-prompt
// de TODA sessão lançada num repo — pra a sessão já saber o lugar do repo no
// sistema e preferir handoff pra trabalho cross-repo. O wrapper I/O vive em
// ../../ipc/repo-architecture-context.ts.

export interface ArchEdge {
  kind: string
  label: string | null
  // 'outgoing': este repo → vizinho. 'incoming': vizinho → este repo.
  direction: 'outgoing' | 'incoming'
  other: { label: string; role: string | null }
}

export interface BuildRepoArchitectureArgs {
  repo: { label: string; role: string | null }
  edges: ArchEdge[]
}

// Markdown do bloco. Retorna null se o repo não tem conexões (não inflar tokens).
// Reusa describeEdge do módulo compartilhado: aqui o SUJEITO é ESTE repo. Mapeio
// a orientação pro vocabulário do describeEdge (que fala em "repo-mãe" vs "este
// repo"): pra outgoing, este repo é o sujeito → 'to-mother' com o vizinho como
// "mãe"; pra incoming, o vizinho é o sujeito → 'from-mother'. Assim a frase nomeia
// o vizinho e mantém este repo como "(<label>)".
export function buildRepoArchitectureContent(
  args: BuildRepoArchitectureArgs,
): string | null {
  if (args.edges.length === 0) return null

  const lines: string[] = [
    `## Arquitetura deste repo (${args.repo.label})`,
    `- papel: ${args.repo.role ?? '—'}`,
  ]
  for (const edge of args.edges) {
    const otherLabel = edge.other.role
      ? `${edge.other.label} (${edge.other.role})`
      : edge.other.label
    const sentence = describeEdge(
      {
        kind: edge.kind,
        label: edge.label,
        direction: edge.direction === 'outgoing' ? 'to-mother' : 'from-mother',
      },
      otherLabel,
      args.repo.label,
    )
    lines.push(`- ${sentence}`)
  }
  lines.push(
    '→ Para trabalho que toque esses repos, prefira a MCP tool `session_handoff` ' +
      '(a filha nasce direto no repo, sem aprovação) em vez de pesquisar/editar neles direto; use ' +
      '`repo_connections_get` para detalhes das conexões.',
  )
  return lines.join('\n')
}
