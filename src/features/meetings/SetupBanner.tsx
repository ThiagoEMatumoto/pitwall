import { AlertTriangle } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
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

export function SetupBanner({ setup, ignorePipewire }: Props) {
  const problems = setupProblems(setup, ignorePipewire)
  if (problems.length === 0) return null
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-6 py-2.5 text-xs text-[var(--color-text)]"
    >
      <span className="mt-px text-[var(--color-warning)]">
        <Icon as={AlertTriangle} />
      </span>
      <div className="flex flex-col gap-0.5">
        {problems.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
    </div>
  )
}
