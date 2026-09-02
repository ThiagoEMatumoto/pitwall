import { useState } from 'react'
import { Link, Unlink } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ColorField } from '../controls/ColorField'
import { NumberField } from '../controls/NumberField'
import { Row, Section } from '../controls/Section'
import { SelectField } from '../controls/SelectField'
import {
  BLEND_MODES,
  BORDER_STYLES,
  SHADOW_PRESETS,
  getStyle,
  readBlend,
  readBorder,
  readOpacity,
  readRadius,
  readShadow,
  writeBlend,
  writeBorder,
  writeOpacity,
  writeRadius,
  writeShadow,
  type ShadowPreset,
} from '../style-mapping'
import { computedColor, computedPx } from '../computed-format'
import { useComputedStyle } from '../computed'
import { useColorTokens, type InspectorTarget } from '../target'

interface Props {
  target: InspectorTarget
}

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const
const CORNER_KEYS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const
const COMPUTED_PROPS = [
  'background-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'border-top-width',
  'border-top-color',
] as const

function hasInline(style: InspectorTarget['style'], keys: readonly string[]): boolean {
  return keys.some((k) => getStyle(style, k) != null)
}
const SHADOW_OPTIONS = Object.keys(SHADOW_PRESETS).map((id) => ({
  value: id,
  label: id === 'none' ? 'Nenhuma' : id,
}))

export function AppearanceSection({ target }: Props) {
  const tokens = useColorTokens()
  const [linked, setLinked] = useState(true)
  const id = target.nodes[0].id
  const style = target.style
  const fill = getStyle(style, 'background') ?? getStyle(style, 'background-color') ?? ''
  const radius = readRadius(style)
  const border = readBorder(style)
  const shadow = readShadow(style)
  // Stylesheet/inherited values show as placeholders until the user writes inline.
  const computed = useComputedStyle(target.artboardId, id, COMPUTED_PROPS)
  const inlineRadius = hasInline(style, [
    'border-radius',
    ...CORNER_KEYS.map((c) => `border-${c}-radius`),
  ])
  const inlineBorder = hasInline(style, ['border', 'border-width', 'border-style', 'border-color'])
  // A 0px border has a colour in getComputedStyle too; showing it reads as
  // "this node has a border".
  const computedBorderWidth = computedPx(computed['border-top-width'], '0')
  const computedBorderColor =
    computedBorderWidth !== '0' ? computedColor(computed['border-top-color']) : undefined
  const radiusValue = (i: number): number | null => (inlineRadius ? radius[i] : null)
  const radiusPlaceholder = (i: number): string =>
    computedPx(computed[`border-${CORNER_KEYS[i]}-radius`], '0')

  function setRadius(i: number, v: number, transient: boolean): void {
    const next = linked ? [v, v, v, v] : radius.map((r, j) => (j === i ? v : r))
    target.applyStyle(
      writeRadius(next),
      transient ? { transient: true } : { coalesceKey: `${id}:radius` },
    )
  }

  return (
    <Section title="Aparência">
      <Row label="Fundo">
        <ColorField
          value={fill}
          computed={computedColor(computed['background-color'])}
          tokens={tokens}
          onCommit={(v) => target.applyStyle({ background: v || null, 'background-color': null })}
        />
      </Row>
      <Row label="Opacidade">
        <NumberField
          value={readOpacity(style)}
          unit="%"
          min={0}
          max={100}
          onScrub={(v) => target.applyStyle(writeOpacity(v), { transient: true })}
          onCommit={(v) =>
            target.applyStyle(writeOpacity(v ?? 100), { coalesceKey: `${id}:opacity` })
          }
        />
      </Row>
      <Row label="Raio">
        <div className="flex items-start gap-1">
          {linked ? (
            <NumberField
              value={radiusValue(0)}
              placeholder={radiusPlaceholder(0)}
              min={0}
              onScrub={(v) => setRadius(0, v, true)}
              onCommit={(v) => setRadius(0, v ?? 0, false)}
            />
          ) : (
            <div className="grid flex-1 grid-cols-2 gap-1">
              {CORNER_LABELS.map((label, i) => (
                <NumberField
                  key={label}
                  label={label}
                  value={radiusValue(i)}
                  placeholder={radiusPlaceholder(i)}
                  min={0}
                  onScrub={(v) => setRadius(i, v, true)}
                  onCommit={(v) => setRadius(i, v ?? 0, false)}
                />
              ))}
            </div>
          )}
          <button
            type="button"
            title={linked ? 'Cantos independentes' : 'Cantos iguais'}
            onClick={() => setLinked((l) => !l)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
          >
            <Icon as={linked ? Link : Unlink} size={12} />
          </button>
        </div>
      </Row>
      <Row label="Borda">
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            <NumberField
              value={inlineBorder ? border.width : null}
              placeholder={computedBorderWidth}
              min={0}
              onCommit={(v) => target.applyStyle(writeBorder({ ...border, width: v ?? 0 }))}
            />
            <SelectField
              value={border.style}
              options={BORDER_STYLES}
              onChange={(s) =>
                target.applyStyle(writeBorder({ ...border, style: s, width: border.width || 1 }))
              }
            />
          </div>
          <ColorField
            value={border.color}
            computed={computedBorderColor}
            tokens={tokens}
            onCommit={(color) =>
              target.applyStyle(writeBorder({ ...border, color, width: border.width || 1 }))
            }
          />
        </div>
      </Row>
      <Row label="Sombra">
        <SelectField
          value={shadow}
          options={
            shadow === 'custom'
              ? [{ value: 'custom', label: 'Custom' }, ...SHADOW_OPTIONS]
              : SHADOW_OPTIONS
          }
          onChange={(v) => v !== 'custom' && target.applyStyle(writeShadow(v as ShadowPreset))}
        />
      </Row>
      <Row label="Blend">
        <SelectField
          value={readBlend(style)}
          options={BLEND_MODES}
          onChange={(v) => target.applyStyle(writeBlend(v))}
        />
      </Row>
    </Section>
  )
}
