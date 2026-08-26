import { Loader, ScrollText } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { pillDensity } from '../pill-density'
import type { PanelTier } from '../use-panel-tier'
import type { SummarizeState } from './useSummarizeNow'

interface Props {
  /** Estado do resumo sob demanda — mora no rodapé (useSummarizeNow), não aqui. */
  state: SummarizeState
  onRun: () => void
  /** Densidade do rodapé: só no narrow o rótulo some (mesma regra dos pills vizinhos). */
  tier: PanelTier
}

// Botão "Resumir": resume o último turno AGORA, sem depender do toggle de
// resumo automático (voice:summarize-now bypassa o gate; o resultado chega
// pelo mesmo broadcast e aparece no SummaryChip). Visível mesmo sem resumo
// nenhum ainda — é o caminho de entrada do fluxo sob demanda.
export function SummarizeButton({ state, onRun, tier }: Props) {
  const { pad, showLabel } = pillDensity(tier)
  const label = (text: string) =>
    showLabel ? <span className="whitespace-nowrap">{text}</span> : null
  // Sem rótulo visível, o texto do estado tem de ir pro nome acessível.
  const aria = (text: string) => (showLabel ? undefined : text)

  if (state.status === 'running') {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        title="Resumindo o último turno…"
        aria-label={aria('Resumindo…')}
        className={`gap-1 ${pad} py-0.5 text-[10px]`}
      >
        <Icon as={Loader} size={11} className="animate-spin" />
        {label('Resumindo…')}
      </Button>
    )
  }

  if (state.status === 'error') {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRun}
          title={`${state.message} Clique pra tentar de novo.`}
          aria-label={aria('Resumir')}
          className={`gap-1 ${pad} py-0.5 text-[10px] text-[var(--color-danger)]`}
        >
          <Icon as={ScrollText} size={11} />
          {label('Resumir')}
        </Button>
        {/* Texto visível mesmo no tier compact: erro só em title/cor é invisível. */}
        <span
          role="status"
          title={state.message}
          className="max-w-[180px] truncate text-[10px] text-[var(--color-danger)]"
        >
          {state.message}
        </span>
      </span>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onRun}
      title="Resumir o último turno agora — o resumo aparece no chip acima do composer"
      aria-label={aria('Resumir')}
      className={`gap-1 ${pad} py-0.5 text-[10px]`}
    >
      <Icon as={ScrollText} size={11} />
      {label('Resumir')}
    </Button>
  )
}
