import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu } from '@/components/ui/Menu'
import { showToast } from '@/features/notifications/toast-store'
import { useDesignStore } from '@/store/designStore'
import { ARTBOARD_MAX_PX, ARTBOARD_MIN_PX } from '@shared/design/safety'
import type { ArtboardPreset, ArtboardSizing } from '@shared/types/design'
import type { ArtboardPatch } from '@shared/design/ops'
import { formatPresetSize, groupPresets, presetMatches } from '../../artboard-format'
import { ColorField } from '../controls/ColorField'
import { NumberField } from '../controls/NumberField'
import { Row, Section } from '../controls/Section'
import { Segmented, type SegmentedOption } from '../controls/Segmented'
import { getStyle, normalizePatch } from '../style-mapping'
import { useColorTokens } from '../target'

interface Props {
  artboardId: string
}

export const ARTBOARD_TESTIDS = {
  sizing: 'design-artboard-sizing',
  presets: 'design-artboard-presets',
} as const

const SIZING_OPTIONS: readonly SegmentedOption<ArtboardSizing>[] = [
  { value: 'fixed', label: 'Fixo', title: 'Largura e altura fixas' },
  { value: 'flow', label: 'Fluxo', title: 'Largura fixa; a altura cresce com o conteúdo' },
]

const PRESET_GROUPS = groupPresets()

// The store clamps too (mutate warns), but the toast belongs to the field
// that was typed into, so the check happens here as well.
function toastClamped(axis: 'Largura' | 'Altura', requested: number, value: number): void {
  const limit = requested > value ? `máximo ${ARTBOARD_MAX_PX}` : `mínimo ${ARTBOARD_MIN_PX}`
  showToast({
    title: `${axis} limitada a ${value} px`,
    body: `${requested} px passa do ${limit} px.`,
  })
}

function presetPatch(preset: ArtboardPreset): ArtboardPatch {
  // A flow artboard keeps its measured height; only fixed presets carry one.
  return preset.sizing === 'flow'
    ? { width: preset.width, sizing: 'flow' }
    : { width: preset.width, height: preset.height, sizing: 'fixed' }
}

export function ArtboardSection({ artboardId }: Props) {
  const meta = useDesignStore((s) => s.artboards[artboardId]?.meta)
  const tree = useDesignStore((s) => s.artboards[artboardId]?.tree)
  const updateArtboardMeta = useDesignStore((s) => s.updateArtboardMeta)
  const commit = useDesignStore((s) => s.commit)
  const tokens = useColorTokens()
  const [name, setName] = useState(meta?.name ?? '')
  const [presetsOpen, setPresetsOpen] = useState(false)

  useEffect(() => setName(meta?.name ?? ''), [meta?.name])

  if (!meta || !tree) return null

  const flow = meta.sizing === 'flow'

  function commitName(): void {
    const next = name.trim()
    if (next && next !== meta!.name) updateArtboardMeta(artboardId, { name: next })
    else setName(meta!.name)
  }

  const background =
    getStyle(tree.style, 'background') ?? getStyle(tree.style, 'background-color') ?? ''

  const presetSections = PRESET_GROUPS.map((g) => ({
    title: g.label,
    items: g.presets.map((p) => ({
      label: `${p.label} · ${formatPresetSize(p)}`,
      active: presetMatches(p, meta),
      onClick: () => updateArtboardMeta(artboardId, presetPatch(p)),
    })),
  }))

  return (
    <Section title="Artboard">
      <Row label="Nome">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="h-6 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </Row>
      <Row label="Altura">
        <div data-testid={ARTBOARD_TESTIDS.sizing}>
          <Segmented
            value={meta.sizing}
            options={SIZING_OPTIONS}
            onChange={(sizing) => updateArtboardMeta(artboardId, { sizing })}
          />
        </div>
      </Row>
      <Row label="Tamanho">
        <div className="flex items-center gap-1">
          <NumberField
            label="W"
            value={meta.width}
            min={ARTBOARD_MIN_PX}
            max={ARTBOARD_MAX_PX}
            onClamped={(requested, value) => toastClamped('Largura', requested, value)}
            onCommit={(v) => v != null && updateArtboardMeta(artboardId, { width: v })}
          />
          <div
            className="flex min-w-0 flex-1"
            title={flow ? 'Altura medida pelo conteúdo' : undefined}
          >
            <NumberField
              label="H"
              value={meta.height}
              min={ARTBOARD_MIN_PX}
              max={ARTBOARD_MAX_PX}
              readOnly={flow}
              onClamped={(requested, value) => toastClamped('Altura', requested, value)}
              onCommit={(v) => v != null && updateArtboardMeta(artboardId, { height: v })}
            />
          </div>
          <Menu
            open={presetsOpen}
            onClose={() => setPresetsOpen(false)}
            portal
            sections={presetSections}
          >
            <button
              type="button"
              title="Presets"
              data-testid={ARTBOARD_TESTIDS.presets}
              onClick={() => setPresetsOpen((o) => !o)}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
            >
              <Icon as={ChevronDown} size={12} />
            </button>
          </Menu>
        </div>
      </Row>
      {flow && (
        <p className="text-[10px] leading-snug text-[var(--color-text-dim)]">
          A altura segue o conteúdo; o valor mostrado é a última medida.
        </p>
      )}
      <Row label="Fundo">
        <ColorField
          value={background}
          tokens={tokens}
          placeholder="#ffffff"
          onCommit={(v) =>
            commit(artboardId, [
              {
                type: 'setStyle',
                id: tree.id,
                patch: normalizePatch(tree.style, {
                  background: v || null,
                  'background-color': null,
                }),
              },
            ])
          }
        />
      </Row>
    </Section>
  )
}
