import { useEffect, useState } from 'react'
import { prefsApi } from '@/lib/ipc'

const AUTO_DETECT_KEY = 'meeting_auto_detect'
const AUTO_RECORD_KEY = 'meeting_auto_record'

export function MeetingsSection({ open }: { open: boolean }) {
  const [autoDetect, setAutoDetect] = useState(true)
  const [autoRecord, setAutoRecord] = useState(false)

  useEffect(() => {
    if (!open) return
    void prefsApi.get<boolean>(AUTO_DETECT_KEY).then((v) => setAutoDetect(v ?? true))
    void prefsApi.get<boolean>(AUTO_RECORD_KEY).then((v) => setAutoRecord(v ?? false))
  }, [open])

  function updateAutoDetect(v: boolean) {
    setAutoDetect(v)
    void prefsApi.set(AUTO_DETECT_KEY, v)
  }

  function updateAutoRecord(v: boolean) {
    setAutoRecord(v)
    void prefsApi.set(AUTO_RECORD_KEY, v)
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
        Reuniões
      </div>
      <label className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--color-text)]">
            Detectar reuniões automaticamente (PipeWire)
          </div>
          <div className="text-xs text-[var(--color-text-dim)]">
            Avisa quando um app começa a usar o microfone, com a opção de gravar. Ligado por padrão.
          </div>
        </div>
        <input
          type="checkbox"
          checked={autoDetect}
          onChange={(e) => updateAutoDetect(e.target.checked)}
          className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
        />
      </label>

      <label
        className={`mt-3 flex items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3 ${
          autoDetect ? '' : 'opacity-50'
        }`}
      >
        <div className="min-w-0">
          <div className="text-sm text-[var(--color-text)]">Gravar automaticamente ao detectar</div>
          <div className="text-xs text-[var(--color-text-dim)]">
            Começa a gravação sem perguntar assim que a reunião é detectada. Desligado por padrão.
          </div>
        </div>
        <input
          type="checkbox"
          checked={autoRecord}
          disabled={!autoDetect}
          onChange={(e) => updateAutoRecord(e.target.checked)}
          className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
        />
      </label>
    </div>
  )
}
