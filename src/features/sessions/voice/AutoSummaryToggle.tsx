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
// re-render e remount do pane; aqui só um espelho re-consultado no mount.
// Nada de áudio: o resumo aparece no chip e só toca sob demanda (▶).
export function AutoSummaryToggle({ ccSessionId, compact }: Props) {
  // null = consultando o main. Não forçar "desligado" evita o flicker na troca
  // de sessão; desabilitar o clique até a resposta pousar elimina a corrida em
  // que o autoSummaryGet em voo sobrescreveria a interação do usuário.
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    setEnabled(null)
    void voiceApi.autoSummaryGet(ccSessionId).then((v) => {
      if (alive) setEnabled(v)
    })
    return () => {
      alive = false
    }
  }, [ccSessionId])

  function toggle() {
    if (enabled === null) return
    const next = !enabled
    setEnabled(next)
    void voiceApi.autoSummarySet(ccSessionId, next)
  }

  const on = enabled === true
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      disabled={enabled === null}
      aria-pressed={on}
      title={
        enabled === null
          ? 'Consultando o estado do resumo automático…'
          : on
            ? 'Resumo automático ligado — o fim de cada turno desta sessão vira um resumo no chip. Clique pra desligar.'
            : 'Resumo automático desligado — ligue pra receber um resumo a cada fim de turno desta sessão.'
      }
      className={`gap-1 ${compact ? 'px-1.5' : 'px-2'} py-0.5 text-[10px] ${on ? 'text-[var(--color-accent)]' : ''}`}
    >
      <Icon as={on ? MessageSquareText : MessageSquareOff} size={11} />
      {!compact && <span className="whitespace-nowrap">Resumo auto</span>}
    </Button>
  )
}
