import { useEffect, useState, type CSSProperties } from 'react'
import { windowApi } from '@/lib/ipc'
import { PitwallLogo, type PitwallLogoState } from '@/features/brand'
import { useWaitingCount } from '@/features/session-switcher/useWaitingCount'
import { RecordingPill } from '@/features/meetings/RecordingPill'
import { UsageWidget } from './UsageWidget'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

// Estado do símbolo reflete a fila de "no box": 3+ vira fila, 1-2 box aberto,
// 0 mostra o muro em pista (sem parada).
function logoState(waiting: number): PitwallLogoState {
  if (waiting >= 3) return 'fila'
  if (waiting >= 1) return 'box-aberto'
  return 'em-pista'
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const waitingCount = useWaitingCount()

  useEffect(() => {
    void windowApi.isMaximized().then(setMaximized)
    return windowApi.onMaximizeChange(setMaximized)
  }, [])

  return (
    <header
      className="flex h-10 shrink-0 items-center justify-between border-b pl-3.5 pr-1 select-none"
      style={{
        ...drag,
        background: 'color-mix(in srgb, var(--color-surface) 85%, transparent)',
        borderColor: 'var(--color-border)',
      }}
      onDoubleClick={() => void windowApi.toggleMaximize()}
    >
      <div className="flex items-center gap-2.5">
        <PitwallLogo state={logoState(waitingCount)} size={16} title="Pitwall" />
        <span
          className="leading-none"
          style={{ fontWeight: 700, fontSize: 13, letterSpacing: '-0.02em' }}
        >
          Pitwall
        </span>
        {waitingCount > 0 && (
          <span
            className="rounded-full px-2.5 py-0.5 text-[10px] font-medium leading-none"
            style={{
              background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
              color: 'var(--color-accent)',
            }}
            title={`${waitingCount} sessão(ões) no box — aguardando você`}
          >
            {waitingCount} no box
          </span>
        )}
        <RecordingPill />
      </div>

      <div className="flex items-center gap-2" style={noDrag}>
        <UsageWidget />
        <WindowControls maximized={maximized} />
      </div>
    </header>
  )
}

function WindowControls({ maximized }: { maximized: boolean }) {
  return (
    <div className="flex items-center" style={noDrag}>
      <ControlButton label="Minimizar" onClick={() => void windowApi.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </ControlButton>

      <ControlButton
        label={maximized ? 'Restaurar' : 'Maximizar'}
        onClick={() => void windowApi.toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="2.5" y="1" width="6.5" height="6.5" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="1" y="2.5" width="6.5" height="6.5" fill="var(--color-surface)" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </ControlButton>

      <ControlButton label="Fechar" danger onClick={() => void windowApi.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </ControlButton>
    </div>
  )
}

function ControlButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={noDrag}
      className={`flex h-10 w-11 items-center justify-center text-[var(--color-text-dim)] transition-colors ${
        danger
          ? 'hover:bg-[var(--color-danger)] hover:text-[var(--color-bg)]'
          : 'hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}
