import { useEffect, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { designApi, diagramsApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import { KIND_ICON, KIND_LABEL, openArtifactInEditor } from './ArtifactCard'
import type { ArtifactRef } from './artifact-refs'
import { useArtifactPanelStore } from './artifactPanelStore'

interface Chip {
  ref: ArtifactRef
  title: string
  updatedAt: number
}

const MAX_CHIPS = 3
// Rajada de links (create + vários patches) vira uma recarga só.
const RELOAD_DEBOUNCE_MS = 300

async function loadChips(sessionId: string): Promise<Chip[]> {
  const parent = { parentType: 'session' as const, parentId: sessionId }
  const [diagrams, docs] = await Promise.all([
    diagramsApi.list({ ...parent, status: 'active' }),
    designApi.documentsList(parent),
  ])
  return [
    ...diagrams.map((d) => ({
      ref: { kind: 'diagram' as const, id: d.id },
      title: d.title,
      updatedAt: d.updatedAt,
    })),
    ...docs
      .filter((d) => d.status === 'active')
      .map((d) => ({
        ref: { kind: 'design' as const, id: d.id },
        title: d.title,
        updatedAt: d.updatedAt,
      })),
  ].sort((a, b) => b.updatedAt - a.updatedAt)
}

// Artefatos que a sessão escreveu, na linha dela na sidebar do projeto. O clique
// leva à sessão com o artefato aberto no painel ao lado do chat; sessão que não
// está viva abre o artefato direto no editor.
export function SessionArtifactChips({ sessionId }: { sessionId: string }) {
  const [chips, setChips] = useState<Chip[]>([])
  const live = useAppStore((s) => s.liveSessions.find((l) => l.id === sessionId))
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const showSide = useArtifactPanelStore((s) => s.show)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void loadChips(sessionId)
          .then((next) => !disposed && setChips(next))
          .catch(() => {})
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
  }, [sessionId])

  if (chips.length === 0) return null
  const open = (ref: ArtifactRef) => {
    if (!live) {
      openArtifactInEditor(ref)
      return
    }
    showSide(sessionId, ref)
    void focusOrOpenSession(live)
  }
  const extra = chips.length - MAX_CHIPS

  return (
    <div data-testid="session-artifact-chips" className="flex min-w-0 flex-wrap gap-1 px-1 pb-1">
      {chips.slice(0, MAX_CHIPS).map((chip) => (
        <button
          key={`${chip.ref.kind}:${chip.ref.id}`}
          type="button"
          onClick={() => open(chip.ref)}
          title={`${KIND_LABEL[chip.ref.kind]}: ${chip.title}`}
          className="flex min-w-0 max-w-[11rem] items-center gap-1 rounded-full border border-[var(--color-border)] px-1.5 py-px text-[10px] text-[var(--color-text-dim)] motion-safe:transition-colors hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <Icon as={KIND_ICON[chip.ref.kind]} size={10} className="shrink-0" />
          <span className="truncate">{chip.title}</span>
        </button>
      ))}
      {extra > 0 && (
        <span
          className="px-1 text-[10px] leading-4 text-[var(--color-text-dim)]"
          title={chips
            .slice(MAX_CHIPS)
            .map((c) => c.title)
            .join('\n')}
        >
          +{extra}
        </span>
      )}
    </div>
  )
}
