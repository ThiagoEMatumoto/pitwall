import { useStore } from '@xyflow/react'
import { Crown, Flag } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useAppStore } from '@/store/appStore'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { batonChipPx, motherBadgePx, motherBadgeText } from './mother-badge'
import { quantizeZoom } from './card-display'

// compact: brief e recolhido, onde o badge divide UMA linha com o título num
// cartão de largura fixa — só coroa + contagem (o resto vai no tooltip).

// Mesmo quantizado do cartão (0,05): re-renderiza só quando a fonte muda.
function useZoom(): number {
  return useStore((s) => quantizeZoom(s.transform[2]))
}

export function MotherBadge({ node, compact = false }: { node: SessionGraphNode; compact?: boolean }) {
  const zoom = useZoom()
  if (!node.isMother) return null
  const fontSize = motherBadgePx(zoom)
  const n = node.childCount ?? 0
  return (
    <span
      data-testid="card-mother-badge"
      title={`Mãe: lidera ${n} ${n === 1 ? 'filha' : 'filhas'} de handoff`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 font-semibold uppercase leading-tight tracking-wide"
      style={{
        fontSize,
        color: 'var(--color-bg)',
        background: 'var(--color-accent)',
      }}
    >
      <Icon as={Crown} size={Math.round(fontSize)} />
      {motherBadgeText(n, compact)}
    </span>
  )
}

// A antecessora da mãe segue viva (decisão de produto): fica marcada e o
// encerramento é um clique, com a mesma janela de desfazer do resto do app.
// Mora na linha de ESTADO, não na do título: "bastão passado" + "Encerrar" ao
// lado do nome deixavam o alias em "mae-baton…". compact troca o texto pela
// bandeira (o tooltip mantém o significado).
export function BatonPassedChip({
  node,
  compact = false,
}: {
  node: SessionGraphNode
  compact?: boolean
}) {
  const zoom = useZoom()
  const endSession = useAppStore((s) => s.endSession)
  if (!node.batonPassed || node.status === 'ended') return null
  const fontSize = batonChipPx(zoom)
  return (
    <span
      data-testid="card-baton-passed"
      className="inline-flex shrink-0 items-center gap-1 text-[var(--color-violet)]"
      style={{ fontSize }}
      title="Bastão passado: a liderança das filhas foi para a sucessora; esta continua viva até você encerrar"
    >
      {compact ? <Icon as={Flag} size={Math.round(fontSize)} /> : 'bastão passado'}
      <button
        type="button"
        data-testid="card-baton-end"
        onClick={(e) => {
          e.stopPropagation()
          endSession(node.sessionId)
        }}
        className="nodrag rounded border border-[var(--color-border)] px-1 text-[var(--color-text-dim)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
      >
        Encerrar
      </button>
    </span>
  )
}
