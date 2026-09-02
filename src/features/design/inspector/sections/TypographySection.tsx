import { useEffect, useState } from 'react'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight } from 'lucide-react'
import { useDesignStore } from '@/store/designStore'
import { ColorField } from '../controls/ColorField'
import { NumberField } from '../controls/NumberField'
import { Row, Section } from '../controls/Section'
import { Segmented } from '../controls/Segmented'
import { SelectField } from '../controls/SelectField'
import { FONT_WEIGHTS, readTypography, writeTypography } from '../style-mapping'
import { useColorTokens, type InspectorTarget } from '../target'

interface Props {
  target: InspectorTarget
}

const FAMILIES = [
  { value: '', label: 'Herdada' },
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

export function TypographySection({ target }: Props) {
  const tokens = useColorTokens()
  const fontTokens = useDesignStore((s) => s.doc?.tokens.font)
  const typo = readTypography(target.style)
  const id = target.nodes[0].id
  const families = [
    ...FAMILIES,
    ...Object.keys(fontTokens ?? {}).map((name) => ({ value: `var(--font-${name})`, label: `token: ${name}` })),
  ]

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
            placeholder="16"
            onScrub={(v) => target.applyStyle(writeTypography({ fontSize: v }), { transient: true })}
            onCommit={(v) => target.applyStyle(writeTypography({ fontSize: v }), { coalesceKey: `${id}:font-size` })}
          />
          <SelectField
            value={typo.fontWeight}
            options={FONT_WEIGHTS}
            allowCustom
            onChange={(fontWeight) => target.applyStyle(writeTypography({ fontWeight }))}
          />
        </div>
      </Row>
      <Row label="Entrelinha">
        <TextField
          value={typo.lineHeight}
          placeholder="1.5"
          onCommit={(lineHeight) => target.applyStyle(writeTypography({ lineHeight }))}
        />
      </Row>
      <Row label="Espaço">
        <NumberField
          value={typo.letterSpacing}
          placeholder="0"
          onCommit={(v) => target.applyStyle(writeTypography({ letterSpacing: v }))}
        />
      </Row>
      <Row label="Alinhar">
        <Segmented
          value={typo.textAlign}
          options={ALIGN_OPTIONS}
          onChange={(textAlign) => target.applyStyle(writeTypography({ textAlign }))}
        />
      </Row>
      <Row label="Cor">
        <ColorField value={typo.color} tokens={tokens} onCommit={(color) => target.applyStyle(writeTypography({ color }))} />
      </Row>
    </Section>
  )
}
