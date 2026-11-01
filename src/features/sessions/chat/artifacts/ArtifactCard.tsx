import { ArrowUpRight, LayoutTemplate, PanelRight, Workflow } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { navigateToDesign, navigateToDiagram } from '@/lib/nav'
import type { ArtifactCardPlan, ArtifactKind, ArtifactRef } from './artifact-refs'
import { useArtifactLive } from './useArtifactLive'

export const KIND_LABEL: Record<ArtifactKind, string> = { diagram: 'Diagrama', design: 'Design' }
export const KIND_ICON = { diagram: Workflow, design: LayoutTemplate } as const

export function openArtifactInEditor(ref: ArtifactRef): void {
  if (ref.kind === 'diagram') navigateToDiagram(ref.id)
  else navigateToDesign(ref.id)
}

// Leituras não chegam aqui (viram ArtifactConsultChip).
function actionLabel(tool: string, calls: number): string {
  const verb = /_(create|artboard_create)$/.test(tool) ? 'Criado' : 'Editado'
  return calls > 1 ? `${verb} · ${calls} chamadas neste turno` : `${verb} pelo Claude`
}

export function ArtifactThumb({
  kind,
  src,
  editing,
  className = '',
}: {
  kind: ArtifactKind
  src: string | null
  editing: boolean
  className?: string
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] ${className}`}
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="h-full w-full object-contain object-center motion-safe:transition-opacity motion-safe:duration-200"
        />
      ) : (
        <div
          aria-hidden
          className="flex h-full w-full items-center justify-center bg-[var(--color-surface-2)] text-[var(--color-text-dim)]"
          style={{
            backgroundImage:
              'radial-gradient(color-mix(in srgb, var(--color-text-dim) 22%, transparent) 1px, transparent 1px)',
            backgroundSize: '12px 12px',
          }}
        >
          <Icon as={KIND_ICON[kind]} size={18} />
        </div>
      )}
      {editing && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-[var(--color-accent)]/60 motion-safe:animate-pulse"
        />
      )}
    </div>
  )
}

export function EditingLabel() {
  return (
    <span className="flex items-center gap-1.5 text-[var(--color-accent)]" role="status">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] motion-safe:animate-pulse" />
      Claude editando…
    </span>
  )
}

export function ArtifactCard({
  plan,
  onShowSide,
  sideActive,
}: {
  plan: ArtifactCardPlan
  onShowSide?: (ref: ArtifactRef) => void
  // O painel lateral já mostra este artefato.
  sideActive?: boolean
}) {
  const { ref } = plan
  const live = useArtifactLive(ref)
  const missing = live.status === 'missing'
  const title =
    live.title ?? plan.title ?? (live.status === 'loading' ? 'Carregando…' : 'Sem título')

  return (
    <div
      data-testid="artifact-card"
      className={`group flex items-center gap-3 rounded-lg border bg-[var(--color-surface)] p-2 pr-3 motion-safe:transition-colors motion-safe:duration-200 ${
        live.editing
          ? 'border-[var(--color-accent)]/50'
          : 'border-[var(--color-border)] hover:border-[color-mix(in_srgb,var(--color-text-dim)_45%,var(--color-border))]'
      }`}
    >
      <button
        type="button"
        disabled={missing}
        onClick={() => (onShowSide ? onShowSide(ref) : openArtifactInEditor(ref))}
        aria-label={`Ver ${KIND_LABEL[ref.kind].toLowerCase()} ${title}`}
        className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-default"
      >
        <ArtifactThumb
          kind={ref.kind}
          src={live.thumbnail}
          editing={live.editing}
          className="h-[60px] w-24"
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]">
          <Icon as={KIND_ICON[ref.kind]} size={12} className="shrink-0" />
          {KIND_LABEL[ref.kind]}
        </div>
        <div
          className={`truncate text-sm font-medium ${missing ? 'text-[var(--color-text-dim)] line-through' : 'text-[var(--color-text)]'}`}
          title={title}
        >
          {title}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-dim)]">
          {missing ? (
            'Removido'
          ) : live.editing ? (
            <EditingLabel />
          ) : (
            actionLabel(plan.lastTool, plan.calls)
          )}
        </div>
      </div>
      {!missing && (
        <div className="flex shrink-0 items-center gap-1">
          {onShowSide && (
            <button
              type="button"
              onClick={() => onShowSide(ref)}
              aria-pressed={sideActive}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                sideActive
                  ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text)] hover:bg-[var(--color-surface-2)]'
              }`}
            >
              <Icon as={PanelRight} size={13} />
              Ver ao lado
            </button>
          )}
          <button
            type="button"
            onClick={() => openArtifactInEditor(ref)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            Abrir
            <Icon as={ArrowUpRight} size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
