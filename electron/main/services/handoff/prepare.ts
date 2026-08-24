// Preparo do REGISTRO de um handoff: resolve repo-alvo, origem, arestas, apelido
// e briefing, e persiste. É a parte comum entre os dois caminhos que criam filha
// sem MCP — a criação manual pelo diálogo de nova sessão (handoffs:create-manual)
// e a ADOÇÃO de uma sessão já aberta (services/handoff/adopt).
//
// Mora aqui, e não no handler de IPC, porque duplicar a composição significaria
// duas versões do briefing divergindo em silêncio: quem adota veria um prompt
// diferente de quem cria do zero, sem ninguém perceber até a filha se comportar
// diferente. O que NÃO está aqui é o spawn — cada caminho sobe a filha do seu
// jeito (a manual spawna nova, a adoção relança por --resume).

import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { broadcast } from '../notify'
import * as store from '../handoff-store'
import * as repoDepStore from '../repo-dependency-store'
import { buildHandoffAlias, roleForHandoffMode } from './alias'
import { composeHandoffPrompt, type HandoffEdge } from './compose-prompt'
import type { Handoff, HandoffMode } from '../../../../shared/types/ipc'

export interface PrepareHandoffInput {
  targetRepoId: string
  // Mãe EXPLÍCITA (sessions.id): quem cria a filha escolhe no picker — nada de
  // inferir do foco, que é o tipo de palpite que só se descobre errado depois.
  motherSessionId: string
  task: string
  featureId?: string | null
  mode?: HandoffMode
  // Contexto livre persistido em handoffs.context_json. A adoção usa pra
  // registrar de qual sessão veio a filha (a origem some do resto do modelo:
  // child_session_id passa a apontar pra sessão RELANÇADA).
  context?: Record<string, unknown> | null
}

export interface PreparedHandoff {
  handoff: Handoff
  // O alias NÃO vive no registro do handoff: ele só se fixa em sessions.title
  // quando a filha sobe. Volta aqui porque quem sobe a filha precisa dele.
  alias: string
}

// Cria o handoff (status pending) e devolve o apelido resolvido. Não spawna nada
// e não mata nada — só toca a tabela handoffs e emite o broadcast de UI.
export function prepareHandoff(input: PrepareHandoffInput): PreparedHandoff {
  const db = getDb()
  const target = db.prepare('SELECT id, label, path FROM repos WHERE id = ?').get(
    input.targetRepoId,
  ) as { id: string; label: string; path: string } | undefined
  if (!target) throw new Error(`Repo-alvo não encontrado: ${input.targetRepoId}`)

  // Repo da mãe: orienta o briefing ("de onde vem o trabalho") e a
  // instrumentação cross-repo. Sessão avulsa (sem repo) ou mãe no MESMO repo →
  // null, e o compose cai no rótulo genérico 'origem'.
  const motherRow = db.prepare('SELECT repo_id FROM sessions WHERE id = ?').get(
    input.motherSessionId,
  ) as { repo_id: string | null } | undefined
  const fromRepoId = motherRow?.repo_id ?? null
  const crossRepo = fromRepoId !== null && fromRepoId !== target.id
  const fromRepo = crossRepo
    ? (db.prepare('SELECT label FROM repos WHERE id = ?').get(fromRepoId) as
        | { label: string }
        | undefined)
    : undefined

  // Arestas REAIS entre mãe e alvo (mesmo insumo do despacho por MCP). Mãe no
  // próprio repo ou sem dependência registrada → lista vazia; não inventamos
  // relação que o grafo não tem.
  const edges: HandoffEdge[] = crossRepo
    ? repoDepStore
        .listByRepo(target.id)
        .filter((e) => e.fromRepoId === fromRepoId || e.toRepoId === fromRepoId)
        .map((e) => ({
          kind: e.kind,
          label: e.label,
          direction: e.fromRepoId === target.id ? 'to-mother' : 'from-mother',
        }))
    : []

  const featureTitle = input.featureId
    ? ((
        db.prepare('SELECT title FROM features WHERE id = ?').get(input.featureId) as
          | { title: string }
          | undefined
      )?.title ?? null)
    : null

  // Id gerado ANTES do compose porque o briefing embute o handoffId (é por ele
  // que a filha reporta de volta).
  const id = randomUUID()
  const mode = input.mode ?? 'interactive'
  // Alias resolvido AQUI (e não no create) porque a unicidade é contra as
  // sessões vivas AGORA — mesmo caminho do handoffs:spawn-context.
  const alias = buildHandoffAlias({
    role: roleForHandoffMode(mode),
    task: input.task,
    taken: store.activeSessionNames(),
  })
  const composedPrompt = composeHandoffPrompt({
    targetRepoLabel: target.label,
    targetRepoPath: target.path,
    motherRepoLabel: fromRepo?.label,
    task: input.task,
    edges,
    featureTitle,
    handoffId: id,
    alias,
    mode,
  })

  const handoff = store.create({
    id,
    motherSessionId: input.motherSessionId,
    targetRepoId: target.id,
    fromRepoId,
    featureId: input.featureId ?? null,
    task: input.task,
    contextJson: input.context ? JSON.stringify(input.context) : null,
    composedPrompt,
    mode,
  })
  broadcast('handoff:updated', handoff)
  return { handoff, alias }
}
