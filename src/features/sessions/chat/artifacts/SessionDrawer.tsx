import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { ArrowUp, MessagesSquare, TerminalSquare, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu, type MenuSection } from '@/components/ui/Menu'
import { ControlPill } from '@/features/brand'
import { designApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import { useSessionTargets } from '@/features/design/ask-claude/useSessionTargets'
import { ChatView, type ChatViewHandle } from '../ChatView'
import { KIND_LABEL } from './ArtifactCard'
import { artifactRefKey, type ArtifactRef } from './artifact-refs'
import {
  DRAWER_CANVAS_MIN_WIDTH,
  DRAWER_MIN_WIDTH,
  useSessionDrawerStore,
} from './sessionDrawerStore'
import { useLinkedSessions } from './useLinkedSessions'

// "Sessão" dentro dos editores de Diagramas e Design: a conversa da sessão que
// escreve o artefato numa gaveta à direita, com campo para responder — o
// usuário conversa sem sair do editor e vê o canvas mudar por trás.
//
// Só modo chat: o ChatView lê o transcript por IPC e não monta xterm, então a
// gaveta não disputa a PTY com a aba (não precisa de lease, como o CrewPeek em
// chat). O envio usa design:ask-session, que passa pelo injetor com guarda.

export function SessionDrawerButton({ artifact }: { artifact: ArtifactRef; title?: string }) {
  const open = useSessionDrawerStore((s) => s.openKey === artifactRefKey(artifact))
  const toggle = useSessionDrawerStore((s) => s.toggle)
  const linked = useLinkedSessions(artifact)
  return (
    <button
      type="button"
      onClick={() => toggle(artifact)}
      aria-pressed={open}
      title={
        linked.length
          ? 'Conversar com a sessão que escreve este artefato'
          : 'Conversar com uma sessão'
      }
      className={`relative inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        open
          ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]'
          : 'text-[var(--color-text)] hover:bg-[var(--color-surface-2)]'
      }`}
    >
      <Icon as={MessagesSquare} size={14} />
      Sessão
      {linked.length > 0 && !open && (
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
      )}
    </button>
  )
}

// Coluna à direita do editor, irmã do canvas no mesmo flex: abrir a gaveta
// empurra o layout (canvas e painel de propriedades continuam visíveis) em vez
// de cobrir. Redimensionável pela borda esquerda.
export function SessionDrawerDock({ artifact, title }: { artifact: ArtifactRef; title: string }) {
  const open = useSessionDrawerStore((s) => s.openKey === artifactRefKey(artifact))
  const close = useSessionDrawerStore((s) => s.close)
  const linked = useLinkedSessions(open ? artifact : null)
  if (!open) return null
  return <SessionDrawer artifact={artifact} title={title} linked={linked} onClose={close} />
}

const KEY_STEP_PX = 24

// Largura que a gaveta pode ocupar sem espremer o canvas abaixo do mínimo.
// Colunas fixas irmãs (camadas, propriedades) não cedem espaço, então saem da
// conta. 0 = contêiner ainda sem layout: não limita.
function roomFor(el: HTMLElement | null): number {
  const host = el?.parentElement
  if (!host?.clientWidth) return Infinity
  const fixed = [...host.children]
    .filter((c) => c !== el && getComputedStyle(c).flexShrink === '0')
    .reduce((sum, c) => sum + (c as HTMLElement).offsetWidth, 0)
  return host.clientWidth - fixed - DRAWER_CANVAS_MIN_WIDTH
}

function useDrawerResize(ref: RefObject<HTMLElement | null>) {
  const width = useSessionDrawerStore((s) => s.width)
  const setWidth = useSessionDrawerStore((s) => s.setWidth)
  const drag = useRef<{ startX: number; startW: number } | null>(null)
  const clamp = useCallback(
    (w: number) => {
      return Math.max(DRAWER_MIN_WIDTH, Math.min(w, roomFor(ref.current)))
    },
    [ref],
  )
  return {
    width: clamp(width),
    handle: {
      onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { startX: e.clientX, startW: ref.current?.offsetWidth ?? width }
      },
      onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
        if (!drag.current || !ref.current) return
        ref.current.style.width = `${clamp(drag.current.startW + drag.current.startX - e.clientX)}px`
      },
      onPointerUp: () => {
        if (!drag.current) return
        drag.current = null
        setWidth(ref.current?.offsetWidth ?? width)
      },
      onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        setWidth(clamp(width + (e.key === 'ArrowLeft' ? KEY_STEP_PX : -KEY_STEP_PX)))
      },
    },
  }
}

interface Option {
  sessionId: string
  label: string
  detail: string | null
  running: boolean
  linked: boolean
}

function useOptions(linked: string[]): Option[] {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const { targets } = useSessionTargets()
  return useMemo(() => {
    const opts: Option[] = linked.map((sessionId) => {
      const live = liveSessions.find((s) => s.id === sessionId)
      const target = targets.find((t) => t.sessionId === sessionId)
      return {
        sessionId,
        label: target?.label ?? live?.title ?? live?.name ?? 'Sessão encerrada',
        detail: target?.detail ?? live?.projectName ?? null,
        running: !!target,
        linked: true,
      }
    })
    for (const t of targets) {
      if (linked.includes(t.sessionId)) continue
      opts.push({
        sessionId: t.sessionId,
        label: t.label,
        detail: t.detail,
        running: true,
        linked: false,
      })
    }
    return opts
  }, [linked, liveSessions, targets])
}

function SessionDrawer({
  artifact,
  title,
  linked,
  onClose,
}: {
  artifact: ArtifactRef
  title: string
  linked: string[]
  onClose: () => void
}) {
  const options = useOptions(linked)
  const [picked, setPicked] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const current =
    options.find((o) => o.sessionId === picked) ??
    options.find((o) => o.linked && o.running) ??
    options.find((o) => o.linked) ??
    null
  const live = useAppStore((s) => s.liveSessions.find((l) => l.id === current?.sessionId))
  const dialogRef = useRef<HTMLElement>(null)
  const resize = useDrawerResize(dialogRef)

  useEffect(() => {
    requestAnimationFrame(() => dialogRef.current?.focus())
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.stopPropagation()
      onClose()
    }
  }

  const sections: MenuSection[] = [
    {
      title: `Escreveu este ${KIND_LABEL[artifact.kind].toLowerCase()}`,
      items: options
        .filter((o) => o.linked)
        .map((o) => ({
          label: o.detail ? `${o.label} · ${o.detail}` : o.label,
          active: o.sessionId === current?.sessionId,
          onClick: () => setPicked(o.sessionId),
        })),
    },
    {
      title: 'Outras sessões abertas',
      items: options
        .filter((o) => !o.linked)
        .map((o) => ({
          label: o.detail ? `${o.label} · ${o.detail}` : o.label,
          active: o.sessionId === current?.sessionId,
          onClick: () => setPicked(o.sessionId),
        })),
    },
  ].filter((s) => s.items.length > 0)

  return (
    <aside
      ref={dialogRef}
      aria-label={`Sessão de ${title}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ width: resize.width }}
      className="pw-panel-in relative flex h-full min-h-0 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] outline-none"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar gaveta da sessão"
        aria-valuenow={Math.round(resize.width)}
        tabIndex={0}
        {...resize.handle}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent hover:after:bg-[var(--color-accent)]/60 focus-visible:outline-none focus-visible:after:bg-[var(--color-accent)]"
      />
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Icon as={MessagesSquare} size={14} className="shrink-0 text-[var(--color-text-dim)]" />
        {sections.length > 0 ? (
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            sections={sections}
            portal
            align="left"
          >
            <ControlPill
              icon={TerminalSquare}
              caret
              label={current?.label ?? 'Escolher sessão'}
              title={current?.detail ?? undefined}
              onClick={() => setMenuOpen((o) => !o)}
              className="max-w-[16rem]"
            />
          </Menu>
        ) : (
          <span className="text-sm text-[var(--color-text-dim)]">Nenhuma sessão aberta</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          title="Fechar (Esc)"
          className="rounded-md p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <Icon as={X} size={14} />
        </button>
      </header>
      {current ? (
        <ConversationBody
          key={current.sessionId}
          sessionId={current.sessionId}
          ccSessionId={live?.ccSessionId ?? null}
          status={live?.status}
          running={current.running}
          artifact={artifact}
          title={title}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <p className="text-sm text-[var(--color-text)]">
            Nenhuma sessão escreveu este {KIND_LABEL[artifact.kind].toLowerCase()} ainda.
          </p>
          <p className="text-xs text-[var(--color-text-dim)]">
            {sections.length > 0
              ? 'Escolha uma sessão aberta acima para conversar sobre ele.'
              : 'Abra uma sessão do Claude e volte aqui para conversar sobre ele.'}
          </p>
        </div>
      )}
    </aside>
  )
}

// O pedido leva o artefato junto: a sessão escolhida pode não ser a que o criou.
export function artifactPrompt(artifact: ArtifactRef, title: string, text: string): string {
  const what = artifact.kind === 'diagram' ? 'diagrama' : 'design'
  const idField = artifact.kind === 'diagram' ? 'diagram id' : 'design docId'
  return `Sobre o ${what} "${title}" (${idField} ${artifact.id}, aberto no Pitwall): ${text.trim()}`
}

function ConversationBody({
  sessionId,
  ccSessionId,
  status,
  running,
  artifact,
  title,
}: {
  sessionId: string
  ccSessionId: string | null
  status: Parameters<typeof ChatView>[0]['status']
  running: boolean
  artifact: ArtifactRef
  title: string
}) {
  const chatRef = useRef<ChatViewHandle>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    const body = text.trim()
    if (!body || busy || !running) return
    setBusy(true)
    setError(null)
    const prompt = artifactPrompt(artifact, title, body)
    try {
      await designApi.askSession({ sessionId, prompt, submit: true })
      chatRef.current?.pushEcho(prompt)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível enviar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <ChatView
          ref={chatRef}
          sessionId={sessionId}
          ccSessionId={ccSessionId}
          status={status}
          artifactSide={false}
          emptyHint="Sem conversa ainda. Escreva abaixo para mandar a primeira mensagem."
        />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
        className="shrink-0 border-t border-[var(--color-border)] p-3"
      >
        <div className="flex items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 focus-within:border-[var(--color-accent)]/60">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            disabled={!running || busy}
            rows={2}
            aria-label="Mensagem para a sessão"
            placeholder={
              running
                ? `Peça uma mudança no ${artifact.kind === 'diagram' ? 'diagrama' : 'design'}…`
                : 'Sessão encerrada — reabra para conversar.'
            }
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!running || busy || !text.trim()}
            aria-label="Enviar"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)] text-[var(--color-bg)] motion-safe:transition-opacity disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
          >
            <Icon as={ArrowUp} size={14} />
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-1.5 text-xs text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </form>
    </>
  )
}
