import { useEffect, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { designApi, diagramsApi } from '@/lib/ipc'
import { KIND_LABEL as DIAGRAM_KIND_LABEL } from '../diagrams/diagram-labels'
import {
  KIND_ICON,
  KIND_LABEL,
  openArtifactInEditor,
} from '../sessions/chat/artifacts/ArtifactCard'
import type { ArtifactRef } from '../sessions/chat/artifacts/artifact-refs'

interface Artifact {
  ref: ArtifactRef
  title: string
  kindLabel: string
  updatedAt: number
}

// Rajada de links (create + vários patches) vira uma recarga só.
const RELOAD_DEBOUNCE_MS = 300

async function loadArtifacts(featureId: string): Promise<Artifact[]> {
  const parent = { parentType: 'feature' as const, parentId: featureId }
  const [diagrams, docs] = await Promise.all([
    diagramsApi.list({ ...parent, status: 'active' }),
    designApi.documentsList(parent),
  ])
  return [
    ...diagrams.map((d) => ({
      ref: { kind: 'diagram' as const, id: d.id },
      title: d.title,
      kindLabel: DIAGRAM_KIND_LABEL[d.kind] ?? KIND_LABEL.diagram,
      updatedAt: d.updatedAt,
    })),
    ...docs
      .filter((d) => d.status === 'active')
      .map((d) => ({
        ref: { kind: 'design' as const, id: d.id },
        title: d.title,
        kindLabel: KIND_LABEL.design,
        updatedAt: d.updatedAt,
      })),
  ].sort((a, b) => b.updatedAt - a.updatedAt)
}

// Seção "Artefatos" do FeatureDoc: diagramas e designs ligados à feature
// (links parentType=feature), abrindo cada um no seu editor.
export function FeatureArtifactsSection({ featureId }: { featureId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void loadArtifacts(featureId)
          .then((next) => !disposed && setArtifacts(next))
          .catch((err) => console.error('[FeatureArtifactsSection] load failed', err))
      }, RELOAD_DEBOUNCE_MS)
    }
    reload()
    const offs = [
      diagramsApi.onLinksUpdated(reload),
      diagramsApi.onDeleted(reload),
      designApi.onLinksUpdated(reload),
      designApi.onDocumentDeleted(reload),
    ]
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      offs.forEach((off) => off())
    }
  }, [featureId])

  return (
    <section className="mt-8" data-testid="feature-artifacts">
      <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Artefatos</h2>
      {artifacts.length === 0 ? (
        <p className="text-xs text-[var(--color-text-dim)]">
          Nenhum diagrama ou design ligado a esta feature.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {artifacts.map((a) => (
            <li key={`${a.ref.kind}:${a.ref.id}`}>
              <button
                type="button"
                data-testid="feature-artifact"
                onClick={() => openArtifactInEditor(a.ref)}
                title={`Abrir ${KIND_LABEL[a.ref.kind].toLowerCase()}: ${a.title}`}
                className="flex w-full min-w-0 items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-left motion-safe:transition-colors hover:border-[var(--color-accent)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <Icon
                  as={KIND_ICON[a.ref.kind]}
                  size={14}
                  className="shrink-0 text-[var(--color-text-dim)]"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">
                  {a.title}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--color-text-dim)]">
                  {a.kindLabel}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
