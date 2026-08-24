import { useEffect, useState } from 'react'
import { MessageSquareOff, MessageSquareText } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { voiceApi } from '@/lib/ipc'

interface Props {
  ccSessionId: string
  /** Tier compact do rodapé: só ícone, sem rótulo (mesma regra dos pills vizinhos). */
  compact?: boolean
}

// Toggle do resumo automático DESTA sessão (fim de turno → resumo no chip).
// A fonte da verdade é o Set no main (voice-summary.ts) — ele sobrevive a
// re-render e remount do pane; aqui só um espelho otimista re-consultado no
// mount. Nada de áudio: o resumo aparece no chip e só toca sob demanda (▶).
export function AutoSummaryToggle({ ccSessionId, compact }: Props) {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let alive = true
    setEnabled(false)
    void voiceApi.autoSummaryGet(ccSessionId).then((v) => {
      if (alive) setEnabled(v)
    })
    return () => {
      alive = false
    }
  }, [ccSessionId])

  function toggle() {
    const next = !enabled
    setEnabled(next)
    void voiceApi.autoSummarySet(ccSessionId, next)
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-pressed={enabled}
      title={
        enabled
          ? 'Resumo automático ligado — o fim de cada turno desta sessão vira um resumo no chip. Clique pra desligar.'
          : 'Resumo automático desligado — ligue pra receber um resumo a cada fim de turno desta sessão.'
      }
      className={`gap-1 ${compact ? 'px-1.5' : 'px-2'} py-0.5 text-[10px] ${enabled ? 'text-[var(--color-accent)]' : ''}`}
    >
      <Icon as={enabled ? MessageSquareText : MessageSquareOff} size={11} />
      {!compact && <span className="whitespace-nowrap">Resumo auto</span>}
    </Button>
  )
}
