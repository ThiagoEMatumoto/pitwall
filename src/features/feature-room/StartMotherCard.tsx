import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { chatApi, roomApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import type { MotherPreflight } from '../../../shared/types/feature-room'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { isTypingTarget } from '@/features/session-canvas/typing-target'
import { useFeatureRoomStore, type PendingMotherStep } from './feature-room-store'

const PURPOSE_MAX = 500 // o mesmo limite do room:start-mother (zod no main)
export const EMPTY_PURPOSE_ERROR = 'Escreva o objetivo — ele vira o propósito da mãe.'

const STEPS: Array<{ step: PendingMotherStep; label: string }> = [
  { step: 'worktree', label: 'Criando worktree e sessão ligada à feature' },
  { step: 'terminal', label: 'Subindo o terminal' },
  { step: 'chat', label: 'Ligando o chat ao vivo' },
]

// "Error invoking remote method 'room:start-mother': Error: MCP_NOT_READY: <texto>"
// → o texto para o humano. O resto (zod, spawn) vai como veio, sem o prefixo do IPC.
export function startMotherErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const msg = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  const mcp = msg.match(/MCP_NOT_READY:\s*(.*)$/s)
  return stripUnsafeDisplay(mcp ? mcp[1] : msg)
}

// O xterm fica montado (invisible) por baixo do chat e vem antes no DOM: sem o
// :not, o 1º textarea é o helper dele, e o foco iria (ou tentaria ir) direto à PTY.
export function focusMotherComposer(): boolean {
  const el = document.querySelector<HTMLTextAreaElement>(
    '[data-testid="room-mother"] textarea:not(.xterm-helper-textarea)',
  )
  el?.focus()
  return !!el && document.activeElement === el
}

// Prazos dos passos 2 e 3. O claude escreve o sessions/<pid>.json em poucos
// segundos e o 1º chat:transcript-update sai assim que o watch arma.
export const TERMINAL_TIMEOUT_MS = 30_000
export const CHAT_TIMEOUT_MS = 20_000
const COMPOSER_WAIT_MS = 10_000

export const MOTHER_DIED_TEXT = 'A sessão-mãe encerrou durante o início.'
export const TERMINAL_TIMEOUT_TEXT = `A sessão-mãe não apareceu viva em ${TERMINAL_TIMEOUT_MS / 1000}s.`
export const CHAT_TIMEOUT_TEXT = `O chat ao vivo não respondeu em ${CHAT_TIMEOUT_MS / 1000}s. A mãe segue rodando: feche para vê-la (Ctrl+. alterna para o Terminal).`

// Avança os passos 2 e 3 de "Iniciar sessão-mãe": a sessão fica viva em
// liveSessions (terminal) e depois chega o 1º chat:transcript-update dela (chat,
// mesmo com transcriptExists:false). Vive na Room, não no card: o card pode estar
// num Dialog que já fechou.
export function usePendingMotherProgress(): void {
  const pending = useFeatureRoomStore((s) => s.pendingMother)
  const sessionId = pending?.sessionId ?? null
  const step = pending?.step ?? null
  const failed = !!pending?.failure
  const liveStatus = useAppStore((s) =>
    sessionId ? (s.liveSessions.find((l) => l.id === sessionId)?.status ?? null) : null,
  )
  const isLive = liveStatus !== null && liveStatus !== 'ended'
  const gotUpdate = useRef(false)
  const seenLive = useRef<string | null>(null)

  // Recém-nascida, a mãe vem do list-live-global como 'ended' (o sessions/<pid>.json
  // ainda não existe) ou nem vem: isso é "ainda não apareceu", não morte. Só conta
  // como morta depois de ter sido vista viva; antes disso quem decide é o prazo.
  useEffect(() => {
    if (!sessionId || failed) return
    if (isLive) seenLive.current = sessionId
    else if (seenLive.current === sessionId) failPending(sessionId, MOTHER_DIED_TEXT)
  }, [sessionId, isLive, failed])

  useEffect(() => {
    if (step === 'terminal' && isLive && !failed) {
      const cur = useFeatureRoomStore.getState().pendingMother
      if (cur) useFeatureRoomStore.getState().setPendingMother({ ...cur, step: 'chat' })
    }
  }, [step, isLive, failed])

  useEffect(() => {
    if (!sessionId || failed || (step !== 'terminal' && step !== 'chat')) return
    const text = step === 'terminal' ? TERMINAL_TIMEOUT_TEXT : CHAT_TIMEOUT_TEXT
    const t = setTimeout(
      () => failPending(sessionId, text),
      step === 'terminal' ? TERMINAL_TIMEOUT_MS : CHAT_TIMEOUT_MS,
    )
    return () => clearTimeout(t)
  }, [sessionId, step, failed])

  useEffect(() => {
    gotUpdate.current = false
    if (!sessionId) return
    return chatApi.onTranscriptUpdate((u) => {
      if (u.sessionId !== sessionId) return
      gotUpdate.current = true
      const cur = useFeatureRoomStore.getState().pendingMother
      // Inclui o chat que estourou o prazo: chegou tarde, mas chegou.
      if (cur?.sessionId === sessionId && cur.step === 'chat') finish()
    })
  }, [sessionId])

  useEffect(() => {
    if (step === 'chat' && gotUpdate.current) finish()
  }, [step])
}

function failPending(sessionId: string, failure: string): void {
  const room = useFeatureRoomStore.getState()
  const cur = room.pendingMother
  if (cur?.sessionId === sessionId && !cur.failure) room.setPendingMother({ ...cur, failure })
}

// O RoomMotherPane monta centenas de ms depois de o card sair (o grafo ainda
// precisa enxergar a mãe): foca quando o composer aparecer, não num frame às cegas.
export function focusMotherComposerWhenReady(timeoutMs = COMPOSER_WAIT_MS): () => void {
  if (focusMotherComposer()) return () => {}
  const observer = new MutationObserver(() => {
    const active = document.activeElement
    // O humano já foi digitar em outro lugar: não roubar o foco.
    if (active && active !== document.body && isTypingTarget(active)) stop()
    else if (focusMotherComposer()) stop()
  })
  const timer = setTimeout(stop, timeoutMs)
  function stop() {
    observer.disconnect()
    clearTimeout(timer)
  }
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled'],
  })
  return stop
}

function finish(): void {
  useFeatureRoomStore.getState().setPendingMother(null)
  focusMotherComposerWhenReady()
}

interface Props {
  featureId: string
  featureTitle: string
  // Dialog: fecha assim que o room:start-mother volta; os passos seguem no centro.
  onStarted?: () => void
  heading?: boolean
}

export function StartMotherCard({ featureId, featureTitle, onStarted, heading = true }: Props) {
  const [preflight, setPreflight] = useState<MotherPreflight | null>(null)
  const [preflightFailed, setPreflightFailed] = useState(false)
  const [repoId, setRepoId] = useState<string | null>(null)
  const [purpose, setPurpose] = useState<string | null>(null) // null = ainda não editado
  const [error, setError] = useState<string | null>(null)
  const pending = useFeatureRoomStore((s) =>
    s.pendingMother?.featureId === featureId ? s.pendingMother : null,
  )
  const ids = useId()

  useEffect(() => {
    let alive = true
    setPreflightFailed(false)
    roomApi.motherPreflight(featureId).then(
      (p) => {
        if (!alive) return
        setPreflight(p)
        const usable = p.repos.filter((r) => r.valid)
        setRepoId((cur) => cur ?? (usable.find((r) => r.hasWorktree) ?? usable[0])?.repoId ?? null)
      },
      (err: unknown) => {
        console.error('[room] mother-preflight failed', err)
        if (alive) setPreflightFailed(true)
      },
    )
    return () => {
      alive = false
    }
  }, [featureId])

  const text = purpose ?? stripUnsafeDisplay(preflight?.suggestedPurpose ?? '')
  const repos = preflight?.repos.filter((r) => r.valid) ?? []
  const repo = repos.find((r) => r.repoId === repoId) ?? null
  const blocked = preflight !== null && !preflight.mcpReady
  const failure = pending?.failure ?? null
  const busy = pending !== null && !failure
  const canSubmit = !!preflight && !blocked && !!repo && !busy

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit || !repo) return
    const trimmed = text.trim()
    if (!trimmed) {
      setError(EMPTY_PURPOSE_ERROR)
      return
    }
    setError(null)
    const room = useFeatureRoomStore.getState()
    room.setPendingMother({ featureId, sessionId: null, step: 'worktree' })
    try {
      const res = await useAppStore
        .getState()
        .startMother({ featureId, repoId: repo.repoId, purpose: trimmed })
      room.selectMother(featureId, res.sessionId)
      room.setPendingMother({ featureId, sessionId: res.sessionId, step: 'terminal' })
      onStarted?.()
    } catch (err) {
      console.error('[room] start-mother failed', err)
      room.setPendingMother(null)
      setError(startMotherErrorText(err))
    }
  }

  const doneIdx = pending ? STEPS.findIndex((s) => s.step === pending.step) : -1
  return (
    <form
      data-testid="start-mother"
      aria-labelledby={heading ? `${ids}-h` : undefined}
      aria-busy={busy || undefined}
      onSubmit={submit}
      className="flex w-full max-w-[560px] flex-col gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
    >
      {heading && (
        <div>
          <h2 id={`${ids}-h`} className="m-0 text-[17px] font-semibold">
            Esta feature ainda não tem uma mãe
          </h2>
          <p className="mb-0 mt-1 text-[13.5px] text-[var(--color-text-dim)]">
            A mãe é com quem você conversa: ela planeja, abre filhas por repo e te traz só o que
            precisa de decisão.
          </p>
        </div>
      )}

      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" disabled={busy}>
        <legend className="mb-1.5 p-0 text-[12.5px]">Repo onde a mãe roda</legend>
        {preflight === null && !preflightFailed && (
          <span className="text-[12.5px] text-[var(--color-text-dim)]">Lendo os repos…</span>
        )}
        {preflightFailed && (
          <span role="alert" className="text-[12.5px] text-[var(--color-danger)]">
            Não foi possível ler os repos da feature.
          </span>
        )}
        {preflight && repos.length === 0 && (
          <span
            className="text-[12.5px] text-[var(--color-text-dim)]"
            data-testid="start-mother-no-repo"
          >
            Vincule um repo à feature para iniciar a mãe nele.
          </span>
        )}
        <div className="flex flex-wrap gap-1.5">
          {repos.map((r) => (
            <button
              key={r.repoId}
              type="button"
              aria-pressed={r.repoId === repoId}
              data-testid="start-mother-repo"
              title={r.hasWorktree ? 'Roda no worktree da feature' : 'Roda na raiz do repo'}
              onClick={() => setRepoId(r.repoId)}
              className={`rounded-md border px-2.5 py-1 font-mono text-[12.5px] ${
                r.repoId === repoId
                  ? 'border-[var(--color-accent)] text-[var(--color-text)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
              }`}
            >
              {stripUnsafeDisplay(r.label)}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5 text-[12.5px]">
        Objetivo (vem da feature, pode ajustar)
        <textarea
          data-testid="start-mother-purpose"
          value={text}
          maxLength={PURPOSE_MAX}
          rows={3}
          disabled={busy}
          aria-invalid={error === EMPTY_PURPOSE_ERROR || undefined}
          aria-describedby={error ? `${ids}-err` : undefined}
          onChange={(e) => {
            setPurpose(e.target.value)
            if (error === EMPTY_PURPOSE_ERROR) setError(null)
          }}
          className="resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <p className="m-0 rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-[12px] text-[var(--color-text-dim)]">
        <b className="text-[var(--color-text)]">Já vai junto:</b> arquitetura do repo · contexto da
        feature (objetivo, OKR, pulso) · regras de orquestração da mãe (MCP Pitwall). Nasce ligada a{' '}
        <b className="text-[var(--color-text)]">{featureTitle}</b>
        {repo && (
          <>
            , {repo.hasWorktree ? 'no worktree de ' : 'na raiz de '}
            <code>{stripUnsafeDisplay(repo.label)}</code>
          </>
        )}
        .
      </p>

      {blocked && (
        <p
          role="alert"
          data-testid="start-mother-blocked"
          className="m-0 text-[12.5px] text-[var(--color-danger)]"
        >
          {preflight?.mcpBlockReason}
        </p>
      )}
      {error && (
        <p
          id={`${ids}-err`}
          role="alert"
          data-testid="start-mother-error"
          className="m-0 text-[12.5px] text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}

      {pending && (
        <ol
          data-testid="start-mother-steps"
          className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]"
        >
          {STEPS.map((s, i) => {
            const state =
              i < doneIdx ? 'done' : i === doneIdx ? (failure ? 'failed' : 'active') : 'todo'
            return (
              <li
                key={s.step}
                data-step={s.step}
                data-state={state}
                className={
                  state === 'done'
                    ? 'text-[var(--color-success)]'
                    : state === 'failed'
                      ? 'text-[var(--color-danger)]'
                      : state === 'active'
                        ? 'text-[var(--color-text)]'
                        : 'text-[var(--color-text-dim)]'
                }
              >
                {state === 'done'
                  ? '✓ '
                  : state === 'failed'
                    ? '✕ '
                    : state === 'active'
                      ? '◌ '
                      : '· '}
                {s.label}
              </li>
            )
          })}
        </ol>
      )}

      {failure && (
        <p
          role="alert"
          data-testid="start-mother-failure"
          className="m-0 text-[12.5px] text-[var(--color-danger)]"
        >
          {stripUnsafeDisplay(failure)}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {failure && (
          <Button
            type="button"
            variant="ghost"
            data-testid="start-mother-dismiss"
            onClick={() => {
              useFeatureRoomStore.getState().setPendingMother(null)
              focusMotherComposerWhenReady()
            }}
          >
            Fechar
          </Button>
        )}
        {error && !busy && error !== EMPTY_PURPOSE_ERROR && (
          <Button type="submit" variant="ghost" data-testid="start-mother-retry">
            Tentar de novo
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={!canSubmit}
          title={blocked ? (preflight?.mcpBlockReason ?? undefined) : undefined}
          data-testid="start-mother-submit"
        >
          {busy ? 'Iniciando…' : 'Iniciar sessão-mãe'}
        </Button>
      </div>
    </form>
  )
}
