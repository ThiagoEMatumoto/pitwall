import { useDesignStore } from '@/store/designStore'
import { AppearanceSection } from './sections/AppearanceSection'
import { ArtboardSection } from './sections/ArtboardSection'
import { ExportSection } from './sections/ExportSection'
import { LayoutSection } from './sections/LayoutSection'
import { LinkSection } from './sections/LinkSection'
import { MotionSection } from './sections/MotionSection'
import { TokensSection } from './sections/TokensSection'
import { TypographySection } from './sections/TypographySection'
import { useInspectorTarget } from './target'

export function Inspector() {
  const docOpen = useDesignStore((s) => s.docId != null)
  const artboardId = useDesignStore((s) => s.selection.artboardId)
  const hasArtboard = useDesignStore((s) => !!(artboardId && s.artboards[artboardId]))
  const target = useInspectorTarget()

  if (!docOpen) return null

  const allText = target != null && target.nodes.every((n) => n.kind === 'text')

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      {!hasArtboard ? (
        <p className="px-3 py-4 text-xs text-[var(--color-text-dim)]">
          Selecione um artboard ou elemento para editar.
        </p>
      ) : target ? (
        <>
          <LayoutSection target={target} />
          <AppearanceSection target={target} />
          {allText && <TypographySection target={target} />}
          <LinkSection target={target} />
          <MotionSection target={target} />
          <ExportSection artboardId={target.artboardId} />
        </>
      ) : (
        <>
          <ArtboardSection artboardId={artboardId!} />
          <ExportSection artboardId={artboardId!} />
        </>
      )}
      <TokensSection />
    </aside>
  )
}
