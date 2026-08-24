import { useEffect, useRef, useState } from 'react'
import { AudioLines, Play, Square, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { voiceApi } from '@/lib/ipc'
import { speakSummary, stopSpeaking, useVoiceSpeaker } from './useVoiceSpeaker'

interface Props {
  ccSessionId: string | null
}

// Faixa discreta ACIMA do composer com o último resumo de turno (voice:summary,
// automático ou sob demanda). O transcript JSONL é read-only — o resumo NÃO
// entra no fluxo de mensagens do chat; vive só aqui. O áudio NUNCA toca
// sozinho: qualquer resumo exibido é tocável sob demanda pelo ▶, em qualquer
// sessão; o ⏹ para a reprodução em curso.
export function SummaryChip({ ccSessionId }: Props) {
  const [summary, setSummary] = useState<string | null>(null)
  const { speaking, stop } = useVoiceSpeaker()
  const prevIdRef = useRef(ccSessionId)

  useEffect(() => {
    // Trocar de sessão limpa o chip — sem isso ele mostraria o resumo da outra.
    // E para o áudio: com o chip limpo, a reprodução ficaria órfã (sem ⏹ visível).
    // O ref distingue troca real de mount (mount de um pane novo não pode calar
    // o áudio de outro).
    if (prevIdRef.current !== ccSessionId) {
      prevIdRef.current = ccSessionId
      stopSpeaking()
    }
    setSummary(null)
    if (!ccSessionId) return
    return voiceApi.onSummary((event) => {
      if (event.ccSessionId !== ccSessionId) return
      // Resumo novo com áudio antigo tocando: para — o ▶/⏹ do chip precisa
      // sempre corresponder ao texto exibido, e nada toca sem o usuário pedir.
      stopSpeaking()
      setSummary(event.summary)
    })
  }, [ccSessionId])

  if (!summary) return null

  return (
    <div className="mx-2 mb-1 flex shrink-0 items-start gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1">
      <Icon
        as={AudioLines}
        size={12}
        className={`mt-0.5 shrink-0 text-[var(--color-accent)] ${speaking ? 'animate-pulse' : ''}`}
      />
      <p
        className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--color-text-dim)]"
        title="Resumo do último turno"
      >
        {summary}
      </p>
      {speaking ? (
        <button
          type="button"
          onClick={stop}
          title="Parar o áudio"
          className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
        >
          <Icon as={Square} size={11} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => speakSummary(summary)}
          title="Ouvir o resumo"
          className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
        >
          <Icon as={Play} size={11} />
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          // Dispensar o chip some com o único controle visível do áudio — para junto.
          stop()
          setSummary(null)
        }}
        title="Dispensar o resumo"
        className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
      >
        <Icon as={X} size={11} />
      </button>
    </div>
  )
}
