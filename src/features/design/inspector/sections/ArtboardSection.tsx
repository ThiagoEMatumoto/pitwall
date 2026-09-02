import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu } from '@/components/ui/Menu'
import { useDesignStore } from '@/store/designStore'
import { ARTBOARD_PRESETS } from '@shared/types/design'
import { ColorField } from '../controls/ColorField'
import { NumberField } from '../controls/NumberField'
import { Row, Section } from '../controls/Section'
import { getStyle, normalizePatch } from '../style-mapping'
import { useColorTokens } from '../target'

interface Props {
  artboardId: string
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

  function commitName(): void {
    const next = name.trim()
    if (next && next !== meta!.name) updateArtboardMeta(artboardId, { name: next })
    else setName(meta!.name)
  }

  const background = getStyle(tree.style, 'background') ?? getStyle(tree.style, 'background-color') ?? ''

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
      <Row label="Tamanho">
        <div className="flex items-center gap-1">
          <NumberField
            label="W"
            value={meta.width}
            min={1}
            onCommit={(v) => v != null && updateArtboardMeta(artboardId, { width: v })}
          />
          <NumberField
            label="H"
            value={meta.height}
            min={1}
            onCommit={(v) => v != null && updateArtboardMeta(artboardId, { height: v })}
          />
          <Menu
            open={presetsOpen}
            onClose={() => setPresetsOpen(false)}
            portal
            items={ARTBOARD_PRESETS.map((p) => ({
              label: `${p.label} · ${p.width}×${p.height}`,
              active: p.width === meta.width && p.height === meta.height,
              onClick: () => updateArtboardMeta(artboardId, { width: p.width, height: p.height }),
            }))}
          >
            <button
              type="button"
              title="Presets"
              onClick={() => setPresetsOpen((o) => !o)}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
            >
              <Icon as={ChevronDown} size={12} />
            </button>
          </Menu>
        </div>
      </Row>
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
                patch: normalizePatch(tree.style, { background: v || null, 'background-color': null }),
              },
            ])
          }
        />
      </Row>
    </Section>
  )
}
