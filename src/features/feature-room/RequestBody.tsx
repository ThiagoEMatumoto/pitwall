import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { handoffsApi } from '@/lib/ipc'
import type { AttentionItem, AttentionItemAction } from '../../../shared/types/attention'
import type { AnswerHandoffRequestInput } from '../../../shared/types/handoff-request'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { REQUEST_KIND_LABEL } from './room-labels'
import { COMPACT } from './room-ui'

const SNOOZE_MS = 60 * 60 * 1000

const actionOf = <K extends AttentionItemAction['kind']>(item: AttentionItem, kind: K) =>
  item.actions.find((a): a is Extract<AttentionItemAction, { kind: K }> => a.kind === kind)

const TEXTAREA =
  'mt-2 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)]'

// Pedido tipado (protótipo C, estado "Normal"): opções como radios, a recomendada
// destacada, custo do erro e resposta inline por requestId. O item só some quando
// attention:changed chegar sem ele (sem remoção otimista, como os outros bodies).
export function RequestBody({ item }: { item: AttentionItem }) {
  const req = item.request
  const [picked, setPicked] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!req) return null

  const answer = actionOf(item, 'answer_request')
  const dismiss = actionOf(item, 'triage_dismiss')
  const snooze = actionOf(item, 'triage_snooze')
  const hasOptions = req.options.length > 0
  const humanAction = !hasOptions && req.kind === 'human_action'
  const note = text.trim() ? text.trim() : undefined

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
  const send = (name: string, input: Omit<AnswerHandoffRequestInput, 'requestId'>) =>
    answer &&
    void run(name, () => handoffsApi.answerRequest({ requestId: req.requestId, ...input }))

  const primary = hasOptions
    ? {
        label: picked ? `Responder ${picked}` : 'Escolha uma opção',
        disabled: !picked,
        onClick: () => send('answer', { choice: picked!, text: note }),
      }
    : {
        label: 'Responder',
        disabled: !note,
        onClick: () => send('answer', { text: note }),
      }

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
        <span
          data-src="handoff_requests.kind"
          className="rounded-full border border-[var(--color-border)] px-2 py-px font-medium text-[var(--color-text)]"
        >
          {REQUEST_KIND_LABEL[req.kind]}
        </span>
        {req.escalated && (
          <span
            data-src="handoff_requests.escalated_by"
            className="rounded-full border border-[var(--color-border)] px-2 py-px text-[var(--color-text-dim)]"
          >
            escalado pela mãe
          </span>
        )}
      </div>
      <div
        data-src="handoff_requests.question"
        className="mt-2 whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 font-mono text-[12px] leading-relaxed"
      >
        {stripUnsafeDisplay(req.question)}
      </div>
      {hasOptions ? (
        <div
          role="radiogroup"
          aria-label="Opções"
          data-src="handoff_requests.options_json/recommendation"
          className="mt-2.5 grid gap-1.5"
        >
          {req.options.map((o) => {
            const checked = picked === o.key
            const recommended = req.recommendation === o.key
            return (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setPicked(o.key)}
                className={`grid grid-cols-[22px_1fr] items-start gap-2 rounded-lg border px-2.5 py-[9px] text-left ${
                  checked
                    ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))]'
                    : recommended
                      ? 'border-[color-mix(in_srgb,var(--color-accent)_60%,var(--color-border))] bg-[var(--color-bg)]'
                      : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent)]'
                }`}
              >
                <span
                  className={`rounded border text-center font-mono text-[11px] leading-[18px] ${
                    checked
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
                  }`}
                >
                  {o.key}
                </span>
                <span>
                  <span className="text-[13.5px]">{stripUnsafeDisplay(o.label)}</span>
                  {recommended && (
                    <span className="ml-1.5 inline-block rounded-full border border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)] px-1.5 text-[11px] text-[var(--color-accent)]">
                      recomendada
                    </span>
                  )}
                  {o.detail && (
                    <span className="mt-0.5 block text-[12px] text-[var(--color-text-dim)]">
                      {stripUnsafeDisplay(o.detail)}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        req.recommendation && (
          <p
            data-src="handoff_requests.recommendation"
            className="mb-0 mt-2 border-l-2 border-[var(--color-accent)] py-0.5 pl-2 text-[12.5px] text-[var(--color-text)]"
          >
            <b className="font-semibold text-[var(--color-accent)]">Recomendação:</b>{' '}
            {stripUnsafeDisplay(req.recommendation)}
          </p>
        )
      )}
      {req.costOfError && (
        <div
          data-src="handoff_requests.cost_of_error"
          className="mt-2 border-l-2 border-[var(--color-warning)] py-0.5 pl-2 text-[12.5px] text-[var(--color-text-dim)]"
        >
          <b className="font-semibold text-[var(--color-warning)]">Custo do erro:</b>{' '}
          {stripUnsafeDisplay(req.costOfError)}
        </div>
      )}
      <textarea
        aria-label={hasOptions || humanAction ? 'Comentário' : 'Resposta'}
        placeholder={
          hasOptions || humanAction
            ? 'Comentário opcional para a filha'
            : 'Sua resposta para a filha'
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={hasOptions ? 2 : 3}
        className={TEXTAREA}
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {answer &&
          (humanAction ? (
            <>
              <Button
                className={COMPACT}
                loading={busy === 'done'}
                onClick={() => send('done', { choice: 'done', text: note })}
              >
                Feito
              </Button>
              <Button
                variant="ghost"
                className={COMPACT}
                loading={busy === 'blocked'}
                onClick={() => send('blocked', { choice: 'blocked', text: note })}
              >
                Não consigo
              </Button>
            </>
          ) : (
            <Button
              className={COMPACT}
              disabled={primary.disabled}
              loading={busy === 'answer'}
              onClick={primary.onClick}
            >
              {busy === 'answer' ? 'Enviando…' : primary.label}
            </Button>
          ))}
        {answer && (
          <Button
            variant="ghost"
            className={COMPACT}
            loading={busy === 'reject'}
            onClick={() => send('reject', { reject: true, text: note })}
          >
            Rejeitar
          </Button>
        )}
        {item.handoffId && (
          <Button
            variant="ghost"
            className={COMPACT}
            onClick={() => useCrewDockStore.getState().openPeek(item.handoffId!)}
          >
            Peek
          </Button>
        )}
        {dismiss && (
          <Button
            variant="ghost"
            className={COMPACT}
            loading={busy === 'dismiss'}
            onClick={() =>
              void run('dismiss', () =>
                handoffsApi.dismissAttention({
                  dedupKey: dismiss.dedupKey,
                  requestId: dismiss.requestId,
                }),
              )
            }
          >
            Dispensar
          </Button>
        )}
        {snooze && (
          <Button
            variant="ghost"
            className={COMPACT}
            loading={busy === 'snooze'}
            onClick={() =>
              void run('snooze', () =>
                handoffsApi.snoozeAttention({
                  dedupKey: snooze.dedupKey,
                  requestId: snooze.requestId,
                  until: Date.now() + SNOOZE_MS,
                }),
              )
            }
          >
            Adiar 1 h
          </Button>
        )}
        {error && (
          <span role="status" className="text-[12.5px] text-[var(--color-danger)]">
            {error}
          </span>
        )}
        {req.resolver === 'human_only' && (
          <span
            data-src="handoff_requests.resolver"
            className="ml-auto text-[12px] text-[var(--color-text-dim)]"
          >
            só você resolve (human_only)
          </span>
        )}
      </div>
    </>
  )
}
