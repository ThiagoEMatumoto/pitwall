import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { FileText } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { sendToApi } from '@/lib/ipc'
import { STATUS_DOT, searchTargets, type SendTarget } from '@/features/quick-composer/target-search'
import { activeMentionToken, filterFiles, type ActiveToken } from './mention-parser'
import type { RepoFilesResult } from '../../../shared/types/send-prompt'

const MAX_ITEMS = 8

export const NO_SESSION_MATCH = 'Nenhuma sessão com esse nome — sessões encerradas não aparecem'

// Pílula de uma sessão: ponto de status + @alias no tom do projeto.
export function SessionPill({ target }: { target: SendTarget }) {
  const tone = target.projectColor ?? 'var(--color-accent)'
  return (
    <span
      data-testid="session-pill"
      data-alias={target.alias}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] text-[var(--color-text)]"
      style={{
        background: `color-mix(in srgb, ${tone} 16%, transparent)`,
        borderColor: `color-mix(in srgb, ${tone} 35%, transparent)`,
      }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: STATUS_DOT[target.status] }}
      />
      <span className="truncate">@{target.alias}</span>
    </span>
  )
}

function useRepoFiles(cwd: string | null): RepoFilesResult | null {
  const [result, setResult] = useState<{ cwd: string; files: RepoFilesResult } | null>(null)
  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    void sendToApi
      .listRepoFiles(cwd)
      .then((files) => {
        if (!cancelled) setResult({ cwd, files })
      })
      .catch((err) => console.error('[mention] falha ao listar arquivos:', err))
    return () => {
      cancelled = true
    }
  }, [cwd])
  return result && result.cwd === cwd ? result.files : null
}

export type MentionPick = { token: ActiveToken; replacement: string }

interface MenuInput {
  text: string
  caret: number
  targets: SendTarget[]
  // Pasta do destino atual: é onde o #arquivo resolve.
  cwd: string | null
  // QuickComposer: o @ é o único jeito de rotear, então Enter escolhe o primeiro e
  // @ sem sessão não envia. Composer da aba: o texto é do claude (#12, @Makefile),
  // então Enter só escolhe depois de navegar com as setas e @ sem sessão segue.
  strict: boolean
}

// Estado + teclado do menu de @/#. O caller aplica a escolha (applyCompletion)
// porque só ele sabe mexer no textarea.
export function useMentionMenu({ text, caret, targets, cwd, strict }: MenuInput) {
  const token = activeMentionToken(text, caret)
  const tokenKey = token ? `${token.kind}:${token.start}` : null
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const open = token != null && tokenKey !== dismissed
  const files = useRepoFiles(open && token.kind === 'file' ? cwd : null)

  const sessions = useMemo(
    () => (open && token.kind === 'session' ? searchTargets(token.query, targets) : []),
    [open, token?.kind, token?.query, targets],
  )
  const fileItems = useMemo(
    () =>
      open && token.kind === 'file' && files
        ? filterFiles(token.query, files.files, MAX_ITEMS)
        : [],
    [open, token?.kind, token?.query, files],
  )
  const count = token?.kind === 'session' ? Math.min(sessions.length, MAX_ITEMS) : fileItems.length

  useEffect(() => {
    setActive(0)
    setNavigated(false)
  }, [token?.query, token?.kind])
  useEffect(() => {
    if (tokenKey !== dismissed) setDismissed(null)
  }, [tokenKey, dismissed])

  function pick(i: number): MentionPick | null {
    if (!token) return null
    const replacement =
      token.kind === 'session' ? `@${sessions[i]?.alias ?? ''}` : `#${fileItems[i] ?? ''}`
    if (replacement.length <= 1) return null
    setDismissed(null)
    return { token, replacement }
  }

  // 'pick' = aplicar a escolha; 'consumed' = a tecla era do menu; null = segue.
  function onKey(e: {
    key: string
    shiftKey?: boolean
  }): { kind: 'pick'; pick: MentionPick } | { kind: 'consumed' } | null {
    if (!open || !token) return null
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (count > 0) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
      setNavigated(true)
      return { kind: 'consumed' }
    }
    if (e.key === 'Escape') {
      setDismissed(tokenKey)
      return { kind: 'consumed' }
    }
    const enter = e.key === 'Enter' && !e.shiftKey
    // Shift+Tab é o ciclo do modo de permissão da TUI, nunca do menu.
    const tab = e.key === 'Tab' && !e.shiftKey
    if (!enter && !tab) return null
    const chosen = count > 0 && (strict || tab || navigated) ? pick(active) : null
    if (chosen) return { kind: 'pick', pick: chosen }
    // @ sem sessão que case: no QuickComposer, Enter não envia (o rascunho não some).
    if (strict && enter && token.kind === 'session') return { kind: 'consumed' }
    return null
  }

  return {
    open,
    token,
    sessions: sessions.slice(0, MAX_ITEMS),
    files: fileItems,
    filesResult: files,
    active,
    setActive,
    pick,
    onKey,
    cwd,
  }
}

export type MentionMenuState = ReturnType<typeof useMentionMenu>

interface Props {
  menu: MentionMenuState
  onPick: (pick: MentionPick) => void
  className?: string
  style?: CSSProperties
}

function SessionsSection({ menu, onPick }: Props) {
  if (menu.sessions.length === 0) {
    return (
      <p data-testid="mention-empty" className="px-3 py-2 text-[var(--color-text-dim)]">
        {NO_SESSION_MATCH}
      </p>
    )
  }
  return (
    <ul role="listbox" aria-label="Sessões">
      {menu.sessions.map((t, i) => (
        <li
          key={t.sessionId}
          role="option"
          aria-selected={i === menu.active}
          data-testid="mention-session"
          onMouseEnter={() => menu.setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            const p = menu.pick(i)
            if (p) onPick(p)
          }}
          className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
            i === menu.active ? 'bg-[var(--color-surface)]' : ''
          }`}
        >
          <SessionPill target={t} />
          <span className="min-w-0 truncate text-[var(--color-text)]">{t.label}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-dim)]">
            {[t.projectName, t.purpose].filter(Boolean).join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  )
}

function FilesSection({ menu, onPick }: Props) {
  if (!menu.cwd) {
    return (
      <p className="px-3 py-2 text-[var(--color-text-dim)]">
        Sessão sem pasta conhecida — não há arquivos pra sugerir
      </p>
    )
  }
  if (!menu.filesResult) return <p className="px-3 py-2 text-[var(--color-text-dim)]">Lendo…</p>
  if (menu.files.length === 0) {
    return (
      <p className="px-3 py-2 text-[var(--color-text-dim)]">
        Nenhum arquivo casa com “{menu.token?.query}”
      </p>
    )
  }
  return (
    <ul role="listbox" aria-label="Arquivos">
      {menu.files.map((f, i) => (
        <li
          key={f}
          role="option"
          aria-selected={i === menu.active}
          data-testid="mention-file"
          onMouseEnter={() => menu.setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            const p = menu.pick(i)
            if (p) onPick(p)
          }}
          className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono ${
            i === menu.active ? 'bg-[var(--color-surface)]' : ''
          }`}
        >
          <Icon as={FileText} size={12} className="shrink-0 text-[var(--color-text-dim)]" />
          <span className="truncate text-[var(--color-text)]">{f}</span>
        </li>
      ))}
    </ul>
  )
}

// Popover do @ (sessões de todos os projetos) e do # (arquivos do destino).
export function MentionMenu({ menu, onPick, className = '', style }: Props) {
  if (!menu.open || !menu.token) return null
  const isSession = menu.token.kind === 'session'
  return (
    <div
      data-testid="mention-menu"
      data-kind={menu.token.kind}
      className={`z-50 flex max-h-72 w-[26rem] max-w-[90vw] flex-col overflow-hidden rounded-xl border text-xs shadow-xl ${className}`}
      style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', ...style }}
    >
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
        {isSession ? 'Sessões' : 'Arquivos'}
        {!isSession && menu.filesResult?.truncated && ' (lista cortada em 20 mil)'}
      </div>
      <div className="min-h-0 overflow-auto pb-1">
        {isSession ? (
          <SessionsSection menu={menu} onPick={onPick} />
        ) : (
          <FilesSection menu={menu} onPick={onPick} />
        )}
      </div>
      <div className="border-t border-[var(--color-border)] px-3 py-1 text-[10px] text-[var(--color-text-dim)]">
        ↑↓ navegar · Enter/Tab escolher · Esc fechar
      </div>
    </div>
  )
}
