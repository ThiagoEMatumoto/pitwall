import { useEffect } from 'react'
import { MotherPinToggle } from './MotherPinToggle'
import { useMotherPinsStore } from './mother-pins-store'
import { useSessionGraphStore } from './session-graph-store'

// "Marcar como mãe" no header da sessão. Lê o pin pela conversa (o nó do grafo
// traz o ccSessionId); sessão fora do grafo ainda cai no próprio id.
export function useHeaderMotherPin(sessionId: string) {
  const node = useSessionGraphStore((s) => s.graph.nodes.find((n) => n.sessionId === sessionId))
  const keys = useMotherPinsStore((s) => s.keys)
  const setPinned = useMotherPinsStore((s) => s.setPinned)
  useEffect(() => {
    if (sessionId) void useMotherPinsStore.getState().load()
  }, [sessionId])
  const pinned = keys.includes(node?.ccSessionId ?? sessionId)
  return { pinned, toggle: () => void setPinned(sessionId, !pinned) }
}

export function HeaderMotherPin({ sessionId }: { sessionId: string }) {
  const { pinned, toggle } = useHeaderMotherPin(sessionId)
  return (
    <span data-testid="header-mother-pin" className="flex">
      <MotherPinToggle pinned={pinned} onToggle={toggle} size={13} />
    </span>
  )
}
