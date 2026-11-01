import { useEffect, useState } from 'react'
import { designApi, diagramsApi } from '@/lib/ipc'
import { thumbUrl } from '@shared/design/thumb-url'
import type { Diagram } from '@shared/types/ipc'
import type {
  DesignAgentActivity,
  DesignDocument,
  DesignThumbnailUpdatedEvent,
} from '@shared/types/design'
import { loadExcalidrawUtils } from '@/features/diagrams/excalidraw-lazy'
import { renderThumbnail } from '@/features/diagrams/diagram-thumbnail'
import type { ArtifactRef } from './artifact-refs'

export interface ArtifactLive {
  status: 'loading' | 'ready' | 'missing'
  title: string | null
  thumbnail: string | null
  editing: boolean
  // Muda a cada escrita: o painel lateral usa como chave de re-render.
  revision: number
  // Design: o artboard que o Claude tocou por último (o painel abre nele).
  focusArtboardId: string | null
}

const INITIAL: ArtifactLive = {
  status: 'loading',
  title: null,
  thumbnail: null,
  editing: false,
  revision: 0,
  focusArtboardId: null,
}

// Diagrama não emite start/end: cada diagram:updated acende o "editando" por
// esta janela, que cobre o intervalo entre dois patches seguidos do Claude.
const DIAGRAM_EDITING_MS = 3_000
// Rede de segurança para um 'start' sem 'end' (main reiniciado no meio).
const DESIGN_EDITING_TTL_MS = 30_000

export function useArtifactLive(ref: ArtifactRef): ArtifactLive {
  const [live, setLive] = useState<ArtifactLive>(INITIAL)
  useEffect(() => {
    setLive(INITIAL)
    return ref.kind === 'diagram' ? watchDiagram(ref.id, setLive) : watchDesign(ref.id, setLive)
  }, [ref.kind, ref.id])

  return live
}

type Setter = (fn: (prev: ArtifactLive) => ArtifactLive) => void

function watchDiagram(id: string, setLive: Setter): () => void {
  let disposed = false
  let editingTimer: ReturnType<typeof setTimeout> | null = null
  let renderSeq = 0

  const applyScene = (diagram: Diagram) => {
    const seq = ++renderSeq
    setLive((prev) => ({
      ...prev,
      status: 'ready',
      title: diagram.title,
      thumbnail: diagram.thumbnail ?? prev.thumbnail,
      revision: diagram.version,
    }))
    // Diagrama criado pelo Claude nasce sem thumbnail (só o editor grava uma):
    // o card desenha a cena atual.
    void loadExcalidrawUtils()
      .then((utils) => renderThumbnail(utils, diagram.scene.elements, null))
      .then((url) => {
        if (disposed || seq !== renderSeq || !url) return
        setLive((prev) => ({ ...prev, thumbnail: url }))
      })
      .catch(() => {})
  }

  void diagramsApi.get(id).then((diagram) => {
    if (disposed) return
    if (!diagram) setLive((prev) => ({ ...prev, status: 'missing' }))
    else applyScene(diagram)
  })

  const offUpdated = diagramsApi.onUpdated((payload) => {
    const diagram = payload as Diagram
    if (diagram?.id !== id) return
    applyScene(diagram)
    setLive((prev) => ({ ...prev, editing: true }))
    if (editingTimer) clearTimeout(editingTimer)
    editingTimer = setTimeout(
      () => setLive((prev) => ({ ...prev, editing: false })),
      DIAGRAM_EDITING_MS,
    )
  })
  const offDeleted = diagramsApi.onDeleted((payload) => {
    if ((payload as { id?: string })?.id === id) setLive((prev) => ({ ...prev, status: 'missing' }))
  })

  return () => {
    disposed = true
    if (editingTimer) clearTimeout(editingTimer)
    offUpdated()
    offDeleted()
  }
}

function firstArtboardId(doc: DesignDocument): string | null {
  return doc.pages[0]?.artboards[0]?.id ?? null
}

function watchDesign(docId: string, setLive: Setter): () => void {
  let disposed = false
  const inFlight = new Map<string, number>()
  let ttl: ReturnType<typeof setTimeout> | null = null

  const load = () =>
    designApi.documentGet(docId).then((doc) => {
      if (disposed) return
      if (!doc) {
        setLive((prev) => ({ ...prev, status: 'missing' }))
        return
      }
      setLive((prev) => ({
        ...prev,
        status: 'ready',
        title: doc.title,
        thumbnail: doc.thumbnailVersion ? thumbUrl(doc.id, doc.thumbnailVersion) : prev.thumbnail,
        focusArtboardId: prev.focusArtboardId ?? firstArtboardId(doc),
      }))
    })
  void load()

  const syncEditing = () => {
    const editing = inFlight.size > 0
    setLive((prev) => (prev.editing === editing ? prev : { ...prev, editing }))
    if (ttl) clearTimeout(ttl)
    ttl = editing
      ? setTimeout(() => {
          inFlight.clear()
          syncEditing()
        }, DESIGN_EDITING_TTL_MS)
      : null
  }

  const offActivity = designApi.onAgentActivity((payload) => {
    const a = payload as DesignAgentActivity
    if (a?.docId !== docId) return
    const key = `${a.sessionId ?? ''}:${a.tool}`
    if (a.phase === 'start') inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
    else {
      const n = (inFlight.get(key) ?? 1) - 1
      if (n > 0) inFlight.set(key, n)
      else inFlight.delete(key)
    }
    if (a.artboardId) setLive((prev) => ({ ...prev, focusArtboardId: a.artboardId }))
    syncEditing()
  })
  const offArtboard = designApi.onArtboardUpdated((payload) => {
    const e = payload as { docId?: string; version?: number }
    if (e?.docId === docId) setLive((prev) => ({ ...prev, revision: prev.revision + 1 }))
  })
  const offThumb = designApi.onThumbnailUpdated((payload) => {
    const e = payload as DesignThumbnailUpdatedEvent
    if (e?.docId === docId)
      setLive((prev) => ({ ...prev, thumbnail: thumbUrl(docId, e.thumbnailVersion) }))
  })
  const offDoc = designApi.onDocumentUpdated((payload) => {
    if ((payload as { docId?: string })?.docId === docId) void load()
  })
  const offDeleted = designApi.onDocumentDeleted((payload) => {
    const e = payload as { docId?: string; id?: string }
    if (e?.docId === docId || e?.id === docId) setLive((prev) => ({ ...prev, status: 'missing' }))
  })

  return () => {
    disposed = true
    if (ttl) clearTimeout(ttl)
    offActivity()
    offArtboard()
    offThumb()
    offDoc()
    offDeleted()
  }
}
