import { useMemo, useState, type ReactNode } from 'react'
import { Menu } from '@/components/ui/Menu'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import {
  canOpenGraphNode,
  openGraphNode,
  useSessionGraph,
  type OpenContext,
} from './session-graph-store'
import { sessionLinks, type ChildLink } from './session-links'
import { statusDotView } from './status-view'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

// Mais urgente primeiro: é a cor que um chip agregado (N filhas) precisa mostrar.
const URGENCY: Record<SessionGraphNode['status'], number> = {
  waiting: 0,
  working: 1,
  starting: 2,
  idle: 3,
  ended: 4,
}

function dotClass(node: SessionGraphNode): string {
  if (node.attentionReason === 'handoff-input') return 'text-[var(--color-danger)]'
  return statusDotView(node.status).className
}

function mostUrgent(nodes: SessionGraphNode[]): SessionGraphNode {
  const asking = nodes.find((n) => n.attentionReason === 'handoff-input')
  return asking ?? [...nodes].sort((a, b) => URGENCY[a.status] - URGENCY[b.status])[0]
}

function describeNode(node: SessionGraphNode, step?: string | null): string {
  const status =
    node.attentionReason === 'handoff-input'
      ? 'pergunta pendente'
      : statusDotView(node.status).label
  return [`${node.title} (${status.toLowerCase()})`, node.purposeHint, step]
    .filter(Boolean)
    .join(' — ')
}

const CLOSED_HINT = 'Sessão encerrada — nada a abrir'

interface ChipProps {
  testId: string
  dotOf: SessionGraphNode
  title: string
  onClick: () => void
  // Encerrada sem quick look: continua visível (é contexto), mas não finge que abre.
  disabled?: boolean
  // Parte fixa ("⟲ bastão →"): nunca trunca, é ela que diz o que o chip é. O
  // espaço apertado come o nome, não o tipo de relação.
  prefix?: string
  children: ReactNode
}

function Chip({ testId, dotOf, title, onClick, disabled = false, prefix, children }: ChipProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      title={disabled ? `${title}\n${CLOSED_HINT}` : title}
      className="flex aria-disabled:cursor-default aria-disabled:opacity-60 max-w-[180px] shrink items-center gap-1 rounded-full border border-[var(--color-border)] px-1.5 py-px text-[10px] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]"
    >
      <span aria-hidden className={`shrink-0 ${dotClass(dotOf)}`}>
        <span className="block h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      <span className="flex min-w-0">
        {prefix && <span className="shrink-0 whitespace-pre">{`${prefix} `}</span>}
        <span className="min-w-[3ch] truncate">{children}</span>
      </span>
    </button>
  )
}

// Chip de um grupo: com uma sessão só abre direto; com várias, abre a lista.
function GroupChip(props: {
  testId: string
  nodes: SessionGraphNode[]
  prefix?: string
  label: string
  title: string
  openCtx: OpenContext
  steps?: Map<string, string | null>
}) {
  const [open, setOpen] = useState(false)
  const { nodes, openCtx } = props
  const single = nodes.length === 1 ? nodes[0] : null
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      portal
      align="left"
      items={nodes.map((n) => ({
        label: n.title,
        title: describeNode(n, props.steps?.get(n.sessionId)),
        disabled: !canOpenGraphNode(n, openCtx),
        onClick: () => void openGraphNode(n),
      }))}
    >
      <Chip
        testId={props.testId}
        dotOf={mostUrgent(nodes)}
        title={props.title}
        disabled={single != null && !canOpenGraphNode(single, openCtx)}
        onClick={() => (single ? void openGraphNode(single) : setOpen((v) => !v))}
        prefix={props.prefix}
      >
        {props.label}
      </Chip>
    </Menu>
  )
}

// Conta só as filhas vivas; as encerradas ficam num chip à parte ("+N
// encerradas"), pra "3 filhas" não significar 1 trabalhando e 2 mortas.
function childrenChips(children: ChildLink[], openCtx: OpenContext): ReactNode[] {
  const active = children.filter((c) => c.node.status !== 'ended')
  const ended = children.filter((c) => c.node.status === 'ended')
  const chips: ReactNode[] = []
  if (active.length > 0) {
    const nodes = active.map((c) => c.node)
    chips.push(
      <GroupChip
        key="children"
        testId="chip-children"
        nodes={nodes}
        prefix="↓"
        label={nodes.length === 1 ? nodes[0].title : `${nodes.length} filhas`}
        title={[
          'Filhas desta sessão:',
          ...active.map((c) => `• ${describeNode(c.node, c.step)}`),
        ].join('\n')}
        openCtx={openCtx}
        steps={new Map(active.map((c) => [c.node.sessionId, c.step]))}
      />,
    )
  }
  if (ended.length > 0) {
    chips.push(
      <GroupChip
        key="children-ended"
        testId="chip-children-ended"
        nodes={ended.map((c) => c.node)}
        label={`+${ended.length} ${ended.length === 1 ? 'encerrada' : 'encerradas'}`}
        title={[
          'Filhas encerradas:',
          ...ended.map((c) => `• ${describeNode(c.node, c.step)}`),
        ].join('\n')}
        openCtx={openCtx}
        steps={new Map(ended.map((c) => [c.node.sessionId, c.step]))}
      />,
    )
  }
  return chips
}

// Faixa discreta de relações no header do pane: de onde a sessão saiu, quem ela
// delegou, o bastão e as sessões dos repos ligados. O tooltip de cada chip diz do
// que a outra sessão trata — é o que evita ter que lembrar ou perguntar.
export function ConnectedChips({ sessionId }: { sessionId: string }) {
  const graph = useSessionGraph()
  const links = useMemo(() => sessionLinks(graph, sessionId), [graph, sessionId])
  const self = graph.nodes.find((n) => n.sessionId === sessionId)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const liveSessions = useAppStore((s) => s.liveSessions)
  const openCtx = useMemo(() => ({ handoffs, liveSessions }), [handoffs, liveSessions])

  const chips: ReactNode[] = []
  const { mother, baton } = links
  if (mother) {
    const title = [
      `Sessão-mãe: ${describeNode(mother)}`,
      self?.purposeHint && `Tarefa desta sessão: ${self.purposeHint}`,
      links.siblings.length > 0 && `Irmãs: ${links.siblings.map((n) => n.title).join(', ')}`,
    ]
    chips.push(
      <Chip
        key="mother"
        testId="chip-mother"
        dotOf={mother}
        title={title.filter(Boolean).join('\n')}
        disabled={!canOpenGraphNode(mother, openCtx)}
        onClick={() => void openGraphNode(mother)}
        prefix="↑ mãe:"
      >
        {mother.title}
      </Chip>,
    )
  }
  chips.push(...childrenChips(links.children, openCtx))
  if (baton.predecessor) {
    const pred = baton.predecessor
    chips.push(
      <Chip
        key="baton-in"
        testId="chip-baton-in"
        dotOf={pred}
        title={`Esta sessão recebeu o bastão de ${describeNode(pred)}`}
        disabled={!canOpenGraphNode(pred, openCtx)}
        onClick={() => void openGraphNode(pred)}
        prefix="⟲ bastão de"
      >
        {pred.title}
      </Chip>,
    )
  }
  if (baton.successor) {
    const next = baton.successor
    chips.push(
      <Chip
        key="baton-out"
        testId="chip-baton-out"
        dotOf={next}
        title={`Esta sessão passou o bastão para ${describeNode(next)}`}
        disabled={!canOpenGraphNode(next, openCtx)}
        onClick={() => void openGraphNode(next)}
        prefix="⟲ bastão →"
      >
        {next.title}
      </Chip>,
    )
  }
  for (const repo of links.linkedRepoSessions) {
    const count = repo.sessions.length
    chips.push(
      <GroupChip
        key={`repo-${repo.repoId}`}
        testId="chip-repo"
        nodes={repo.sessions}
        prefix="⇄"
        label={count > 1 ? `${repo.repoLabel} · ${count}` : repo.repoLabel}
        openCtx={openCtx}
        title={[
          `Repo ligado: ${repo.repoLabel}`,
          ...repo.sessions.map((n) => `• ${describeNode(n)}`),
        ].join('\n')}
      />,
    )
  }

  if (chips.length === 0) return null
  return (
    <div
      data-testid="connected-chips"
      aria-label="Sessões relacionadas"
      // Piso de largura: sem ele o título (que também trunca) espreme a faixa até
      // sobrar só o prefixo do 1º chip, sem nome nenhum.
      className="flex min-w-[min(100%,11.5rem)] shrink items-center gap-1 overflow-hidden"
    >
      {chips}
    </div>
  )
}
