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
  // Frente da sessão (sessions.feature_id; uma por sessão). Feature arquivada ou
  // inexistente vira null: a sessão cai no agrupamento do projeto.
  featureId?: string | null
  featureTitle?: string | null
  // "Onde parei": resumo sob demanda; desatualizado se lastActivityAt > lastSummaryAt.
  lastSummary: string | null
  lastSummaryAt: number | null
  // Última mensagem humana do transcript (só sem resumo): o "Onde parei" barato.
  lastPrompt?: string | null
  // Handoff em que esta sessão é a filha atual — é o que abre o quick look da
  // crew em vez de uma aba.
  childOfHandoffId: string | null
  // Mãe = tem handoffs vivos (com filha atrelada) apontando pra ela. Vem do
  // mother_session_id atual, então o bastão da mãe move os três de nó.
  isMother?: boolean
  childCount?: number
  // Passou o bastão de mãe (handoff_events 'mother_transferred') e não lidera
  // mais ninguém: segue viva até o humano encerrar.
  batonPassed?: boolean
}

export interface SessionGraphLaneRepo {
  // null = sessões avulsas (sem repo).
  repoId: string | null
  label: string
  // Projeto do repo: o card da feature junta repos de projetos diferentes e mostra
  // o nome do projeto quando ele não é o "home" da feature.
  projectId?: string | null
  projectName?: string | null
  sessionIds: string[]
}

// Nível de topo do mapa. 'feature' = o card da feature (uma lane por repo, de
// qualquer projeto); 'project' = "Sem feature · <Projeto>" (ou as avulsas).
// projectId/name existem nos dois: no card da feature são o projeto "home" e o
// título.
export interface SessionGraphProjectLane {
  kind: 'project'
  projectId: string | null
  name: string
  color: string | null
  repos: SessionGraphLaneRepo[]
}

export interface SessionGraphFeatureLane {
  kind: 'feature'
  featureId: string
  projectId: string
  projectName: string | null
  name: string
  color: string | null
  // Pulso vigente (feature_pulses, o mais recente), 1 linha.
  pulse: string | null
  status: string
  // features.pinned: o foco que o usuário deu na parede.
  pinned: boolean
  repos: SessionGraphLaneRepo[]
}

export type SessionGraphLane = SessionGraphProjectLane | SessionGraphFeatureLane

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

export type SessionGraphEdge =
  | SessionGraphHandoffEdge
  | SessionGraphBatonEdge
  | SessionGraphRepoDepEdge

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
