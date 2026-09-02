import { Play } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useDesignStore } from '@/store/designStore'
import type { DesignArtboard, DesignTransition } from '@shared/types/design'
import { Row, Section } from '../controls/Section'
import { SelectField } from '../controls/SelectField'
import type { InspectorTarget } from '../target'

interface Props {
  target: InspectorTarget
}

const NONE = ''
const TRANSITIONS: Array<{ value: DesignTransition; label: string }> = [
  { value: 'none', label: 'Nenhuma' },
  { value: 'push', label: 'Push' },
  { value: 'fade', label: 'Fade' },
]

export const LINK_TESTIDS = {
  target: 'data-link-target',
  test: 'design-link-test',
} as const

const THUMB_BOX = 28

// Proportional miniature: enough to tell a phone from a desktop at a glance.
function Thumb({ meta, active }: { meta: DesignArtboard; active: boolean }) {
  const ratio = meta.width / meta.height
  const w = ratio >= 1 ? THUMB_BOX : Math.max(8, Math.round(THUMB_BOX * ratio))
  const h = ratio >= 1 ? Math.max(8, Math.round(THUMB_BOX / ratio)) : THUMB_BOX
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{ width: THUMB_BOX, height: THUMB_BOX }}
    >
      <span
        className={`block rounded-[2px] border ${
          active
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/30'
            : 'border-[var(--color-text-dim)]/60 bg-[var(--color-surface-2)]'
        }`}
        style={{ width: w, height: h }}
      />
    </span>
  )
}

// DesignNode.link has no op of its own, so the link travels as data-pw-link /
// data-pw-transition attrs; html-render reads them as a fallback to node.link.
export function LinkSection({ target }: Props) {
  const pageId = useDesignStore((s) => s.pageId)
  const artboards = useDesignStore((s) => s.artboards)
  const startPreview = useDesignStore((s) => s.startPreview)
  const node = target.nodes[0]
  const targets = Object.values(artboards)
    .map((a) => a.meta)
    .filter((m) => m.pageId === pageId && m.id !== target.artboardId)
    .sort((a, b) => a.position - b.position)

  const linkTo = node.attrs['data-pw-link'] ?? node.link?.artboardId ?? NONE
  const transition = (node.attrs['data-pw-transition'] ??
    node.link?.transition ??
    'none') as DesignTransition
  const linkTarget = linkTo ? artboards[linkTo]?.meta : undefined

  function write(to: string, t: DesignTransition): void {
    target.commit(
      target.nodes.map((n) => ({
        type: 'setAttrs',
        id: n.id,
        patch: to
          ? { 'data-pw-link': to, 'data-pw-transition': t }
          : { 'data-pw-link': null, 'data-pw-transition': null },
      })),
      {
        summary: to ? `Link → ${artboards[to]?.meta.name ?? to}` : 'Remove link',
      },
    )
  }

  const optionClass = (active: boolean): string =>
    `flex w-full items-center gap-2 rounded-md border px-1.5 py-1 text-left text-[11px] transition ${
      active
        ? 'border-[var(--color-accent)] text-[var(--color-text)]'
        : 'border-transparent text-[var(--color-text-dim)] hover:border-[var(--color-border)] hover:text-[var(--color-text)]'
    }`

  return (
    <Section title="Link" defaultOpen={linkTo !== NONE}>
      {targets.length === 0 ? (
        <p className="text-[11px] text-[var(--color-text-dim)]">
          Crie outro artboard nesta página para linkar.
        </p>
      ) : (
        <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          <button
            type="button"
            className={optionClass(linkTo === NONE)}
            onClick={() => write(NONE, transition)}
          >
            <span
              className="flex shrink-0 items-center justify-center"
              style={{ width: THUMB_BOX, height: THUMB_BOX }}
            >
              <span className="text-[var(--color-text-dim)]">—</span>
            </span>
            Nenhum
          </button>
          {targets.map((m) => {
            const active = m.id === linkTo
            return (
              <button
                key={m.id}
                type="button"
                {...{ [LINK_TESTIDS.target]: m.id }}
                aria-pressed={active}
                className={optionClass(active)}
                onClick={() => write(m.id, transition)}
              >
                <Thumb meta={m} active={active} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.name}</span>
                  <span className="block text-[10px] tabular-nums text-[var(--color-text-dim)]">
                    {m.width}×{m.height}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      {linkTarget && (
        <>
          <Row label="Transição">
            <SelectField
              value={transition}
              options={TRANSITIONS}
              onChange={(t) => write(linkTo, t as DesignTransition)}
            />
          </Row>
          <button
            type="button"
            data-testid={LINK_TESTIDS.test}
            onClick={() => startPreview(linkTarget.id)}
            title={`Abrir o preview em ${linkTarget.name}`}
            className="flex h-6 items-center justify-center gap-1 rounded-md border border-[var(--color-border)] text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)]"
          >
            <Icon as={Play} size={12} />
            Testar
          </button>
        </>
      )}
    </Section>
  )
}
