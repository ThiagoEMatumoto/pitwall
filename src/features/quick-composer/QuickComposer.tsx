import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { CornerDownLeft, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/features/brand'
import { Icon } from '@/components/ui/Icon'
import { sendToApi } from '@/lib/ipc'
import {
  MentionMenu,
  NO_SESSION_MATCH,
  SessionPill,
  useMentionMenu,
} from '@/features/sessions/MentionMenu'
import {
  applyCompletion,
  parseSend,
  type ActiveToken,
  type ParsedSend,
} from '@/features/sessions/mention-parser'
import { TargetPicker } from './TargetPicker'
import { mentionPlacement, type MentionPlacement } from './mention-placement'
import { counterLines } from './queue-counters'
import { defaultWhen, sendRefusalReason, type SendTarget } from './target-search'
import { usePromptQueue, useQuickComposerStore, useSendTargets } from './quick-composer-store'
import { isAgentAskEnvelope } from '../../../shared/agent-ask'
import type {
  PromptQueueSnapshot,
  QueuedPrompt,
  ScreenPreview,
  SendPromptResult,
  SendPromptWhen,
} from '../../../shared/types/send-prompt'

const PREVIEW_POLL_MS = 800

function useScreenPreview(sessionId: string | null): ScreenPreview | null | undefined {
  const [preview, setPreview] = useState<ScreenPreview | null | undefined>(undefined)
  useEffect(() => {
    setPreview(undefined)
    if (!sessionId) return
    let cancelled = false
    const load = () =>
      void sendToApi
        .preview(sessionId)
        .then((p) => {
          if (!cancelled) setPreview(p)
        })
        .catch(() => {
          if (!cancelled) setPreview(null)
        })
    load()
    const timer = setInterval(load, PREVIEW_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])
  return preview
}

function parseNotice(parsed: ParsedSend): string | null {
  if (parsed.kind === 'no-match') return NO_SESSION_MATCH
  if (parsed.kind === 'ambiguous')
    return `Mais de uma sessão chamada @${parsed.alias} — escolha pelo menu`
  if (parsed.kind === 'no-target') return 'Escolha a sessão de destino'
  return null
}

export function resultNotice(
  res: SendPromptResult,
  t: Pick<SendTarget, 'alias' | 'status'>,
): string {
  if (res.ok && res.delivered) return `Enviado para @${t.alias}.`
  if (res.ok)
    return `Na fila de @${t.alias} — entrega quando ela terminar o turno, sem menu na tela.`
  if (res.error === 'menu-open')
    return `Há um menu aberto na tela de @${t.alias} — responda antes ou use “Quando terminar”.`
  if (res.error === 'not-running') return `@${t.alias} encerrou — a mensagem não foi enviada.`
  if (res.error === 'input-dirty')
    return `@${t.alias} tem texto não enviado no prompt — envie ou apague lá, ou use “Quando terminar”.`
  return `Não enviado para @${t.alias}: ${sendRefusalReason(res.error)}.`
}

function Preview({
  preview,
  alias,
}: {
  preview: ScreenPreview | null | undefined
  alias: string | null
}) {
  if (preview === undefined) return null
  return (
    <div
      data-testid="quick-preview"
      className="relative rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
    >
      {preview?.hasMenu && (
        <span className="absolute right-2 top-1.5 z-10 flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[var(--color-warning)] shadow-sm">
          <Icon as={ShieldAlert} size={11} /> menu aberto na tela
        </span>
      )}
      {preview?.inputDirty && !preview.hasMenu && (
        <span
          data-testid="quick-input-dirty"
          className="absolute right-2 top-1.5 z-10 flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[var(--color-warning)] shadow-sm"
        >
          <Icon as={ShieldAlert} size={11} /> @{alias ?? 'sessão'} tem texto não enviado no prompt
        </span>
      )}
      {preview ? (
        <pre className="max-h-28 overflow-hidden whitespace-pre font-mono text-[11px] leading-[1.35] text-[var(--color-text-dim)] opacity-80">
          {preview.lines.join('\n') || ' '}
        </pre>
      ) : (
        <p className="text-[11px] text-[var(--color-text-dim)]">
          Prévia indisponível para esta sessão.
        </p>
      )}
    </div>
  )
}

const HELD_LABEL: Record<NonNullable<QueuedPrompt['heldReason']>, string> = {
  'menu-open': 'segurada: menu aberto',
  unparsed: 'segurada: tela não reconhecida',
  'input-dirty': 'segurada: texto não enviado no prompt',
}

function QueueChips({ queue, targets }: { queue: PromptQueueSnapshot; targets: SendTarget[] }) {
  if (queue.items.length === 0) return null
  return (
    <div data-testid="quick-queue" className="flex flex-wrap gap-1.5">
      {queue.items.map((q) => {
        const t = targets.find((x) => x.sessionId === q.sessionId)
        return (
          <span
            key={q.id}
            data-testid="queue-chip"
            className="flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] py-0.5 pl-2 pr-1 text-[11px]"
            title={q.text}
          >
            <span className="text-[var(--color-text-dim)]">@{t?.alias ?? 'sessão'}</span>
            {isAgentAskEnvelope(q.text) ? (
              <span className="text-[var(--color-info)]">pergunta de outro agente</span>
            ) : (
              <span className="max-w-48 truncate text-[var(--color-text)]">{q.text}</span>
            )}
            {q.heldReason && (
              <span className="text-[var(--color-warning)]">{HELD_LABEL[q.heldReason]}</span>
            )}
            <button
              type="button"
              aria-label="Cancelar mensagem na fila"
              onClick={() => void sendToApi.cancel(q.id)}
              className="rounded-full p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
            >
              <Icon as={X} size={10} />
            </button>
          </span>
        )
      })}
    </div>
  )
}

function QueueCounters({ queue }: { queue: PromptQueueSnapshot }) {
  const lines = counterLines(queue)
  if (lines.length === 0) return null
  const c = queue.counters
  const detail = [
    `Na fila: ${queue.items.length}`,
    `entregues: ${c.delivered}`,
    `expiradas: ${c.expired}`,
    `sessão encerrou: ${c.sessionGone}`,
    `seguradas por menu aberto: ${c.refusedMenuOpen}`,
    `por tela não reconhecida: ${c.refusedUnparsed}`,
    `por texto não enviado: ${c.refusedInputDirty}`,
  ].join('\n')
  return (
    <p
      data-testid="quick-counters"
      title={detail}
      className="text-[11px] text-[var(--color-text-dim)]"
    >
      {lines.join(' · ')}
    </p>
  )
}

function WhenToggle({
  when,
  onChange,
}: {
  when: SendPromptWhen
  onChange: (w: SendPromptWhen) => void
}) {
  const opts: Array<{ value: SendPromptWhen; label: string }> = [
    { value: 'now', label: 'Enviar agora' },
    { value: 'on-idle', label: 'Quando terminar' },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Quando entregar"
      className="flex rounded-full border border-[var(--color-border)] p-0.5"
    >
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={when === o.value}
          data-testid={`when-${o.value}`}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 text-xs transition ${
            when === o.value
              ? 'bg-[var(--color-surface)] text-[var(--color-text)]'
              : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function QuickComposerPanel({
  initialTargetId,
  onClose,
}: {
  initialTargetId: string | null
  onClose: () => void
}) {
  const targets = useSendTargets()
  const queue = usePromptQueue()
  const [selectedId, setSelectedId] = useState(initialTargetId)
  const [picking, setPicking] = useState(initialTargetId == null)
  const [pickedFiles, setPickedFiles] = useState<ReadonlySet<string>>(new Set())
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [whenChoice, setWhenChoice] = useState<SendPromptWhen | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<MentionPlacement | null>(null)

  const selected = targets.find((t) => t.sessionId === selectedId) ?? null
  const parsed = parseSend(text, targets, selected, pickedFiles)
  const effective = parsed.kind === 'ok' ? parsed.target : selected
  const preview = useScreenPreview(effective?.sessionId ?? null)
  const when = whenChoice ?? (effective ? defaultWhen(effective, preview?.hasMenu ?? false) : 'now')
  const menu = useMentionMenu({ text, caret, targets, cwd: effective?.cwd ?? null, strict: true })
  // Destino pré-escolhido que sumiu dos alvos (encerrou, filha do dock): o picker
  // volta, senão não há como escolher outro.
  const showPicker = picking || !effective
  const mentionedId =
    parsed.kind === 'ok' && parsed.target.sessionId !== selectedId ? parsed.target.sessionId : null

  // Medido ao abrir (e a cada tecla, já que a prévia/lista acima muda de altura).
  const menuOpen = menu.open && !!menu.token
  useLayoutEffect(() => {
    if (!menuOpen) return
    const field = fieldRef.current?.getBoundingClientRect()
    const header = headerRef.current?.getBoundingClientRect()
    if (!field || !header) return
    setPlacement(
      mentionPlacement({
        fieldTop: field.top,
        fieldBottom: field.bottom,
        headerBottom: header.bottom,
        viewportHeight: window.innerHeight,
      }),
    )
  }, [menuOpen, text, showPicker])

  // O @ do texto já escolheu o destino: o picker sai e a prévia daquela tela entra.
  useEffect(() => {
    if (mentionedId) setPicking(false)
  }, [mentionedId])

  useEffect(() => {
    if (!showPicker) requestAnimationFrame(() => textareaRef.current?.focus())
  }, [showPicker])

  // Síncrono: com rAF, uma tecla digitada antes do frame caía antes do caret
  // reposicionado e embaralhava o texto (o "r" de "rode" ia pro fim).
  function setDraft(value: string, nextCaret: number) {
    flushSync(() => {
      setText(value)
      setCaret(nextCaret)
      setNotice(null)
    })
    textareaRef.current?.setSelectionRange(nextCaret, nextCaret)
  }

  function applyMention(token: ActiveToken, replacement: string) {
    const next = applyCompletion(text, token, replacement)
    if (token.kind === 'file') setPickedFiles((prev) => new Set(prev).add(replacement.slice(1)))
    setDraft(next.value, next.caret)
  }

  async function submit() {
    if (sending) return
    const blocked = parseNotice(parsed)
    if (blocked) {
      setNotice(blocked)
      return
    }
    if (parsed.kind !== 'ok') return
    setSending(true)
    try {
      const res = await sendToApi.send({
        sessionId: parsed.target.sessionId,
        text: parsed.body,
        when,
      })
      if (res.ok) {
        setSelectedId(parsed.target.sessionId)
        setPickedFiles(new Set())
        setDraft('', 0)
      }
      setNotice(resultNotice(res, parsed.target))
    } catch (err) {
      console.error('[quick-composer] falha ao enviar:', err)
      setNotice(`Não deu pra enviar para @${parsed.target.alias} — tente de novo.`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      data-modal-overlay
      className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-label="Enviar mensagem para uma sessão"
        data-testid="quick-composer"
        className="pw-rise flex w-[38rem] max-w-[92vw] flex-col gap-3 rounded-2xl border p-4 shadow-2xl"
        style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault()
            if (showPicker && effective) setPicking(false)
            else onClose()
          }
        }}
      >
        <div ref={headerRef} className="flex items-center gap-2 text-xs">
          <span className="shrink-0 font-semibold text-[var(--color-text)]">Enviar para</span>
          {effective ? (
            <button
              type="button"
              data-testid="quick-target"
              onClick={() => setPicking((p) => !p)}
              className="flex min-w-0 items-center gap-2 rounded-full px-1 hover:bg-[var(--color-surface)]"
              title="Trocar a sessão de destino"
            >
              <SessionPill target={effective} />
              <span className="min-w-0 truncate text-[var(--color-text-dim)]">
                {[effective.label, effective.projectName].filter(Boolean).join(' · ')}
              </span>
            </button>
          ) : (
            <button
              type="button"
              data-testid="quick-target"
              onClick={() => setPicking(true)}
              className="rounded-full px-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              escolha a sessão
            </button>
          )}
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="ml-auto rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            <Icon as={X} size={14} />
          </button>
        </div>
        {effective?.purpose && !showPicker && (
          <p className="-mt-2 truncate text-[11px] text-[var(--color-text-dim)]">
            {effective.purpose}
          </p>
        )}

        {/* Um seletor por vez: com o menu do @ aberto, a lista fixa repetia as mesmas sessões. */}
        {menuOpen ? null : showPicker ? (
          <TargetPicker
            targets={targets}
            onPick={(t) => {
              setSelectedId(t.sessionId)
              setWhenChoice(null)
              setPicking(false)
            }}
            onCancel={() => (effective ? setPicking(false) : onClose())}
          />
        ) : (
          <Preview preview={preview} alias={effective?.alias ?? null} />
        )}

        <div ref={fieldRef} className="relative">
          {placement?.side === 'above' && (
            <MentionMenu
              menu={menu}
              className="absolute bottom-full left-0 mb-1"
              style={{ maxHeight: placement.maxHeight }}
              onPick={(p) => applyMention(p.token, p.replacement)}
            />
          )}
          <textarea
            ref={textareaRef}
            value={text}
            rows={3}
            data-testid="quick-input"
            aria-label="Mensagem. @ no início troca a sessão, # menciona um arquivo"
            placeholder="Mensagem · @ troca a sessão · # menciona arquivo · Esc fecha"
            className="max-h-48 min-h-[4.5rem] w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
              setNotice(null)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={(e) => {
              const res = menu.onKey(e)
              if (res) {
                e.preventDefault()
                if (res.kind === 'pick') {
                  applyMention(res.pick.token, res.pick.replacement)
                } else if (e.key === 'Enter') {
                  setNotice(NO_SESSION_MATCH)
                }
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          {/* Abaixo, no fluxo: empurra "Enviar agora / Quando terminar" em vez de cobri-los. */}
          {placement?.side !== 'above' && (
            <MentionMenu
              menu={menu}
              className="relative mt-1"
              style={placement ? { maxHeight: placement.maxHeight } : undefined}
              onPick={(p) => applyMention(p.token, p.replacement)}
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          <WhenToggle when={when} onChange={setWhenChoice} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-dim)]">
            Enter envia · Shift+Enter quebra linha
          </span>
          <Button
            variant="primary"
            size="sm"
            disabled={sending}
            onClick={() => void submit()}
            data-testid="quick-send"
          >
            <Icon as={CornerDownLeft} size={13} />
            Enviar
          </Button>
        </div>

        {notice && (
          <p data-testid="quick-notice" className="text-xs text-[var(--color-text-dim)]">
            {notice}
          </p>
        )}
        <QueueChips queue={queue} targets={targets} />
        <QueueCounters queue={queue} />
      </div>
    </div>
  )
}

export function QuickComposer() {
  const open = useQuickComposerStore((s) => s.open)
  const targetId = useQuickComposerStore((s) => s.targetId)
  const close = useQuickComposerStore((s) => s.close)
  if (!open) return null
  return createPortal(
    <QuickComposerPanel key={targetId ?? 'none'} initialTargetId={targetId} onClose={close} />,
    document.body,
  )
}
