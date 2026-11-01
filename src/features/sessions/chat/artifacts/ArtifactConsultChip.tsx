import { Eye } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { KIND_ICON, KIND_LABEL, openArtifactInEditor } from './ArtifactCard'
import type { ArtifactConsultPlan, ArtifactRef } from './artifact-refs'

// Leitura de um artefato (get, screenshot, tree_summary…): não é edição, então
// fica numa linha discreta. O resultado da tool segue visível logo abaixo.
export function ArtifactConsultChip({
  plan,
  onShowSide,
}: {
  plan: ArtifactConsultPlan
  onShowSide?: (ref: ArtifactRef) => void
}) {
  const { ref } = plan
  const title = plan.title ?? KIND_LABEL[ref.kind].toLowerCase()
  return (
    <button
      type="button"
      data-testid="artifact-consult-chip"
      onClick={() => (onShowSide ? onShowSide(ref) : openArtifactInEditor(ref))}
      title={`${KIND_LABEL[ref.kind]}: ${title} · ${plan.lastTool}`}
      className="flex max-w-full min-w-0 items-center gap-1.5 self-start rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-dim)] motion-safe:transition-colors hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <Icon as={Eye} size={11} className="shrink-0" />
      <span className="shrink-0">consultou</span>
      <Icon as={KIND_ICON[ref.kind]} size={11} className="shrink-0" />
      <span className="truncate text-[var(--color-text)]">{title}</span>
    </button>
  )
}
