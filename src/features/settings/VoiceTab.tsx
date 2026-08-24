import { useEffect, useState } from 'react'
import { prefsApi, voiceApi } from '@/lib/ipc'
import type { VoiceConfigStatus } from '@shared/types/ipc'
import {
  CONDENSE_THRESHOLD_KEY,
  DEFAULT_CONDENSE_THRESHOLD_WORDS,
} from '@/features/sessions/voice/voice-recorder-state'
import { useVoiceModeStore } from '@/features/sessions/voice/use-voice-mode'
import { stopSpeaking } from '@/features/sessions/voice/useVoiceSpeaker'

// Aba "Voz": status da config (~/.config/voz/voz.env), threshold de condensação
// do ditado e o modo voz (resumo falado). Chaves e credenciais vivem SÓ no
// voz.env — esta tela nunca as exibe nem edita.
export function VoiceTab({ open }: { open: boolean }) {
  const [status, setStatus] = useState<VoiceConfigStatus | null>(null)
  // '' = campo esvaziado no meio da edição — nunca persiste (persistir viraria
  // threshold 0 e TODO ditado passaria a condensar).
  const [threshold, setThreshold] = useState<number | ''>(DEFAULT_CONDENSE_THRESHOLD_WORDS)
  const voiceMode = useVoiceModeStore((s) => s.enabled)
  const setVoiceMode = useVoiceModeStore((s) => s.setEnabled)

  useEffect(() => {
    if (!open) return
    setStatus(null)
    void voiceApi.configStatus().then(setStatus)
    void prefsApi.get<number>(CONDENSE_THRESHOLD_KEY).then((v) => {
      setThreshold(typeof v === 'number' && v >= 0 ? v : DEFAULT_CONDENSE_THRESHOLD_WORDS)
    })
    void useVoiceModeStore.getState().load()
  }, [open])

  function updateThreshold(raw: string) {
    if (raw === '') {
      setThreshold('')
      return
    }
    const v = Number(raw)
    setThreshold(v)
    if (Number.isFinite(v) && v >= 0) void prefsApi.set(CONDENSE_THRESHOLD_KEY, v)
  }

  function settleThreshold() {
    if (threshold !== '') return
    // Sair do campo vazio volta ao padrão (e persiste, pra tela e resumidor
    // concordarem sobre o valor em vigor).
    setThreshold(DEFAULT_CONDENSE_THRESHOLD_WORDS)
    void prefsApi.set(CONDENSE_THRESHOLD_KEY, DEFAULT_CONDENSE_THRESHOLD_WORDS)
  }

  function updateVoiceMode(v: boolean) {
    // Desligar corta a fala na hora — mesma regra do toggle do composer.
    if (!v) stopSpeaking()
    void setVoiceMode(v)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Configuração
        </div>
        {status === null ? (
          <div className="text-sm text-[var(--color-text-dim)]">carregando…</div>
        ) : status.ok ? (
          <>
            <div className="text-sm text-[var(--color-text)]">Endpoint configurado</div>
            <div
              className="mt-1 truncate font-mono text-xs text-[var(--color-text-dim)]"
              title={status.sttUrl}
            >
              {status.sttUrl}
            </div>
          </>
        ) : (
          <div className="text-sm text-[var(--color-danger,#ef4444)]">{status.error}</div>
        )}
        {status !== null && (
          <div className="mt-2 border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-text-dim)]">
            Endpoints e chaves ficam em{' '}
            <code className="font-mono text-[var(--color-text)]">{status.path}</code> — edite o
            arquivo direto; nenhuma credencial aparece aqui.
          </div>
        )}
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Ditado
        </div>
        <label className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">
              Condensar ditados a partir de (palavras)
            </div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Ditados com pelo menos este número de palavras passam por uma condensação (LLM) antes
              de entrar no composer. Mais curtos entram direto.
            </div>
          </div>
          <input
            type="number"
            min={0}
            step={1}
            value={threshold}
            onChange={(e) => updateThreshold(e.target.value)}
            onBlur={settleThreshold}
            className="w-24 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1 text-right text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </label>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Resumo falado
        </div>
        <label className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Modo voz</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Ao fim de cada turno, gera um resumo curto da resposta e fala em voz alta na sessão
              ativa. É o mesmo toggle da barra do composer.
            </div>
          </div>
          <input
            type="checkbox"
            checked={voiceMode}
            onChange={(e) => updateVoiceMode(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          />
        </label>
      </div>
    </div>
  )
}
