import { useState } from 'react'
import { ChevronRight, MessageSquareReply, PanelRightOpen, Users } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { STATUS_COLOR, STATUS_LABEL } from '@/features/handoffs/HandoffCard'
import { stripUnsafeDisplay } from '../../../../shared/tui/permission-request'
import type {
  HandoffWakeEnvelope,
  HandoffWakeUpdate,
} from '../../../../shared/handoff-wake-envelope'
import type { HandoffStatus } from '../../../../shared/types/ipc'

// Verbos dos WakeReason do produtor (handoff-wake.ts), na voz da filha.
const REASON_VERB: Record<string, string> = {
  asked: 'perguntou',
  reported: 'reportou',
  failed: 'falhou',
  interrupted: 'foi interrompida',
  spawn_failed: 'não subiu',
  answered: 'teve um pedido respondido',
  rejected: 'teve um pedido rejeitado',
}

const BODY_PREVIEW_CHARS = 280

function statusOf(u: HandoffWakeUpdate): { label: string; color: string } {
  const s = u.status as HandoffStatus
  return {
    label: STATUS_LABEL[s] ?? u.status,
    color: STATUS_COLOR[s] ?? 'var(--color-text-dim)',
  }
}

function who(u: HandoffWakeUpdate): string {
  return u.alias ?? 'filha sem apelido'
}

export function asksForAnswer(u: HandoffWakeUpdate): boolean {
  return u.status === 'needs_input' || u.reasons.includes('asked')
}

function verbOf(u: HandoffWakeUpdate): string {
  const last = u.reasons[u.reasons.length - 1]
  return (last && REASON_VERB[last]) ?? 'mudou de estado'
}

// Uma linha para tiles e previews ("mauricio-greet perguntou").
export function handoffWakeSummary(env: HandoffWakeEnvelope): string {
  const total = env.updates.length + env.overflow
  if (env.updates.length === 1 && env.overflow === 0) {
    const u = env.updates[0]
    return `${who(u)} ${verbOf(u)}`
  }
  return `Atualização de ${total} filhas`
}

function UpdateRow({ u }: { u: HandoffWakeUpdate }) {
  const body = stripUnsafeDisplay(u.body).trim()
  const long = body.length > BODY_PREVIEW_CHARS
  const [open, setOpen] = useState(false)
  const { label, color } = statusOf(u)
  const answer = asksForAnswer(u)
  return (
    <li className="flex flex-col gap-1.5" data-testid="handoff-update-row">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="min-w-0 max-w-full truncate font-mono text-[12.5px] font-semibold text-[var(--color-text)]"
          title={who(u)}
        >
          {who(u)}
        </span>
        <span className="text-[12px] text-[var(--color-text-dim)]">{verbOf(u)}</span>
        <span
          className="rounded-full border px-1.5 text-[10.5px] leading-4"
          style={{
            color,
            borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
            background: `color-mix(in srgb, ${color} 10%, transparent)`,
          }}
        >
          {label}
        </span>
      </div>
      {body !== '' && (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--color-text)]/90">
          {long && !open ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body}
          {u.truncated && (open || !long) && (
            <span className="text-[var(--color-text-dim)]">
              {' '}
              (resumo cortado; o resto está na filha)
            </span>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <button
          type="button"
          data-testid="handoff-update-open"
          onClick={() => useCrewDockStore.getState().openPeek(u.handoffId)}
          className="inline-flex items-center gap-1 font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          <Icon as={answer ? MessageSquareReply : PanelRightOpen} size={12} />
          {answer ? 'Responder' : 'Abrir filha'}
        </button>
        {long && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            <Icon
              as={ChevronRight}
              size={11}
              className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
            />
            {open ? 'Mostrar menos' : 'Mostrar tudo'}
          </button>
        )}
      </div>
    </li>
  )
}

// O envelope que o Pitwall cola na mãe quando uma filha pergunta/reporta. Chega
// como turno 'user', mas não foi o usuário quem escreveu: vira card, não bolha.
export function HandoffUpdateCard({ envelope }: { envelope: HandoffWakeEnvelope }) {
  const total = envelope.updates.length + envelope.overflow
  return (
    <section
      data-testid="handoff-update-card"
      aria-label="Atualização das filhas"
      className="pw-pop flex flex-col gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3"
      style={{ borderLeft: '3px solid var(--color-accent)' }}
    >
      <header className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-dim)]">
        <Icon as={Users} size={13} className="shrink-0 text-[var(--color-accent)]" />
        <span className="min-w-0 truncate">
          {total === 1 ? 'Atualização de uma filha' : `Atualização de ${total} filhas`} · enviada
          pelo Pitwall
        </span>
      </header>
      <ul className="flex flex-col gap-3">
        {envelope.updates.map((u) => (
          <UpdateRow key={u.handoffId} u={u} />
        ))}
      </ul>
      {envelope.overflow > 0 && (
        <p className="text-[11.5px] text-[var(--color-text-dim)]">
          +{envelope.overflow} {envelope.overflow === 1 ? 'atualização' : 'atualizações'} no painel
          de filhas.
        </p>
      )}
    </section>
  )
}
