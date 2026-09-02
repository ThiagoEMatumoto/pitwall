import { useEffect, useState } from 'react'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight } from 'lucide-react'
import { useDesignStore } from '@/store/designStore'
import { ColorField } from '../controls/ColorField'
import { NumberField } from '../controls/NumberField'
import { Row, Section } from '../controls/Section'
import { Segmented } from '../controls/Segmented'
import { SelectField } from '../controls/SelectField'
import { FONT_WEIGHTS, getStyle, readTypography, writeTypography } from '../style-mapping'
import { computedColor, computedPx, computedText } from '../computed-format'
import { useComputedStyle } from '../computed'
import { useColorTokens, type InspectorTarget } from '../target'

interface Props {
  target: InspectorTarget
}

const COMPUTED_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'color',
] as const

const FAMILIES = [
  'Inter, sans-serif',
  'system-ui, sans-serif',
  'Georgia, serif',
  'ui-monospace, monospace',
]

const ALIGN_OPTIONS = [
  { value: 'left', icon: AlignLeft, title: 'Esquerda' },
  { value: 'center', icon: AlignCenter, title: 'Centro' },
  { value: 'right', icon: AlignRight, title: 'Direita' },
  { value: 'justify', icon: AlignJustify, title: 'Justificado' },
] as const

// line-height is either unitless (1.5) or a length; a NumberField would
// force px, so it stays a free-text field.
function TextField({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== value && onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className="h-6 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[11px] tabular-nums text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] placeholder:text-[var(--color-text-dim)]"
    />
  )
}

// The browser resolves the default to start/end; the segmented control speaks left/right.
function alignFromComputed(value: string | undefined): string {
  if (value === 'start') return 'left'
  if (value === 'end') return 'right'
  return value || 'left'
}

export function TypographySection({ target }: Props) {
  const tokens = useColorTokens()
  const fontTokens = useDesignStore((s) => s.doc?.tokens.font)
  const typo = readTypography(target.style)
  const id = target.nodes[0].id
  // Inline-less properties show what the artboard actually renders.
  const computed = useComputedStyle(target.artboardId, id, COMPUTED_PROPS)
  const inlineWeight = getStyle(target.style, 'font-weight') ?? ''
  const inlineAlign = getStyle(target.style, 'text-align')
  const families = [
    { value: '', label: computedText(computed['font-family']) },
    ...FAMILIES,
    ...Object.keys(fontTokens ?? {}).map((name) => ({ value: `var(--font-${name})`, label: `token: ${name}` })),
  ]
  const weights = [{ value: '', label: computedText(computed['font-weight']) }, ...FONT_WEIGHTS]

  return (
    <Section title="Tipografia">
      <Row label="Fonte">
        <SelectField
          value={typo.fontFamily}
          options={families}
          allowCustom
          onChange={(fontFamily) => target.applyStyle(writeTypography({ fontFamily }))}
        />
      </Row>
      <Row label="Tamanho">
        <div className="flex gap-1">
          <NumberField
            value={typo.fontSize}
            min={1}
            placeholder={computedPx(computed['font-size'], '16')}
            onScrub={(v) => target.applyStyle(writeTypography({ fontSize: v }), { transient: true })}
            onCommit={(v) => target.applyStyle(writeTypography({ fontSize: v }), { coalesceKey: `${id}:font-size` })}
          />
          <SelectField
            value={inlineWeight}
            options={weights}
            allowCustom
            onChange={(fontWeight) => target.applyStyle(writeTypography({ fontWeight }))}
          />
        </div>
      </Row>
      <Row label="Entrelinha">
        <TextField
          value={typo.lineHeight}
          placeholder={computedText(computed['line-height'], '1.5')}
          onCommit={(lineHeight) => target.applyStyle(writeTypography({ lineHeight }))}
        />
      </Row>
      <Row label="Espaço">
        <NumberField
          value={typo.letterSpacing}
          placeholder={computedPx(computed['letter-spacing'], '0')}
          onCommit={(v) => target.applyStyle(writeTypography({ letterSpacing: v }))}
        />
      </Row>
      <Row label="Alinhar">
        <Segmented
          value={inlineAlign ?? alignFromComputed(computed['text-align'])}
          options={ALIGN_OPTIONS}
          onChange={(textAlign) => target.applyStyle(writeTypography({ textAlign }))}
        />
      </Row>
      <Row label="Cor">
        <ColorField
          value={typo.color}
          computed={computedColor(computed.color)}
          tokens={tokens}
          onCommit={(color) => target.applyStyle(writeTypography({ color }))}
        />
      </Row>
    </Section>
  )
}
