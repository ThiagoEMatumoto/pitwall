import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ControlPill } from '@/features/brand'
import { getNodeIndex, useDesignStore } from '@/store/designStore'
import type { DesignAgentActivity } from '@shared/types/design'

// A session that dies mid-edit never sends 'finish'; entries older than this
// stop being shown so the badge cannot get stuck.
export const ACTIVITY_STALE_MS = 30_000
const TICK_MS = 5_000

const SHIMMER_CSS = `
@keyframes pw-design-shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }
.pw-design-shimmer {
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--color-accent) 22%, transparent) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: pw-design-shimmer 1.6s linear infinite;
}`

export function toolLabel(tool: string): string {
  return tool.replace(/^design_/, '')
}

function useLiveEntries(): DesignAgentActivity[] {
  const activity = useDesignStore((s) => s.agentActivity)
  const [now, setNow] = useState(() => Date.now())
  const all = useMemo(() => Object.values(activity).flat(), [activity])

  useEffect(() => {
    if (all.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [all.length])

  return useMemo(() => all.filter((a) => now - a.at < ACTIVITY_STALE_MS), [all, now])
}

function nodeName(artboardId: string | null, nodeId: string): string {
  const entry = artboardId ? getNodeIndex(artboardId)?.get(nodeId) : undefined
  if (!entry) return nodeId
  return entry.node.name ?? `${entry.node.tag}#${nodeId}`
}

// "Claude editando ▸ Hero · styles_update" while an agent has a tool call in
// flight; click to list the touched nodes. Vanishes on finish (the store
// drops the entries) or when they go stale.
export function AgentActivityBadge() {
  const entries = useLiveEntries()
  const artboards = useDesignStore((s) => s.artboards)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (entries.length === 0) setExpanded(false)
  }, [entries.length])

  if (entries.length === 0) return null

  const latest = entries.reduce((a, b) => (b.at > a.at ? b : a))
  const target = latest.artboardId
    ? (artboards[latest.artboardId]?.meta.name ?? 'artboard')
    : 'documento'
  const nodes = entries.flatMap((a) =>
    a.nodeIds.map((id) => ({
      key: `${a.artboardId ?? '*'}:${id}`,
      label: nodeName(a.artboardId, id),
    })),
  )

  return (
    <div className="relative">
      <style>{SHIMMER_CSS}</style>
      <ControlPill
        icon={Sparkles}
        tone="accent"
        caret={nodes.length > 0}
        label={`Claude editando ▸ ${target} · ${toolLabel(latest.tool)}`}
        title={latest.summary ?? latest.tool}
        onClick={nodes.length > 0 ? () => setExpanded((e) => !e) : undefined}
        className="pw-design-shimmer max-w-[22rem]"
      />
      {expanded && nodes.length > 0 && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] max-w-[20rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs shadow-lg">
          <div className="mb-1 flex items-center gap-1 text-[var(--color-text-dim)]">
            <Icon as={ChevronDown} size={11} />
            {nodes.length} {nodes.length === 1 ? 'nó' : 'nós'} em edição
          </div>
          <ul className="max-h-40 overflow-auto">
            {nodes.map((n) => (
              <li key={n.key} className="truncate py-0.5 text-[var(--color-text)]">
                {n.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
