import type { AgentProviderId, HandoffStatus } from './ipc'

// As sessões como um sistema conectado: quem delegou pra quem, quem herdou o
// bastão de quem e quais repos trabalham juntos. Base do mapa (P8) e dos chips de
// relação no header do pane.

export type SessionGraphStatus = 'starting' | 'working' | 'waiting' | 'idle' | 'ended'

// Por que a sessão precisa de você agora. null = não precisa.
export type SessionGraphAttention = 'handoff-input' | 'waiting'

export interface SessionGraphNode {
  sessionId: string
  ccSessionId: string | null
  // Mesma precedência do nome da aba: rename manual > nome vivo do CLI > título
  // salvo > label do repo.
  title: string
  // Nome vivo do CLI (o `-n`): o endereço do SendMessage, que o rename não muda.
  cliName?: string | null
  projectId: string | null
  repoId: string | null
  repoLabel: string | null
  provider: AgentProviderId
  status: SessionGraphStatus
  attentionReason: SessionGraphAttention | null
  lastActivityAt: number | null
  // sessions.started_at / ended_at: o filtro do mapa ("Ativas", "Hoje") decide por
  // quando a sessão encerrada foi vista pela última vez.
  startedAt?: number
  endedAt?: number | null
  // Do que a sessão se trata: a tarefa do handoff quando é filha. null por ora
  // nas demais (a P8 completa).
  purposeHint: string | null
  // Memória de trabalho (P8). Propósito por precedência: edição do usuário ou da
  // própria sessão (MCP) > tarefa do handoff > 1º prompt humano do transcript.
  purpose: string | null
  purposeSource: 'user' | 'handoff' | 'transcript' | null
  // Grupo do usuário no mapa (session_groups.id).
  groupId: string | null
  // "Onde parei": resumo sob demanda; desatualizado se lastActivityAt > lastSummaryAt.
  lastSummary: string | null
  lastSummaryAt: number | null
  // Última mensagem humana do transcript (só sem resumo): o "Onde parei" barato.
  lastPrompt?: string | null
  // Handoff em que esta sessão é a filha atual — é o que abre o quick look da
  // crew em vez de uma aba.
  childOfHandoffId: string | null
}

export interface SessionGraphLaneRepo {
  // null = sessões avulsas (sem repo).
  repoId: string | null
  label: string
  sessionIds: string[]
}

export interface SessionGraphLane {
  projectId: string | null
  name: string
  color: string | null
  repos: SessionGraphLaneRepo[]
}

export interface SessionGraphHandoffEdge {
  kind: 'handoff'
  from: string
  to: string
  handoffId: string
  handoffStatus: HandoffStatus
  currentStep: string | null
  createdAt: number
}

// predecessor_session_id → child_session_id do MESMO handoff: a sucessora
// assumiu o papel da antecessora (que segue viva até o humano encerrar).
export interface SessionGraphBatonEdge {
  kind: 'baton'
  from: string
  to: string
  handoffId: string
}

// Um fio por par de repos ligados (não um por par de sessões), só com sessões
// vivas dos dois lados.
export interface SessionGraphRepoDepEdge {
  kind: 'repoDep'
  fromRepoId: string
  toRepoId: string
  depKinds: string[]
  fromSessionIds: string[]
  toSessionIds: string[]
}

// Sessões que trabalharam na mesma feature (≥ 2).
export interface SessionGraphFeatureEdge {
  kind: 'feature'
  featureId: string
  sessionIds: string[]
}

export type SessionGraphEdge =
  | SessionGraphHandoffEdge
  | SessionGraphBatonEdge
  | SessionGraphRepoDepEdge
  | SessionGraphFeatureEdge

export interface SessionGraph {
  nodes: SessionGraphNode[]
  lanes: SessionGraphLane[]
  edges: SessionGraphEdge[]
}

export interface HandoffEvent {
  id: string
  handoffId: string
  fromStatus: string | null
  toStatus: string
  event: string
  detail: string | null
  at: number
}
