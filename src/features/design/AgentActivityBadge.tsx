import { useEffect, useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { ControlPill } from '@/features/brand'
import { getNodeIndex, useDesignStore } from '@/store/designStore'
import type { DesignAgentActivity } from '@shared/types/design'
import { actionLabel, targetName as presenceName } from './canvas/agent-presence'
import { rowLabel } from './sidebar/LayerRow'

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

// The same label the Layers panel shows; the root row carries the artboard.
function targetName(a: DesignAgentActivity, artboardName: string | undefined): string {
  if (!a.artboardId) return 'documento'
  const name = artboardName ?? 'artboard'
  const index = getNodeIndex(a.artboardId)
  const entry = a.nodeIds.length ? index?.get(a.nodeIds[0]) : undefined
  if (!entry || entry.parentId === null) return name
  const label = presenceName({ node: entry.node, label: rowLabel(entry.node) }, name)
  return a.nodeIds.length > 1 ? `${label} +${a.nodeIds.length - 1}` : label
}

// "Claude · ajustando estilo · Hero" while an agent has a tool call in
// flight; click jumps to what it is touching. Vanishes on finish (the store
// drops the entries) or when they go stale.
export function AgentActivityBadge() {
  const entries = useLiveEntries()
  const artboards = useDesignStore((s) => s.artboards)

  if (entries.length === 0) return null

  const latest = entries.reduce((a, b) => (b.at > a.at ? b : a))
  const artboardName = latest.artboardId ? artboards[latest.artboardId]?.meta.name : undefined
  const label = `Claude · ${actionLabel(latest.tool)} · ${targetName(latest, artboardName)}`

  const goThere = (): void => {
    const s = useDesignStore.getState()
    const artboardId = latest.artboardId
    if (!artboardId || !s.artboards[artboardId]) return
    const index = getNodeIndex(artboardId)
    const nodeIds = latest.nodeIds.filter((id) => index?.get(id)?.parentId != null)
    s.select(artboardId, nodeIds)
    if (nodeIds.length) void s.fitToSelection()
    else s.fitToArtboard(artboardId)
  }

  return (
    <div className="relative min-w-0">
      <style>{SHIMMER_CSS}</style>
      <ControlPill
        icon={Sparkles}
        tone="accent"
        label={label}
        title={latest.summary ?? 'Ir para onde o Claude está editando'}
        onClick={latest.artboardId ? goThere : undefined}
        className="pw-design-shimmer max-w-[min(22rem,100%)]"
      />
    </div>
  )
}
