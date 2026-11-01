import { useEffect, useState } from 'react'
import { designApi, diagramsApi } from '@/lib/ipc'
import type { DesignAgentActivity, DesignLink } from '@shared/types/design'
import type { DiagramLink } from '@shared/types/ipc'
import type { ArtifactRef } from './artifact-refs'

// Sessões ligadas a um artefato: as que o escreveram (link 'session', gravado
// pelas tools MCP) e, no design, as que estão escrevendo agora (a activity
// carrega o sessionId mesmo num documento antigo, anterior aos links).
// A mais recente vem primeiro.
export function useLinkedSessions(ref: ArtifactRef | null): string[] {
  const [linked, setLinked] = useState<string[]>([])
  const [active, setActive] = useState<string[]>([])
  const kind = ref?.kind
  const id = ref?.id

  useEffect(() => {
    setLinked([])
    setActive([])
    if (!kind || !id) return
    let disposed = false
    const fromLinks = (links: Array<{ parentType: string; parentId: string }>) =>
      links.filter((l) => l.parentType === 'session').map((l) => l.parentId)

    if (kind === 'diagram') {
      void diagramsApi.get(id).then((d) => {
        if (!disposed && d) setLinked(fromLinks(d.links))
      })
      const off = diagramsApi.onLinksUpdated((payload) => {
        const e = payload as { diagramId?: string; links?: DiagramLink[] }
        if (e?.diagramId === id && e.links) setLinked(fromLinks(e.links))
      })
      return () => {
        disposed = true
        off()
      }
    }

    void designApi.documentGet(id).then((doc) => {
      if (!disposed && doc) setLinked(fromLinks(doc.links))
    })
    const offLinks = designApi.onLinksUpdated((payload) => {
      const e = payload as { docId?: string; links?: DesignLink[] }
      if (e?.docId === id && e.links) setLinked(fromLinks(e.links))
    })
    const offActivity = designApi.onAgentActivity((payload) => {
      const a = payload as DesignAgentActivity
      if (a?.docId !== id || !a.sessionId) return
      const sid = a.sessionId
      setActive((prev) => [sid, ...prev.filter((s) => s !== sid)])
    })
    return () => {
      disposed = true
      offLinks()
      offActivity()
    }
  }, [kind, id])

  return [...active, ...linked.filter((s) => !active.includes(s))]
}
