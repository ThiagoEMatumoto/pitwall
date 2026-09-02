import { AlertTriangle, MicOff } from 'lucide-react'
import { CopyButton } from '@/components/ui/CopyButton'
import { Icon } from '@/components/ui/Icon'
import { useMeetingsStore } from '@/store/meetingsStore'
import type { MeetingSetupStatus } from '../../../shared/types/ipc'

interface Props {
  setup: MeetingSetupStatus
  ignorePipewire: boolean
}

export function setupProblems(setup: MeetingSetupStatus, ignorePipewire: boolean): string[] {
  const problems: string[] = []
  if (!setup.pipewire && !ignorePipewire) {
    problems.push('PipeWire não encontrado — instale `pipewire` e `wireplumber` (comandos `pw-record`/`wpctl`).')
  } else if (setup.pipewire && (!setup.sink || !setup.source)) {
    problems.push('Sem dispositivo de áudio padrão — confira saída e microfone em `wpctl status`.')
  }
  if (!setup.stt.ok) {
    problems.push(
      setup.stt.url
        ? `Transcrição indisponível: ${setup.stt.error ?? 'servidor STT não respondeu'}.`
        : 'Configure `VOZ_STT_URL` (e a chave) em ~/.config/voz/voz.env para transcrever.',
    )
  }
  return problems
}

// Só o usuário mexe no ganho: o app aponta o comando, nunca roda wpctl set-*.
export const MIC_GAIN_COMMAND = 'wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 0.7'

export function micLowMessage(dbfs: number, source: string | null): string {
  return `Microfone muito baixo (${Math.round(dbfs)} dBFS em ${source ?? '@DEFAULT_AUDIO_SOURCE@'}). Suba o ganho:`
}

/** Mic baixo: o aviso da gravação em curso vence a medição do setup (mais recente). */
export function micLow(
  setup: MeetingSetupStatus | null,
  micWarning: { dbfs: number; source: string } | null | undefined,
): { dbfs: number; source: string | null } | null {
  if (micWarning) return micWarning
  if (setup?.micLevel.low && setup.micLevel.dbfs !== null) {
    return { dbfs: setup.micLevel.dbfs, source: setup.micLevel.source }
  }
  return null
}

export function SetupBanner({ setup, ignorePipewire }: Props) {
  const micWarning = useMeetingsStore((s) => s.live?.micWarning ?? null)
  const problems = setupProblems(setup, ignorePipewire)
  const low = micLow(setup, micWarning)
  if (problems.length === 0 && !low) return null
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-6 py-2.5 text-xs text-[var(--color-text)]"
    >
      <span className="mt-px text-[var(--color-warning)]">
        <Icon as={problems.length ? AlertTriangle : MicOff} />
      </span>
      <div className="flex flex-col gap-0.5">
        {problems.map((p) => (
          <p key={p}>{p}</p>
        ))}
        {low && (
          <p className="flex flex-wrap items-center gap-1.5">
            <span>{micLowMessage(low.dbfs, low.source)}</span>
            <code className="rounded bg-[var(--color-surface)] px-1 py-px">{MIC_GAIN_COMMAND}</code>
            <CopyButton text={MIC_GAIN_COMMAND} title="Copiar comando" />
          </p>
        )}
      </div>
    </div>
  )
}
