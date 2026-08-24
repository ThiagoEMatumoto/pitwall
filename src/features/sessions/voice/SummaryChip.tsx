import { useEffect, useState } from 'react'
import { AudioLines, Square, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { voiceApi } from '@/lib/ipc'
import { isActiveVoiceSession } from './active-session'
import { useVoiceModeStore } from './use-voice-mode'
import { speakSummary, useVoiceSpeaker } from './useVoiceSpeaker'

interface Props {
  ccSessionId: string | null
}

// Faixa discreta ACIMA do composer com o último resumo de turno (voice:summary).
// O transcript JSONL é read-only — o resumo NÃO entra no fluxo de mensagens do
// chat; vive só aqui. O chip aparece em qualquer sessão que tenha resumo; o
// ÁUDIO só toca se a sessão é a ativa E o modo voz está ligado.
export function SummaryChip({ ccSessionId }: Props) {
  const [summary, setSummary] = useState<string | null>(null)
  const { speaking, stop } = useVoiceSpeaker()
  const loadVoiceMode = useVoiceModeStore((s) => s.load)

  useEffect(() => {
    void loadVoiceMode()
  }, [loadVoiceMode])

  useEffect(() => {
    if (!ccSessionId) return
    return voiceApi.onSummary((event) => {
      if (event.ccSessionId !== ccSessionId) return
      setSummary(event.summary)
      // O main já gateia na pref, mas ela pode ter sido desligada entre o
      // resumo nascer e chegar — o renderer re-checa antes de falar.
      if (useVoiceModeStore.getState().enabled && isActiveVoiceSession(ccSessionId)) {
        speakSummary(event.summary)
      }
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
        title="Resumo do último turno (modo voz)"
      >
        {summary}
      </p>
      {speaking && (
        <button
          type="button"
          onClick={stop}
          title="Parar o áudio"
          className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
        >
          <Icon as={Square} size={11} />
        </button>
      )}
      <button
        type="button"
        onClick={() => setSummary(null)}
        title="Dispensar o resumo"
        className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
      >
        <Icon as={X} size={11} />
      </button>
    </div>
  )
}
