import { useEffect, useState } from 'react'
import { prefsApi, voiceApi } from '@/lib/ipc'
import type { VoiceConfigStatus } from '@shared/types/ipc'
import {
  CONDENSE_ENABLED_KEY,
  CONDENSE_THRESHOLD_KEY,
  DEFAULT_CONDENSE_THRESHOLD_WORDS,
} from '@/features/sessions/voice/voice-recorder-state'

// Aba "Voz": status da config (~/.config/voz/voz.env) e a condensação do
// ditado (liga/desliga + threshold). O resumo de fim de turno não tem pref
// global — o toggle "Resumo auto" vive por sessão, na barra do composer.
// Chaves e credenciais vivem SÓ no voz.env — esta tela nunca as exibe nem edita.
export function VoiceTab({ open }: { open: boolean }) {
  const [status, setStatus] = useState<VoiceConfigStatus | null>(null)
  const [condenseEnabled, setCondenseEnabled] = useState(true)
  // '' = campo esvaziado no meio da edição — nunca persiste (persistir viraria
  // threshold 0 e TODO ditado passaria a condensar).
  const [threshold, setThreshold] = useState<number | ''>(DEFAULT_CONDENSE_THRESHOLD_WORDS)

  useEffect(() => {
    if (!open) return
    setStatus(null)
    void voiceApi.configStatus().then(setStatus)
    void prefsApi.get<number>(CONDENSE_THRESHOLD_KEY).then((v) => {
      setThreshold(typeof v === 'number' && v >= 0 ? v : DEFAULT_CONDENSE_THRESHOLD_WORDS)
    })
    // Default LIGADO: só um false explícito desliga (null = pref nunca tocada).
    void prefsApi.get<boolean>(CONDENSE_ENABLED_KEY).then((v) => {
      setCondenseEnabled(v !== false)
    })
  }, [open])

  function updateCondenseEnabled(v: boolean) {
    setCondenseEnabled(v)
    void prefsApi.set(CONDENSE_ENABLED_KEY, v)
  }

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
        <label className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Condensar ditados longos</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Passa ditados longos por uma condensação (LLM) que corta divagação e corrige termos
              técnicos antes de entrar no composer. Desligado, toda transcrição entra crua.
            </div>
          </div>
          <input
            type="checkbox"
            checked={condenseEnabled}
            onChange={(e) => updateCondenseEnabled(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          />
        </label>
        <label className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Condensar a partir de (palavras)</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Ditados com pelo menos este número de palavras passam pela condensação. Mais curtos
              entram direto.
            </div>
          </div>
          <input
            type="number"
            min={0}
            step={1}
            value={threshold}
            disabled={!condenseEnabled}
            onChange={(e) => updateThreshold(e.target.value)}
            onBlur={settleThreshold}
            className="w-24 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1 text-right text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
          />
        </label>
      </div>
    </div>
  )
}
