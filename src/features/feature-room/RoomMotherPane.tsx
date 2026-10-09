import { useEffect } from 'react'
import { Crown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Kbd } from '@/components/ui/ShortcutHints'
import { SWITCH_DEBOUNCE_MS, useSettled } from '@/features/session-canvas/MotherDock'
import { Terminal } from '@/features/sessions/Terminal'
import { useTerminalLease } from '@/features/sessions/terminal-lease'
import { sessionFromLiveSession, useAppStore } from '@/store/appStore'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { EXEC_LABEL } from './room-labels'
import type { RoomMotherTab } from './room-model'
import { COMPACT, ExecDot } from './room-ui'

export type MotherMode = 'chat' | 'terminal'

interface Props {
  mothers: RoomMotherTab[]
  motherId: string
  mode: MotherMode
  // Coluna ativa do split: filete + aria-current; os atalhos da sala agem nela.
  active: boolean
  onToggleMode: () => void
  onFocus: (sessionId: string) => void
  onPeek: (sessionId: string) => void
}

// Centro da Room: o chat ao vivo da mãe (o mesmo Terminal do MotherDock, em modo
// chat). Segura a lease 'room' da PTY: a aba mostra "Aberta na Room" e uma modal
// por cima toma a PTY e a devolve ao fechar.
export function RoomMotherPane({
  mothers,
  motherId,
  mode,
  active,
  onToggleMode,
  onFocus,
  onPeek,
}: Props) {
  // Trocar de tab remonta o xterm e manda resize: espera o clique assentar.
  const shownId = useSettled(motherId, SWITCH_DEBOUNCE_MS)
  const live = useAppStore((s) =>
    shownId ? (s.liveSessions.find((l) => l.id === shownId && l.status !== 'ended') ?? null) : null,
  )
  const tab = mothers.find((m) => m.sessionId === shownId) ?? null

  useEffect(() => {
    if (!shownId) return
    const lease = useTerminalLease.getState()
    lease.acquire(shownId, 'room')
    return () => useTerminalLease.getState().release(shownId, 'room')
  }, [shownId])

  if (!shownId || !live) {
    return (
      <section
        data-testid="room-mother-connecting"
        aria-busy
        className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-[var(--color-text-dim)]"
      >
        Ligando a sessão-mãe…
      </section>
    )
  }

  const title = tab?.title ?? stripUnsafeDisplay(live.title ?? live.name ?? 'Sessão-mãe')
  const repo = tab?.repoLabel ?? live.repo?.label ?? ''
  return (
    <section
      data-testid="room-mother"
      data-session-id={shownId}
      data-mode={mode}
      aria-current={active ? 'true' : undefined}
      aria-label={`Sessão-mãe ${title}`}
      onFocusCapture={() => !active && onFocus(shownId)}
      onMouseDownCapture={() => !active && onFocus(shownId)}
      className={`flex min-h-0 min-w-0 flex-1 flex-col border-t-2 ${
        active ? 'border-[var(--color-accent)]' : 'border-transparent'
      }`}
    >
      <header className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-2">
        <Icon as={Crown} size={14} className="shrink-0 text-[var(--color-accent)]" />
        <span
          className="min-w-0 truncate text-[15px] font-semibold"
          data-testid="room-mother-title"
        >
          {title}
        </span>
        {repo && (
          <span className="shrink-0 font-mono text-[12px] text-[var(--color-text-dim)]">
            {repo}
          </span>
        )}
        {tab && (
          <span
            className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--color-text-dim)]"
            data-testid="room-mother-status"
          >
            <ExecDot exec={tab.exec} />
            {tab.waitingOnHuman ? 'esperando você' : EXEC_LABEL[tab.exec]}
          </span>
        )}
        <span className="ml-auto" />
        <Button
          variant="ghost"
          className={COMPACT}
          onClick={() => onPeek(shownId)}
          aria-label={`Peek em ${title}`}
          data-testid="room-mother-peek"
        >
          Peek
        </Button>
        <div
          role="group"
          aria-label="Modo da mãe"
          className="flex shrink-0 overflow-hidden rounded-md border border-[var(--color-border)]"
        >
          {(['chat', 'terminal'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              title="Ctrl+."
              data-testid={`room-mother-mode-${m}`}
              onClick={() => mode !== m && onToggleMode()}
              className={`px-2.5 py-1 text-[12px] ${
                mode === m
                  ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
              }`}
            >
              {m === 'chat' ? 'Chat' : 'Terminal'}
            </button>
          ))}
        </div>
      </header>
      {tab?.waitingOnHuman && (
        <div
          role="status"
          data-testid="room-mother-waiting"
          className="border-b border-[var(--color-border)] px-4 py-1.5 text-[12.5px] text-[var(--color-warning)]"
        >
          {title} está esperando sua resposta no pedido. Responda para ela seguir.
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex flex-col">
          <Terminal
            key={shownId}
            session={sessionFromLiveSession(live, null)}
            repoLabel={live.repo?.label ?? 'Avulsa'}
            repoPath={live.repo?.path ?? ''}
            projectName={live.projectName ?? ''}
            projectIcon={live.projectIcon}
            projectColor={live.projectColor}
            mode={mode}
            chrome="bare"
            leaseHost="room"
            onToggleMode={onToggleMode}
            // Encerrar a mãe pela TUI: a Room volta sozinha ao estado sem mãe.
            onClose={() => {}}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] px-4 py-1 text-[11.5px] text-[var(--color-text-dim)]">
        <span>
          <Kbd>/</Kbd> focar composer
        </span>
        <span>
          <Kbd>J</Kbd> <Kbd>K</Kbd> navegar fila
        </span>
        <span>
          <Kbd>1</Kbd> <Kbd>2</Kbd> <Kbd>3</Kbd> responder pedido
        </span>
        <span>
          <Kbd>Ctrl</Kbd>+<Kbd>.</Kbd> Chat⇄Terminal
        </span>
      </div>
    </section>
  )
}

// A partir da 4ª mãe: as excedentes viram botões na borda; clicar troca de lugar
// com a coluna ativa.
export function MotherOverflow({
  mothers,
  onSwap,
}: {
  mothers: RoomMotherTab[]
  onSwap: (sessionId: string) => void
}) {
  return (
    <div
      role="group"
      aria-label="Mais mães nesta feature"
      data-testid="room-mother-overflow"
      className="flex shrink-0 flex-col gap-1 border-l border-[var(--color-border)] p-1.5 max-[900px]:flex-row max-[900px]:border-l-0 max-[900px]:border-t"
    >
      {mothers.map((m) => (
        <button
          key={m.sessionId}
          type="button"
          data-testid="room-mother-tab"
          data-session-id={m.sessionId}
          onClick={() => onSwap(m.sessionId)}
          title={m.purpose ?? m.title}
          aria-label={`Trazer ${m.title} para o split`}
          className="flex max-w-[160px] items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <Icon as={Crown} size={11} className="shrink-0" />
          {m.waitingOnHuman && (
            <span
              aria-label="esperando você"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-danger)]"
            />
          )}
          <span className="truncate">{m.title}</span>
        </button>
      ))}
    </div>
  )
}
