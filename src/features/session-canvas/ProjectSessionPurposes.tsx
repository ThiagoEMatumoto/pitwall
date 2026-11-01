import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useSessionGraph } from '@/features/sessions/session-graph-store'
import { useAppStore } from '@/store/appStore'
import { MotherPinToggle } from '@/features/sessions/MotherPinToggle'
import { useMotherPinsStore } from '@/features/sessions/mother-pins-store'
import { SessionArtifactChips } from '@/features/sessions/chat/artifacts/SessionArtifactChips'
import {
  buildSessionTree,
  childrenSummary,
  visibleChildren,
  type SessionTreeItem,
} from './session-hierarchy'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

// Sessões vivas do projeto na sidebar, com a linha de PROPÓSITO embaixo — pra não
// depender de lembrar (ou perguntar) do que se tratava cada uma. Mães no topo e
// cada uma com as filhas aninhadas, recolhidas por padrão: com 5 mães × 3 filhas
// a lista plana enterrava justamente quem precisava de você. Filha que precisa
// de você fica à vista mesmo com o grupo recolhido.
export function ProjectSessionPurposes({ projectId }: { projectId: string }) {
  const graph = useSessionGraph()
  // Mães marcadas no topo; o resto na ordem da árvore.
  const tree = useMemo(() => {
    const roots = buildSessionTree(graph.nodes, projectId)
    return [
      ...roots.filter((r) => r.node?.isPinnedMother),
      ...roots.filter((r) => !r.node?.isPinnedMother),
    ]
  }, [graph, projectId])
  const total = useMemo(
    () => tree.reduce((acc, r) => acc + Number(!!r.node) + r.descendants, 0),
    [tree],
  )
  if (tree.length === 0) return null

  return (
    <div className="ml-4 mt-1 border-t border-[var(--color-border)]/40 pt-1">
      <div className="px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
        Sessões ({total})
      </div>
      <ul className="flex flex-col gap-px text-xs">
        {tree.map((item) => (
          <SessionTreeRow key={item.sessionId} item={item} depth={0} />
        ))}
      </ul>
    </div>
  )
}

function SessionTreeRow({ item, depth }: { item: SessionTreeItem; depth: number }) {
  const [expanded, setExpanded] = useState(false)
  const shown = visibleChildren(item, expanded)
  const hasChildren = item.children.length > 0

  return (
    <li data-testid="sidebar-session-item" data-session-id={item.sessionId} data-depth={depth}>
      {item.node ? (
        <>
          <div className="group flex min-w-0 items-start gap-0.5">
            <SessionButton node={item.node} needsYou={item.needsYou} />
            <MotherPinToggle
              pinned={item.node.isPinnedMother === true}
              onToggle={() =>
                void useMotherPinsStore
                  .getState()
                  .setPinned(item.node!.sessionId, !item.node!.isPinnedMother)
              }
              size={11}
              className={
                item.node.isPinnedMother
                  ? 'mt-0.5'
                  : 'mt-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
              }
            />
          </div>
          <SessionArtifactChips sessionId={item.sessionId} />
        </>
      ) : (
        <div
          data-testid="sidebar-session-ghost-mother"
          className="truncate px-1 py-1 text-[var(--color-text-dim)]"
          title="A mãe destas filhas não está viva neste projeto"
        >
          {item.title} <span className="text-[10px]">(mãe encerrada)</span>
        </div>
      )}
      {hasChildren && (
        <button
          type="button"
          data-testid="sidebar-session-children-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="ml-1 flex items-center gap-1 rounded px-1 text-[10px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <Icon as={expanded ? ChevronDown : ChevronRight} size={10} />
          <span data-testid="sidebar-session-children-summary">{childrenSummary(item)}</span>
        </button>
      )}
      {shown.length > 0 && (
        <ul
          data-testid="sidebar-session-children"
          className="ml-2 flex flex-col gap-px border-l border-[var(--color-border)] pl-2"
        >
          {shown.map((c) => (
            <SessionTreeRow key={c.sessionId} item={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

function attentionLabel(node: SessionGraphNode): string | null {
  if (node.attentionReason === 'handoff-input') return 'pergunta'
  if (node.attentionReason === 'waiting') return 'precisa de você'
  return null
}

function SessionButton({ node, needsYou }: { node: SessionGraphNode; needsYou: boolean }) {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const live = liveSessions.find((s) => s.id === node.sessionId)
  const badge = attentionLabel(node)
  return (
    <button
      type="button"
      data-testid="sidebar-session"
      data-session-id={node.sessionId}
      data-needs-you={needsYou ? 'true' : undefined}
      disabled={!live}
      onClick={() => live && void focusOrOpenSession(live)}
      title={node.purpose ?? undefined}
      className={`flex w-full min-w-0 flex-col rounded px-1 py-1 text-left transition hover:bg-[var(--color-surface-2)] ${
        needsYou ? 'bg-[var(--color-warning)]/10' : ''
      }`}
    >
      <span className="flex min-w-0 items-center gap-1 text-[var(--color-text)]">
        <span className="truncate">
          {node.title}
          {node.repoLabel && (
            <span className="text-[var(--color-text-dim)]"> · {node.repoLabel}</span>
          )}
        </span>
        {badge && (
          <span
            data-testid="sidebar-session-attention"
            className="shrink-0 rounded-full border border-[var(--color-warning)] px-1.5 text-[10px] leading-4 text-[var(--color-warning)]"
          >
            {badge}
          </span>
        )}
      </span>
      {node.purpose && (
        <span
          data-testid="sidebar-session-purpose"
          className="truncate text-[11px] text-[var(--color-text-dim)]"
        >
          {node.purpose}
        </span>
      )}
    </button>
  )
}
