import { MessageSquareOff, MessageSquareText } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { pillDensity } from '../pill-density'
import type { PanelTier } from '../use-panel-tier'

interface Props {
  /** Espelho do estado no main (useAutoSummary). null = consultando. */
  enabled: boolean | null
  onToggle: () => void
  /** Densidade do rodapé: só no narrow o rótulo some (mesma regra dos pills vizinhos). */
  tier: PanelTier
}

// Toggle do resumo automático DESTA sessão (fim de turno → resumo no chip).
// Nada de áudio: o resumo aparece no chip e só toca sob demanda (▶).
export function AutoSummaryToggle({ enabled, onToggle, tier }: Props) {
  const on = enabled === true
  const { pad, showLabel } = pillDensity(tier)
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      disabled={enabled === null}
      aria-pressed={on}
      aria-label={showLabel ? undefined : 'Resumo auto'}
      title={
        enabled === null
          ? 'Consultando o estado do resumo automático…'
          : on
            ? 'Resumo automático ligado — o fim de cada turno desta sessão vira um resumo no chip. Clique pra desligar.'
            : 'Resumo automático desligado — ligue pra receber um resumo a cada fim de turno desta sessão.'
      }
      className={`gap-1 ${pad} py-0.5 text-[10px] ${on ? 'text-[var(--color-accent)]' : ''}`}
    >
      <Icon as={on ? MessageSquareText : MessageSquareOff} size={11} />
      {showLabel && <span className="whitespace-nowrap">Resumo auto</span>}
    </Button>
  )
}
