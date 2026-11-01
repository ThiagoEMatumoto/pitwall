import { useEffect, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

// "12s", "1min 05s": quanto tempo o turno atual está rodando.
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}min ${String(s % 60).padStart(2, '0')}s`
}

const EQ_DELAYS = [0, 160, 320]

// Indicador do turno em andamento: equalizer d'"A Régua" (a casa já usa pra
// "agente pensando") + tempo decorrido. O rótulo vai pro leitor de tela uma vez;
// o contador por segundo fica fora da região viva pra não virar ruído.
export function WorkingIndicator({ since, thinking }: { since: number; thinking: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <div className="chat-row-in flex items-center gap-2.5 px-2 text-xs text-[var(--color-text-dim)]">
      <span aria-hidden className="flex h-3 items-end gap-[2px]">
        {EQ_DELAYS.map((d) => (
          <span
            key={d}
            className="pw-eq-bar block h-3 w-[3px] rounded-full bg-[var(--color-accent)]"
            style={{ '--pw-eq-delay': `${d}ms` } as React.CSSProperties}
          />
        ))}
      </span>
      <span role="status" className="text-[var(--color-text)]/80">
        {thinking ? 'Pensando…' : 'Trabalhando…'}
      </span>
      <span aria-hidden className="tabular-nums">
        {formatElapsed(now - since)}
      </span>
    </div>
  )
}

// Atalho de volta ao fim quando o usuário subiu pra reler. Com conteúdo novo
// abaixo, diz isso; sem, é só o caminho de volta.
export function JumpToLatest({ unseen, onClick }: { unseen: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="chat-row-in absolute bottom-10 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] shadow-[0_6px_20px_rgba(0,0,0,0.35)] transition-colors hover:border-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
    >
      {unseen && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />}
      {unseen ? 'Novas mensagens' : 'Ir para o fim'}
      <Icon as={ArrowDown} size={12} />
    </button>
  )
}
