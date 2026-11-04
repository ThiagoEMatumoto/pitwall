import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, History } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { stripUnsafeDisplay } from '../../../../shared/tui/permission-request'
import type { TuiHistorySearch } from '../tui-picker-parser'
import { historyAcceptEffect } from '../history-search-keys'

interface Props {
  picker: TuiHistorySearch
  // Ausentes = card só leitura (sem PTY ou resposta em voo).
  onQuery?: (prev: string, next: string) => void
  onOlder?: () => void
  onNewer?: () => void
  onSelect?: (index: number) => void
  onAccept?: () => void
  onFill?: () => void
  onCancel?: () => void
  onScope?: () => void
  sent?: boolean
}

const btn =
  'rounded border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium transition hover:border-[var(--color-accent)]/60 disabled:opacity-40'

// Busca de histórico (Ctrl+R). Duas telas da CLI, com teclas diferentes (ver
// tui-picker-parser): inline, Enter ENVIA o prompt achado; no modal do fullscreen, Enter
// só PREENCHE a caixa do terminal. O card diz qual das duas vale antes do clique.
export function HistorySearchCard({
  picker,
  onQuery,
  onOlder,
  onNewer,
  onSelect,
  onAccept,
  onFill,
  onCancel,
  onScope,
  sent,
}: Props) {
  const live = !sent
  const [query, setQuery] = useState(picker.query)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setQuery(picker.query)
  }, [picker.query])
  const effect = historyAcceptEffect(picker)
  const modal = picker.mode === 'modal'
  const result = modal
    ? picker.results?.find((r) => r.index === picker.cursorIndex)?.text
    : picker.match
  const hasResult = result != null && !picker.noMatch

  return (
    <div
      data-testid="history-search"
      data-mode={picker.mode}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/40 text-sm"
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
        <Icon as={History} size={14} className="shrink-0 text-[var(--color-text-dim)]" />
        <span className="font-medium text-[var(--color-text)]">Busca no histórico de prompts</span>
        {modal && (
          <button
            type="button"
            data-testid="history-scope"
            disabled={!live || onScope == null}
            onClick={onScope}
            title="Alterna entre todos os projetos, esta sessão e este projeto (ctrl+s)"
            className="ml-auto rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-40"
          >
            Escopo: {scopeLabel(picker.scope)}
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <input
          data-testid="history-query"
          value={query}
          disabled={!live || onQuery == null}
          placeholder="Digite para buscar…"
          onFocus={() => (focused.current = true)}
          onBlur={() => (focused.current = false)}
          onChange={(e) => {
            const next = e.target.value
            onQuery?.(query, next)
            setQuery(next)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hasResult) {
              e.preventDefault()
              onAccept?.()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel?.()
            }
          }}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60"
        />
        {modal ? (
          <ModalResults
            picker={picker}
            live={live}
            onSelect={onSelect}
            onOlder={onOlder}
            onNewer={onNewer}
          />
        ) : (
          <div data-testid="history-match" className="text-xs text-[var(--color-text)]">
            {picker.noMatch ? (
              <>
                Nenhum prompt encontrado para{' '}
                <span className="font-mono">{stripUnsafeDisplay(picker.query)}</span>
              </>
            ) : hasResult ? (
              <>
                Encontrado: <span className="font-mono">{stripUnsafeDisplay(result!)}</span>
              </>
            ) : (
              'Digite para buscar nos prompts enviados neste projeto.'
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="history-accept"
            disabled={!live || onAccept == null || !hasResult}
            onClick={onAccept}
            className={`${btn} ${effect === 'send' ? 'border-[var(--color-accent)]/50' : ''}`}
          >
            {effect === 'send' ? 'Enviar este prompt (Enter)' : 'Usar este prompt (Enter)'}
          </button>
          {!modal && (
            <>
              <button
                type="button"
                data-testid="history-fill"
                disabled={!live || onFill == null || !hasResult}
                onClick={onFill}
                className={btn}
              >
                Só preencher (Tab)
              </button>
              <button
                type="button"
                data-testid="history-older"
                disabled={!live || onOlder == null || !hasResult}
                onClick={onOlder}
                className={btn}
              >
                Anterior (Ctrl+R)
              </button>
            </>
          )}
          <button
            type="button"
            data-testid="history-cancel"
            disabled={!live || onCancel == null}
            onClick={onCancel}
            className={`${btn} hover:border-[var(--color-danger)]/40`}
          >
            {!modal && picker.query !== '' ? 'Cancelar (Ctrl+C)' : 'Cancelar (Esc)'}
          </button>
        </div>
        <div data-testid="history-effect" className="text-xs text-[var(--color-text-dim)]">
          {sent
            ? 'Enviado ao terminal…'
            : effect === 'send'
              ? 'Enviar manda o prompt ao Claude na hora. Só preencher deixa o texto na caixa do terminal, sem enviar. Cancelar fecha a busca e devolve o que havia na caixa.'
              : 'Usar só preenche a caixa do terminal: nada é enviado ao Claude. Cancelar devolve o que havia na caixa.'}
        </div>
      </div>
    </div>
  )
}

function scopeLabel(scope: string | undefined): string {
  if (scope === 'everywhere') return 'todos os projetos'
  if (scope === 'session') return 'esta sessão'
  if (scope === 'project') return 'este projeto'
  return scope ?? '?'
}

function ModalResults({
  picker,
  live,
  onSelect,
  onOlder,
  onNewer,
}: {
  picker: TuiHistorySearch
  live: boolean
  onSelect?: (index: number) => void
  onOlder?: () => void
  onNewer?: () => void
}) {
  const results = picker.results ?? []
  if (results.length === 0) {
    return <div className="text-xs text-[var(--color-text)]">Nenhum prompt encontrado.</div>
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-label="Mais antigo"
        data-testid="history-up"
        disabled={!live || onOlder == null}
        onClick={onOlder}
        className="self-start rounded p-0.5 text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-30"
      >
        <Icon as={ChevronUp} size={13} />
      </button>
      {results.map((r) => {
        const current = r.index === picker.cursorIndex
        return (
          <button
            key={r.index}
            type="button"
            data-testid={`history-result-${r.index}`}
            disabled={!live || onSelect == null}
            onClick={() => onSelect?.(r.index)}
            className={`flex items-baseline gap-2 rounded border px-2 py-0.5 text-left text-xs transition hover:border-[var(--color-accent)]/60 disabled:opacity-40 ${
              current
                ? 'border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10'
                : 'border-[var(--color-border)]'
            }`}
          >
            <span className="shrink-0 text-[11px] text-[var(--color-text-dim)]">
              {stripUnsafeDisplay(r.age)}
            </span>
            <span className="min-w-0 truncate font-mono text-[var(--color-text)]">
              {stripUnsafeDisplay(r.text)}
            </span>
          </button>
        )
      })}
      <button
        type="button"
        aria-label="Mais recente"
        data-testid="history-down"
        disabled={!live || onNewer == null}
        onClick={onNewer}
        className="self-start rounded p-0.5 text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-30"
      >
        <Icon as={ChevronDown} size={13} />
      </button>
    </div>
  )
}
