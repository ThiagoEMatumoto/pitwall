import { forwardRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { AttentionMenuPanel } from '@/features/session-switcher/AttentionPopover'
import { peekAttentionItem } from '@/features/handoffs/peek-attention'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { openSessionByCc } from '@/features/sessions/open-session'
import { handoffsApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type {
  AttentionItem,
  AttentionItemAction,
  ProducedAttentionKind,
} from '../../../shared/types/attention'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'
import { ITEM_TITLE, KIND_LABEL, sinceText } from './room-labels'
import type { RoomQueueRow } from './room-model'
import { COMPACT } from './room-ui'
import { RequestBody } from './RequestBody'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'

const SEV_COLOR = {
  blocking: 'var(--color-danger)',
  action: 'var(--color-warning)',
  info: 'var(--color-info)',
} as const

const has = (item: AttentionItem, kind: AttentionItemAction['kind']) =>
  item.actions.some((a) => a.kind === kind)

const kindLabel = (item: AttentionItem) => KIND_LABEL[item.kind as ProducedAttentionKind]

export interface QueueSubject {
  who: string
  repo: string
  handoff: Handoff | null
  live: LiveSessionInfo | null
}

// Barra lateral da severidade (protótipo C): a cor diz o quanto bloqueia.
function SevBar({ item }: { item: AttentionItem }) {
  return (
    <span
      aria-hidden
      className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r-[3px]"
      style={{ background: SEV_COLOR[item.severity] }}
    />
  )
}

export function CollapsedItem({
  row,
  subject,
  now,
  onOpen,
}: {
  row: RoomQueueRow
  subject: QueueSubject
  now: number
  onOpen: () => void
}) {
  const item = row.head
  return (
    <li
      data-testid="room-queue-row"
      data-kind={item.kind}
      className="relative rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <SevBar item={item} />
      <button
        type="button"
        aria-expanded={false}
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-[10px] py-2.5 pl-4 pr-3.5 text-left hover:bg-[var(--color-surface-2)]"
      >
        <span
          className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: SEV_COLOR[item.severity] }}
        >
          {kindLabel(item)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
          {ITEM_TITLE[item.kind as ProducedAttentionKind](subject.who)}
          {subject.repo && (
            <span className="ml-1.5 font-normal text-[var(--color-text-dim)]">{subject.repo}</span>
          )}
        </span>
        {item.createdAt != null && (
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-dim)]">
            {sinceText(item.createdAt, now)}
          </span>
        )}
        <span aria-hidden className="text-[12px] text-[var(--color-text-dim)]">
          ›
        </span>
      </button>
    </li>
  )
}

interface OpenProps {
  row: RoomQueueRow
  subject: QueueSubject
  now: number
  hasNext: boolean
  onNext: () => void
}

// O item aberto: quem, por que agora, o corpo do kind e as ações que a projeção
// deu. A Room não decide o que é possível: sem a AttentionItemAction, sem botão.
export const OpenItem = forwardRef<HTMLDivElement, OpenProps>(function OpenItem(
  { row, subject, now, hasNext, onNext },
  headRef,
) {
  const item = row.head
  const headId = `room-item-${item.dedupKey}`
  return (
    <li
      data-testid="room-queue-row"
      data-kind={item.kind}
      className="relative rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] py-3 pl-4 pr-3.5"
    >
      <SevBar item={item} />
      <div data-testid="room-queue-open" aria-labelledby={headId} role="group">
        <div
          ref={headRef}
          tabIndex={-1}
          id={headId}
          className="flex flex-wrap items-center gap-2 rounded-md"
        >
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.05em]"
            style={{ color: SEV_COLOR[item.severity] }}
          >
            {kindLabel(item)}
          </span>
          <span className="text-[12.5px] text-[var(--color-text-dim)]">
            <b className="font-semibold text-[var(--color-text)]">{subject.who}</b>
            {subject.repo && (
              <>
                {' · '}
                <span className="font-mono text-[11.5px]">{subject.repo}</span>
              </>
            )}
          </span>
          {item.createdAt != null && (
            <span
              data-src={item.kind === 'request' ? 'handoff_requests.created_at' : undefined}
              className="ml-auto text-[12px] tabular-nums text-[var(--color-text-dim)]"
            >
              {sinceText(item.createdAt, now)}
            </span>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={onNext}
              title="Próximo item (J)"
              className={`${item.createdAt == null ? 'ml-auto' : ''} rounded px-1 text-[12px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]`}
            >
              próximo ›
            </button>
          )}
        </div>
        <h3 className="mb-0.5 mt-1.5 text-[15px] font-semibold leading-snug">
          {ITEM_TITLE[item.kind as ProducedAttentionKind](subject.who)}
        </h3>
        <p className="m-0 text-[13px] leading-[1.45] text-[var(--color-text-dim)]">
          {stripUnsafeDisplay(item.whyNow)}
        </p>
        <ItemBody item={item} subject={subject} />
        {row.also.length > 0 && (
          <p className="mb-0 mt-2 text-[12px] text-[var(--color-text-dim)]">
            também: {row.also.map(kindLabel).join(', ')}
          </p>
        )}
        <details className="mt-1.5 text-[12px] text-[var(--color-text-dim)]">
          <summary className="w-max cursor-pointer rounded hover:text-[var(--color-text)]">
            Por que está aqui?
          </summary>
          <dl className="mb-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-[3px]">
            <dt>Entrou</dt>
            <dd className="m-0 text-[var(--color-text)]">{item.entryRule}</dd>
            <dt>Sai quando</dt>
            <dd className="m-0 text-[var(--color-text)]">{item.exitRule}</dd>
          </dl>
        </details>
      </div>
    </li>
  )
})

function ItemBody({ item, subject }: { item: AttentionItem; subject: QueueSubject }) {
  // Remonta ao trocar de item: o rascunho e o "Enviando…" são do item, não da fila.
  switch (item.kind) {
    case 'child_question':
      return <QuestionBody key={item.dedupKey} item={item} handoff={subject.handoff} />
    case 'session_menu':
      return <MenuBody key={item.dedupKey} item={item} subject={subject} />
    case 'request':
      return <RequestBody key={item.dedupKey} item={item} />
    default:
      return <ActionsBody key={item.dedupKey} item={item} subject={subject} />
  }
}

// Ação com "carregando" e erro visível; o item só sai quando attention:changed
// chegar sem ele (sem remoção otimista).
function useAction() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, run }
}

function Feedback({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <span role="status" className="text-[12.5px] text-[var(--color-danger)]">
      {error}
    </span>
  )
}

function openTerminal(item: AttentionItem, subject: QueueSubject) {
  if (item.handoffId) useCrewDockStore.getState().openPeek(item.handoffId, 'terminal')
  else if (subject.live?.ccSessionId) openSessionByCc(subject.live.ccSessionId)
}

function QuestionBody({ item, handoff }: { item: AttentionItem; handoff: Handoff | null }) {
  const [text, setText] = useState('')
  const { busy, error, run } = useAction()
  const question = handoff?.pendingQuestion
  const canSend = has(item, 'send_message') && !!handoff && text.trim().length > 0
  return (
    <>
      {question && (
        <div className="mt-2.5 whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 font-mono text-[12px] leading-relaxed">
          {stripUnsafeDisplay(question)}
        </div>
      )}
      <textarea
        aria-label="Resposta"
        placeholder="Sua resposta para a filha"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="mt-2 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)]"
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {has(item, 'send_message') && (
          <Button
            className={COMPACT}
            disabled={!canSend}
            loading={busy === 'reply'}
            onClick={() =>
              void run('reply', () =>
                handoffsApi.sendMessage({ id: item.handoffId!, text: text.trim() }),
              )
            }
          >
            {busy === 'reply' ? 'Enviando…' : 'Responder e retomar'}
          </Button>
        )}
        <PeekButton item={item} />
        <DismissButton item={item} run={run} busy={busy} />
        <Feedback error={error} />
      </div>
    </>
  )
}

function MenuBody({ item, subject }: { item: AttentionItem; subject: QueueSubject }) {
  const panelItem = peekAttentionItem(subject.live, subject.handoff)
  return (
    <>
      <div className="mt-2.5 flex flex-col gap-1.5 text-[12.5px]">
        {panelItem ? (
          <AttentionMenuPanel item={panelItem} />
        ) : (
          <p className="m-0 text-[var(--color-text-dim)]">Responda no terminal.</p>
        )}
      </div>
      {has(item, 'open_session') && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button variant="ghost" className={COMPACT} onClick={() => openTerminal(item, subject)}>
            Abrir terminal
          </Button>
        </div>
      )}
    </>
  )
}

function ActionsBody({ item, subject }: { item: AttentionItem; subject: QueueSubject }) {
  const { busy, error, run } = useAction()
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
      {has(item, 'reopen_child') && (
        <Button
          className={COMPACT}
          loading={busy === 'resume'}
          onClick={() => void run('resume', () => handoffsApi.resume(item.handoffId!))}
        >
          {busy === 'resume' ? 'Retomando…' : 'Retomar'}
        </Button>
      )}
      <PeekButton item={item} />
      {has(item, 'open_session') && (
        <Button variant="ghost" className={COMPACT} onClick={() => openTerminal(item, subject)}>
          Abrir terminal
        </Button>
      )}
      <DismissButton item={item} run={run} busy={busy} />
      {has(item, 'kill_session') && item.sessionId && (
        // O Encerrar do app (com a janela de desfazer), não um kill seco.
        <Button
          variant="danger"
          className={COMPACT}
          onClick={() => useAppStore.getState().endSession(item.sessionId!)}
        >
          Encerrar sessão
        </Button>
      )}
      <Feedback error={error} />
    </div>
  )
}

function PeekButton({ item }: { item: AttentionItem }) {
  if (!item.handoffId) return null
  return (
    <Button
      variant="ghost"
      className={COMPACT}
      onClick={() => useCrewDockStore.getState().openPeek(item.handoffId!)}
    >
      Peek
    </Button>
  )
}

function DismissButton({
  item,
  run,
  busy,
}: {
  item: AttentionItem
  run: (name: string, fn: () => Promise<unknown>) => Promise<void>
  busy: string | null
}) {
  if (!has(item, 'dismiss') || !item.handoffId) return null
  return (
    <Button
      variant="ghost"
      className={COMPACT}
      loading={busy === 'dismiss'}
      onClick={() =>
        void run('dismiss', () => useHandoffsStore.getState().dismiss(item.handoffId!))
      }
    >
      Dispensar
    </Button>
  )
}
