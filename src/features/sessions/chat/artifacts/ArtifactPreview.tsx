import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { designApi, diagramsApi } from '@/lib/ipc'
import { loadExcalidrawUtils } from '@/features/diagrams/excalidraw-lazy'
import { DIAGRAM_EXPORT_APP_STATE } from '@/features/diagrams/diagram-thumbnail'
import type { DesignArtboard } from '@shared/types/design'
import type { ArtifactLive } from './useArtifactLive'

// Previews read-only do painel lateral. Nenhum dos dois monta o editor:
// - diagrama: SVG exportado da cena atual (uma segunda instância do Excalidraw
//   custaria dezenas de MB e brigaria pelo estado de diagramsStore.selected);
// - design: PNG do artboard renderizado pelo main (design:export). O iframe
//   pitwall-design:// do canvas depende do designStore, que só segura UM
//   documento aberto; montá-lo aqui trocaria o doc do editor por baixo.

// Escritas em rajada (write_html seguido de styles) viram uma captura só.
const RECAPTURE_DEBOUNCE_MS = 450

function PreviewSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center p-6" aria-busy>
      <div className="aspect-[4/3] w-full max-w-md rounded-lg bg-[var(--color-surface-2)] motion-safe:animate-pulse" />
    </div>
  )
}

function PreviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--color-text-dim)]">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <Icon as={RotateCw} size={12} />
        Tentar de novo
      </button>
    </div>
  )
}

export function DiagramPreview({ id, live }: { id: string; live: ArtifactLive }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const [diagram, utils] = await Promise.all([diagramsApi.get(id), loadExcalidrawUtils()])
        if (cancelled) return
        const elements = (diagram?.scene.elements ?? []).filter(
          (e) => !(e as { isDeleted?: boolean }).isDeleted,
        )
        if (elements.length === 0) {
          setState('empty')
          return
        }
        const svg = await utils.exportToSvg({
          elements: elements as never,
          appState: DIAGRAM_EXPORT_APP_STATE,
          files: null,
        })
        if (cancelled || !hostRef.current) return
        svg.removeAttribute('width')
        svg.removeAttribute('height')
        svg.setAttribute('class', 'h-auto max-h-full w-full')
        svg.setAttribute('role', 'img')
        svg.setAttribute('aria-label', diagram?.title ?? 'Diagrama')
        hostRef.current.replaceChildren(svg)
        setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    }, RECAPTURE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [id, live.revision, retry])

  return (
    <div className="relative h-full w-full overflow-auto">
      {state === 'loading' && <PreviewSkeleton />}
      {state === 'empty' && (
        <p className="flex h-full items-center justify-center text-sm text-[var(--color-text-dim)]">
          Diagrama vazio por enquanto.
        </p>
      )}
      {state === 'error' && (
        <PreviewError
          message="Não deu para desenhar o diagrama."
          onRetry={() => setRetry((n) => n + 1)}
        />
      )}
      <div
        ref={hostRef}
        className={`m-4 flex items-start justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 motion-safe:transition-opacity motion-safe:duration-200 ${
          state === 'ready' ? 'opacity-100' : 'pointer-events-none absolute inset-0 opacity-0'
        }`}
      />
    </div>
  )
}

export function DesignPreview({ docId, live }: { docId: string; live: ArtifactLive }) {
  const [artboards, setArtboards] = useState<DesignArtboard[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [retry, setRetry] = useState(0)
  // Segue o artboard que o Claude está tocando até o usuário escolher outro.
  const followAgent = picked === null
  const artboardId = (followAgent ? live.focusArtboardId : picked) ?? artboards[0]?.id ?? null

  useEffect(() => {
    let cancelled = false
    void designApi.documentGet(docId).then((doc) => {
      if (cancelled || !doc) return
      setArtboards(doc.pages.flatMap((p) => p.artboards))
    })
    return () => {
      cancelled = true
    }
  }, [docId, live.revision])

  useEffect(() => {
    if (!artboardId) {
      setState(artboards.length === 0 ? 'empty' : 'loading')
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await designApi.export({ artboardId, format: 'png', scale: 1 })
        if (cancelled) return
        setImage(`data:image/png;base64,${res.data}`)
        setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    }, RECAPTURE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [artboardId, live.revision, retry, artboards.length])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {artboards.length > 1 && (
        <div
          role="tablist"
          aria-label="Artboards"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border)] px-3 py-2 [scrollbar-width:none]"
        >
          {artboards.map((ab) => {
            const active = ab.id === artboardId
            return (
              <button
                key={ab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPicked(ab.id === live.focusArtboardId ? null : ab.id)}
                className={`shrink-0 rounded-md px-2 py-0.5 text-xs motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                  active
                    ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                    : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                }`}
              >
                {ab.name}
              </button>
            )
          })}
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {state === 'loading' && !image && <PreviewSkeleton />}
        {state === 'empty' && (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-text-dim)]">
            Nenhum artboard ainda. Ele aparece aqui assim que o Claude criar o primeiro.
          </p>
        )}
        {state === 'error' && (
          <PreviewError
            message="Não deu para renderizar o artboard."
            onRetry={() => setRetry((n) => n + 1)}
          />
        )}
        {image && state !== 'error' && (
          <img
            src={image}
            alt=""
            draggable={false}
            className="mx-auto my-4 block h-auto w-[calc(100%-2rem)] rounded-lg shadow-sm motion-safe:transition-opacity motion-safe:duration-200"
          />
        )}
      </div>
    </div>
  )
}
