import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Frame, Layers, Send, Sparkles, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { designApi } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { useAppStore } from '@/store/appStore'
import { useDesignStore } from '@/store/designStore'
import {
  buildAskPrompt,
  buildTreeSummary,
  selectionLabel,
  type AskSelectionItem,
} from './build-prompt'
import { SessionPicker } from './SessionPicker'
import { useSessionTargets, type SessionTarget } from './useSessionTargets'

// Contextual "Ask Claude" bar. Mount it as an overlay inside the canvas host
// (the `relative` div wrapping CanvasStage in DesignArea) so it docks to the
// bottom of the stage. Opens through store.askOpen or the '/' key.

const MAX_ROWS = 4

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

function useSlashToOpen(enabled: boolean): void {
  const setAskOpen = useDesignStore((s) => s.setAskOpen)
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (useDesignStore.getState().askOpen || useDesignStore.getState().textEditing) return
      e.preventDefault()
      setAskOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, setAskOpen])
}

function useAskContext() {
  const docId = useDesignStore((s) => s.docId)
  const docTitle = useDesignStore((s) => s.doc?.title ?? '')
  const selection = useDesignStore((s) => s.selection)
  const artboard = useDesignStore((s) =>
    s.selection.artboardId ? s.artboards[s.selection.artboardId] : undefined,
  )

  return useMemo(() => {
    const items: AskSelectionItem[] = []
    if (artboard) {
      const byId = new Map<string, AskSelectionItem>()
      const walk = (n: (typeof artboard)['tree']): void => {
        byId.set(n.id, { id: n.id, name: n.name, tag: n.tag, kind: n.kind })
        n.children.forEach(walk)
      }
      walk(artboard.tree)
      for (const id of selection.nodeIds) {
        const hit = byId.get(id)
        if (hit) items.push(hit)
      }
    }
    return {
      docId,
      docTitle,
      artboardId: artboard?.meta.id ?? null,
      artboardName: artboard?.meta.name ?? null,
      selection: items,
      treeSummaryText: artboard ? buildTreeSummary(artboard.tree, selection.nodeIds) : undefined,
    }
  }, [docId, docTitle, artboard, selection])
}

export function AskClaudeComposer() {
  const open = useDesignStore((s) => s.askOpen)
  const setAskOpen = useDesignStore((s) => s.setAskOpen)
  const fitToArtboard = useDesignStore((s) => s.fitToArtboard)
  const openSession = useAppStore((s) => s.openSession)
  const ctx = useAskContext()
  const { targets, defaultTarget } = useSessionTargets()

  const [text, setText] = useState('')
  const [submit, setSubmit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<SessionTarget | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useSlashToOpen(ctx.docId !== null)

  // A picked session that died falls back to the default one.
  const target = targets.find((t) => t.sessionId === picked?.sessionId) ?? defaultTarget

  useEffect(() => {
    if (open) textareaRef.current?.focus()
  }, [open])

  if (!open) return null
  // No document (empty state): the request stands alone and Claude creates it.
  const noDoc = ctx.docId === null
  const sessionLabel = noDoc ? 'novo design' : ctx.docTitle

  const close = (): void => {
    setAskOpen(false)
    setText('')
  }

  const prompt = (): string =>
    buildAskPrompt({
      docId: ctx.docId,
      docTitle: ctx.docTitle,
      artboardId: ctx.artboardId,
      artboardName: ctx.artboardName,
      selection: ctx.selection,
      treeSummaryText: ctx.treeSummaryText,
      request: text,
    })

  const send = async (): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      if (target) {
        await designApi.askSession({
          sessionId: target.sessionId,
          prompt: prompt(),
          submit,
        })
        showToast({ title: `Enviado para ${target.label}` })
      } else {
        await openNewSession()
      }
      close()
    } catch (err) {
      showToast({
        title: 'Não foi possível enviar',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  // No repo on a design doc: a scratch session (repo=null) with the prompt as
  // initialCommand, which the main injects (and submits) on the first PTY data.
  const openNewSession = async (): Promise<void> => {
    if (!text.trim()) {
      showToast({ title: 'Escreva o pedido antes de abrir a sessão' })
      return
    }
    await openSession(
      null,
      null,
      null,
      null,
      undefined,
      undefined,
      `Design: ${sessionLabel}`,
      prompt(),
    )
    showToast({ title: `Sessão aberta para "${sessionLabel}"` })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const rows = Math.min(MAX_ROWS, Math.max(1, text.split('\n').length))

  return (
    <div
      role="dialog"
      aria-label="Ask Claude"
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex justify-center p-3"
    >
      <div className="flex w-full max-w-3xl flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-lg">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-text-dim)]">
          <Icon as={Sparkles} size={13} className="text-[var(--color-accent)]" />
          {ctx.artboardName ? (
            <button
              type="button"
              onClick={() => ctx.artboardId && fitToArtboard(ctx.artboardId)}
              title="Enquadrar artboard"
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 hover:text-[var(--color-text)]"
            >
              <Icon as={Frame} size={11} />
              {ctx.artboardName}
            </button>
          ) : (
            <span className="italic">
              {noDoc ? 'nenhum documento aberto' : 'nenhum artboard selecionado'}
            </span>
          )}
          {ctx.selection.map((item) => (
            <span
              key={item.id}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5"
              title={`${item.tag}#${item.id}`}
            >
              <Icon as={Layers} size={11} />
              {selectionLabel(item)}
            </span>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={close}
            title="Fechar (Esc)"
            className="rounded-md p-1 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Icon as={X} size={13} />
          </button>
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          rows={rows}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            noDoc
              ? 'Crie a landing page de … (Enter envia, Shift+Enter quebra linha)'
              : 'O que Claude deve fazer neste design? Enter envia, Shift+Enter quebra linha'
          }
          className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent)]"
        />

        <div className="flex items-center gap-2">
          <SessionPicker
            targets={targets}
            value={target}
            onChange={setPicked}
            onOpenNew={() => void openNewSession().then(close)}
            disabled={busy}
          />
          {target && (
            <div
              role="radiogroup"
              aria-label="Modo de envio"
              className="inline-flex overflow-hidden rounded-full border border-[var(--color-border)] text-xs"
            >
              {(
                [
                  { value: true, label: 'Enviar' },
                  { value: false, label: 'Só inserir' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  role="radio"
                  aria-checked={submit === opt.value}
                  onClick={() => setSubmit(opt.value)}
                  className={`px-2.5 py-1 transition ${
                    submit === opt.value
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)]'
                      : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => void send()}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-[var(--color-bg)] transition disabled:opacity-50"
            style={{ background: 'var(--gradient-brand)' }}
          >
            <Icon as={Send} size={12} />
            {target ? (submit ? 'Enviar' : 'Inserir') : 'Abrir sessão'}
          </button>
        </div>
      </div>
    </div>
  )
}
