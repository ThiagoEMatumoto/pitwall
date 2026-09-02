import { ArrowDown, ArrowRight } from 'lucide-react'
import { NumberField } from '../controls/NumberField'
import { Row, Section } from '../controls/Section'
import { Segmented } from '../controls/Segmented'
import { SelectField } from '../controls/SelectField'
import {
  ALIGN_OPTIONS,
  JUSTIFY_OPTIONS,
  readAutoLayout,
  readPosition,
  readSizing,
  writeAutoLayout,
  writePadding,
  writePosition,
  writeSizing,
  type Axis,
  type SizingMode,
} from '../style-mapping'
import type { InspectorTarget } from '../target'

interface Props {
  target: InspectorTarget
}

const SIZING_OPTIONS = [
  { value: 'hug', label: 'Hug' },
  { value: 'fill', label: 'Fill' },
  { value: 'fixed', label: 'Fixed' },
] as const satisfies ReadonlyArray<{ value: SizingMode; label: string }>

const POSITION_OPTIONS = [
  { value: 'static', label: 'Auto' },
  { value: 'relative', label: 'Rel' },
  { value: 'absolute', label: 'Abs' },
] as const

const PADDING_SIDES = ['T', 'R', 'B', 'L'] as const

function SizingRow({ axis, target }: { axis: Axis; target: InspectorTarget }) {
  const sizing = readSizing(target.style, axis)
  const key = `${target.nodes[0].id}:${axis}`
  return (
    <Row label={axis === 'width' ? 'Largura' : 'Altura'}>
      <div className="flex flex-col gap-1">
        <Segmented
          value={sizing.mode}
          options={SIZING_OPTIONS}
          onChange={(mode) =>
            target.applyStyle(writeSizing(axis, { mode, px: sizing.px ?? 100 }, target.inFlex))
          }
        />
        {sizing.mode === 'fixed' && (
          <NumberField
            label={axis === 'width' ? 'W' : 'H'}
            value={sizing.px}
            min={0}
            onScrub={(v) =>
              target.applyStyle(writeSizing(axis, { mode: 'fixed', px: v }, target.inFlex), {
                transient: true,
              })
            }
            onCommit={(v) =>
              target.applyStyle(writeSizing(axis, { mode: 'fixed', px: v ?? 0 }, target.inFlex), {
                coalesceKey: key,
              })
            }
          />
        )}
      </div>
    </Row>
  )
}

export function LayoutSection({ target }: Props) {
  const pos = readPosition(target.style)
  const layout = readAutoLayout(target.style)
  const id = target.nodes[0].id

  return (
    <Section title="Layout">
      <Row label="Posição">
        <Segmented
          value={pos.mode}
          options={POSITION_OPTIONS}
          onChange={(mode) => target.applyStyle(writePosition({ ...pos, mode }))}
        />
      </Row>
      {pos.mode !== 'static' && (
        <Row label="Offset">
          <div className="flex gap-1">
            <NumberField
              label="X"
              value={pos.left}
              onScrub={(v) => target.applyStyle(writePosition({ ...pos, left: v }), { transient: true })}
              onCommit={(v) => target.applyStyle(writePosition({ ...pos, left: v }), { coalesceKey: `${id}:left` })}
            />
            <NumberField
              label="Y"
              value={pos.top}
              onScrub={(v) => target.applyStyle(writePosition({ ...pos, top: v }), { transient: true })}
              onCommit={(v) => target.applyStyle(writePosition({ ...pos, top: v }), { coalesceKey: `${id}:top` })}
            />
          </div>
        </Row>
      )}
      <SizingRow axis="width" target={target} />
      <SizingRow axis="height" target={target} />

      <div className="mt-1 flex items-center justify-between">
        <span className="text-[11px] text-[var(--color-text-dim)]">Auto layout</span>
        <input
          type="checkbox"
          checked={layout.enabled}
          onChange={(e) => target.applyStyle(writeAutoLayout({ ...layout, enabled: e.target.checked }))}
          className="accent-[var(--color-accent)]"
        />
      </div>
      {layout.enabled && (
        <>
          <Row label="Direção">
            <Segmented
              value={layout.direction}
              options={[
                { value: 'row', icon: ArrowRight, title: 'Horizontal' },
                { value: 'column', icon: ArrowDown, title: 'Vertical' },
              ]}
              onChange={(direction) => target.applyStyle(writeAutoLayout({ ...layout, direction }))}
            />
          </Row>
          <Row label="Gap">
            <NumberField
              value={layout.gap}
              min={0}
              onScrub={(gap) => target.applyStyle(writeAutoLayout({ ...layout, gap }), { transient: true })}
              onCommit={(gap) => target.applyStyle(writeAutoLayout({ ...layout, gap: gap ?? 0 }), { coalesceKey: `${id}:gap` })}
            />
          </Row>
          <Row label="Padding">
            <div className="grid grid-cols-2 gap-1">
              {PADDING_SIDES.map((side, i) => (
                <NumberField
                  key={side}
                  label={side}
                  value={layout.padding[i]}
                  min={0}
                  onScrub={(v) => {
                    const padding = layout.padding.slice()
                    padding[i] = v
                    target.applyStyle(writePadding(padding), { transient: true })
                  }}
                  onCommit={(v) => {
                    const padding = layout.padding.slice()
                    padding[i] = v ?? 0
                    target.applyStyle(writePadding(padding), { coalesceKey: `${id}:padding` })
                  }}
                />
              ))}
            </div>
          </Row>
          <Row label="Alinhar">
            <SelectField
              value={layout.align}
              options={ALIGN_OPTIONS}
              onChange={(align) => target.applyStyle(writeAutoLayout({ ...layout, align }))}
            />
          </Row>
          <Row label="Distribuir">
            <SelectField
              value={layout.justify}
              options={JUSTIFY_OPTIONS}
              onChange={(justify) => target.applyStyle(writeAutoLayout({ ...layout, justify }))}
            />
          </Row>
          <Row label="Quebra">
            <input
              type="checkbox"
              checked={layout.wrap}
              onChange={(e) => target.applyStyle(writeAutoLayout({ ...layout, wrap: e.target.checked }))}
              className="accent-[var(--color-accent)]"
            />
          </Row>
        </>
      )}
    </Section>
  )
}
