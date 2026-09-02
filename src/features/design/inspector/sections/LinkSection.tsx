import { useDesignStore } from '@/store/designStore'
import type { DesignTransition } from '@shared/types/design'
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

// DesignNode.link has no op of its own, so the link travels as data-pw-link /
// data-pw-transition attrs; html-render reads them as a fallback to node.link.
export function LinkSection({ target }: Props) {
  const pageId = useDesignStore((s) => s.pageId)
  const artboards = useDesignStore((s) => s.artboards)
  const node = target.nodes[0]
  const targets = Object.values(artboards)
    .map((a) => a.meta)
    .filter((m) => m.pageId === pageId && m.id !== target.artboardId)
    .sort((a, b) => a.position - b.position)

  const linkTo = node.attrs['data-pw-link'] ?? node.link?.artboardId ?? NONE
  const transition = (node.attrs['data-pw-transition'] ?? node.link?.transition ?? 'none') as DesignTransition

  function write(to: string, t: DesignTransition): void {
    target.commit(
      target.nodes.map((n) => ({
        type: 'setAttrs',
        id: n.id,
        patch: to ? { 'data-pw-link': to, 'data-pw-transition': t } : { 'data-pw-link': null, 'data-pw-transition': null },
      })),
    )
  }

  return (
    <Section title="Link" defaultOpen={linkTo !== NONE}>
      <Row label="Destino">
        <SelectField
          value={linkTo}
          options={[{ value: NONE, label: 'Nenhum' }, ...targets.map((m) => ({ value: m.id, label: m.name }))]}
          onChange={(to) => write(to, transition)}
        />
      </Row>
      {linkTo !== NONE && (
        <Row label="Transição">
          <SelectField value={transition} options={TRANSITIONS} onChange={(t) => write(linkTo, t as DesignTransition)} />
        </Row>
      )}
    </Section>
  )
}
