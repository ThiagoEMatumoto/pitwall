import { useEffect, useId, useRef, useState } from 'react'
import {
  ChevronDown,
  CircleCheck,
  FolderLock,
  MessageCircleQuestion,
  MessagesSquare,
  ShieldQuestion,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { sessionsApi } from '@/lib/ipc'
import { findManualApproveIndex } from '@/features/sessions/chat/respond-keys'
import { useQuickComposerStore } from '@/features/quick-composer/quick-composer-store'
import type { AttentionAction, AttentionMenuSnapshot, TuiMenu } from '../../../shared/types/ipc'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import type { AttentionDetail, AttentionItem } from './attention-queue'
import {
  claimAttentionPopover,
  isClaimedByOther,
  openAttentionItem,
  useAttentionStore,
} from './useAttentionQueue'

interface ReasonMeta {
  label: string
  icon: LucideIcon
  color: string
}

const REASON_META: Record<AttentionDetail, ReasonMeta> = {
  permission: { label: 'Pede permissão', icon: ShieldQuestion, color: 'var(--color-warning)' },
  trust: { label: 'Confiar na pasta?', icon: FolderLock, color: 'var(--color-warning)' },
  question: { label: 'Pergunta pendente', icon: MessageCircleQuestion, color: 'var(--color-info)' },
  'turn-end': { label: 'Terminou o turno', icon: CircleCheck, color: 'var(--color-text-dim)' },
  'handoff-input': {
    label: 'Pergunta pendente',
    icon: MessagesSquare,
    color: 'var(--color-info)',
  },
}

export function reasonMeta(detail: AttentionDetail): ReasonMeta {
  return REASON_META[detail]
}

// Motivos em que dá pra responder daqui: há menu na tela da PTY.
export function isActionableDetail(detail: AttentionDetail | undefined): boolean {
  return detail === 'permission' || detail === 'trust' || detail === 'question'
}

export interface MenuAction {
  key: string
  label: string
  variant: 'primary' | 'ghost' | 'danger'
  optionIndex: number
  // Label real da opção no buffer: "Sempre" no 2.1.286 libera o diretório pro
  // projeto inteiro, não "sempre este comando" — o usuário precisa ver isso.
  optionLabel: string
}

function findOption(menu: TuiMenu, re: RegExp): number | null {
  return menu.options.find((o) => re.test(o.label))?.index ?? null
}

function action(
  menu: TuiMenu,
  key: string,
  label: string,
  variant: MenuAction['variant'],
  optionIndex: number | null,
): MenuAction[] {
  const option = menu.options.find((o) => o.index === optionIndex)
  return option
    ? [{ key, label, variant, optionIndex: option.index, optionLabel: option.label }]
    : []
}

// Botões por opção REAL do menu (label do buffer), nunca por posição fixa: a
// contagem/ordem muda entre versões da CLI (2.1.286: Yes / always allow / auto
// mode / No). Sem a opção reconhecida o botão não existe.
export function menuActions(menu: TuiMenu): MenuAction[] {
  if (menu.kind === 'permission') {
    return [
      ...action(menu, 'approve', 'Aprovar', 'primary', findOption(menu, /^Yes$/i)),
      ...action(
        menu,
        'always',
        'Sempre',
        'ghost',
        findOption(menu, /always allow|don't ask again|allow all edits/i),
      ),
      ...action(menu, 'deny', 'Negar', 'danger', findOption(menu, /^No\b/i)),
    ]
  }
  if (menu.kind === 'trust') {
    return [
      ...action(menu, 'trust', 'Confiar', 'primary', findOption(menu, /trust this folder/i)),
      ...action(menu, 'exit', 'Sair', 'danger', findOption(menu, /^No\b/i)),
    ]
  }
  if (menu.kind === 'plan') {
    return action(menu, 'approve-plan', 'Aprovar plano', 'primary', findManualApproveIndex(menu))
  }
  if (menu.kind !== 'question' || menu.multiSelect || menu.tabs) return []
  return menu.options
    .filter((o) => o.sentinel == null)
    .map((o) => ({
      key: `opt-${o.index}`,
      label: o.label,
      variant: 'ghost',
      optionIndex: o.index,
      optionLabel: o.label,
    }))
}

function otherOptionIndex(menu: TuiMenu): number | null {
  if (menu.kind !== 'question' || menu.multiSelect || menu.tabs) return null
  return menu.options.find((o) => o.sentinel === 'other')?.index ?? null
}

// "Tip: … choose "switch to auto mode" below" aponta pra opção que o popover não
// oferece; a TUI quebra a frase e o "below" sobra sozinho na linha seguinte.
const TIP_LINE_RE = /^Tip:/
const TIP_TAIL_RE = /^[a-z][^A-Z]{0,30}$/
// Cabeçalho da caixa da TUI ("Bash command"): o popover já diz "Pede permissão".
const TOOL_HEADER_RE = /^(Bash command|Edit file|Create file|Write file|Read file|Fetch|Web fetch|Web search)$/i

export function contextLines(context: string): string[] {
  const out: string[] = []
  let afterTip = false
  for (const raw of stripUnsafeDisplay(context).split('\n')) {
    const line = raw.trim()
    if (TIP_LINE_RE.test(line)) {
      afterTip = !/[.!?]$/.test(line)
      continue
    }
    if (afterTip && TIP_TAIL_RE.test(line)) {
      afterTip = false
      continue
    }
    afterTip = false
    if (TOOL_HEADER_RE.test(line)) continue
    out.push(raw)
  }
  return out
}

function shortPath(path: string): string {
  const parts = path.replace(/\s+/g, '').split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

// O que o "Sempre" concede, em português. A TUI quebra o caminho longo entre o
// label e a descrição da opção; os dois juntos refazem a frase.
export function alwaysHintText(label: string, description?: string): string {
  const full = `${label}${description ? ` ${description}` : ''}`
  const access = /always allow access to (.+?) from this project/i.exec(full)
  if (access) return `permitir acesso a ${shortPath(access[1])} em todo o projeto`
  if (/don't ask again/i.test(full)) return 'não perguntar de novo por este comando'
  if (/allow all edits/i.test(full)) return 'permitir todas as edições nesta sessão'
  return label
}

function MenuContext({ menu }: { menu: TuiMenu }) {
  if (!menu.context) return null
  const lines = contextLines(menu.context)
  if (lines.length === 0) return null
  // Inteiro: quem aprova precisa ver o comando todo, não só o fim dele.
  return (
    <pre
      data-testid="attention-context"
      className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[11px] leading-snug text-[var(--color-text-dim)]"
    >
      {lines.join('\n')}
    </pre>
  )
}

function OtherAnswer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const canSend = !disabled && text.trim() !== ''
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1">
      <input
        type="text"
        value={text}
        disabled={disabled}
        data-testid="attention-other-input"
        aria-label="Outra resposta"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canSend) onSend(text)
        }}
        placeholder="Outra resposta…"
        className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
      />
      <Button
        variant="ghost"
        className="!px-2.5 !py-0.5 text-xs"
        disabled={!canSend}
        onClick={() => onSend(text)}
      >
        Enviar
      </Button>
    </div>
  )
}

const ERROR_NOTICE: Record<string, string> = {
  'menu-changed': 'O menu mudou desde que você abriu — confira as opções de novo.',
  'no-menu': 'O menu já não está na tela.',
  'not-running': 'A sessão encerrou.',
  'invalid-action': 'Essa opção não existe mais no menu.',
  busy: 'Outra resposta a este menu já está a caminho.',
}

// Relê o menu a cada volta do status (waiting→working→waiting): o motivo publicado
// continua 'permission' entre dois prompts seguidos, só o status denuncia a troca.
function useAttentionMenu(item: AttentionItem, onFresh: () => void) {
  const [snapshot, setSnapshot] = useState<AttentionMenuSnapshot | null | undefined>(undefined)
  const actionable = isActionableDetail(item.detail)
  const onFreshRef = useRef(onFresh)
  onFreshRef.current = onFresh
  useEffect(() => {
    if (!actionable || !item.sessionId) {
      setSnapshot(null)
      return
    }
    let cancelled = false
    void sessionsApi.attentionMenu(item.sessionId).then((snap) => {
      if (cancelled) return
      setSnapshot(snap)
      onFreshRef.current()
    })
    return () => {
      cancelled = true
    }
  }, [actionable, item.sessionId, item.detail, item.liveStatus])
  return [snapshot, setSnapshot] as const
}

// Fixado pelo Alt+A o foco ainda está no xterm, que engole o Tab e manda o Esc pra
// TUI (cancelando o prompt que o popover existe pra responder): o popover toma o
// foco — depois do foco que a aba recém-aberta dá ao xterm — e devolve ao fechar.
function useDialogFocus(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!enabled) return
    let origin: HTMLElement | null = null
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const active = document.activeElement
        origin = active instanceof HTMLElement ? active : null
        ref.current?.focus()
      })
    })
    return () => {
      cancelAnimationFrame(raf)
      if (origin?.isConnected) origin.focus()
    }
  }, [enabled])
  return ref
}

interface PopoverProps {
  item: AttentionItem
  onClose?: () => void
  // Fixado abaixo do HUD: vira diálogo e toma o foco.
  pinned?: boolean
}

// O menu real da tela + as ações dele (Aprovar/Negar/Sempre/Responder). O clique
// manda só a intenção + o fingerprint/menuSeq do menu exibido: o main re-parseia a
// tela e recusa se mudou (aí mostramos o menu novo, nunca digitamos às cegas).
// Também mora no cartão aberto do mapa — por isso sem moldura nem cabeçalho.
// O cabeçalho do menu vem da TUI em inglês; no meio da UI em pt-BR ele vira o
// equivalente (o original fica no tooltip). Pergunta desconhecida passa como veio.
const QUESTION_PT: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Do you want to proceed\?$/i, () => 'Quer continuar?'],
  [/^Do you want to make this edit to (.+)\?$/i, (m) => `Aplicar esta edição em ${m[1]}?`],
  [/^Do you want to create (.+)\?$/i, (m) => `Criar ${m[1]}?`],
  [/^Do you want to allow (.+)\?$/i, (m) => `Permitir ${m[1]}?`],
]

export function questionPt(question: string): string {
  const q = question.trim()
  for (const [re, pt] of QUESTION_PT) {
    const m = q.match(re)
    if (m) return pt(m)
  }
  return question
}

export function AttentionMenuPanel({ item }: { item: AttentionItem }) {
  const [notice, setNotice] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useAttentionMenu(item, () => setNotice(null))
  const [sending, setSending] = useState(false)
  const menu = snapshot?.menu ?? null
  const actions = menu ? menuActions(menu) : []
  const otherIndex = menu ? otherOptionIndex(menu) : null
  const alwaysAction = actions.find((a) => a.key === 'always')
  const alwaysOption = menu?.options.find((o) => o.index === alwaysAction?.optionIndex)
  const alwaysHint = alwaysAction
    ? alwaysHintText(alwaysAction.optionLabel, alwaysOption?.description)
    : undefined

  async function send(act: AttentionAction) {
    if (!snapshot || !item.sessionId) return
    setSending(true)
    const res = await sessionsApi.attentionRespond({
      sessionId: item.sessionId,
      fingerprint: snapshot.fingerprint,
      menuSeq: snapshot.menuSeq,
      action: act,
    })
    setSending(false)
    if (res.ok) {
      // Sem snapshot, sem botões: um 2º clique no menu velho iria pro PRÓXIMO prompt.
      setSnapshot(null)
      setNotice('Resposta enviada.')
      return
    }
    setSnapshot(res.snapshot)
    setNotice(ERROR_NOTICE[res.error] ?? 'Não deu pra responder daqui.')
  }

  return (
    <>
      {menu?.question && (
        <p className="text-[13px] leading-snug" title={menu.question}>
          {questionPt(stripUnsafeDisplay(menu.question))}
        </p>
      )}
      {menu && <MenuContext menu={menu} />}
      {snapshot === undefined && isActionableDetail(item.detail) && (
        <p className="text-[var(--color-text-dim)]">Lendo o menu…</p>
      )}
      {snapshot === null && isActionableDetail(item.detail) && !notice && (
        <p className="text-[var(--color-text-dim)]">Menu não reconhecido — responda no terminal.</p>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {actions.map((a) => (
            <Button
              key={a.key}
              data-testid={`attention-action-${a.key}`}
              variant={a.variant}
              disabled={sending}
              className="!px-3 !py-1 text-xs"
              title={a.optionLabel}
              onClick={() => void send({ kind: 'select', optionIndex: a.optionIndex })}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {alwaysHint && (
        <p data-testid="attention-always-hint" className="text-[var(--color-text-dim)]">
          Sempre: {alwaysHint}
        </p>
      )}
      {otherIndex != null && (
        <OtherAnswer
          disabled={sending}
          onSend={(text) => void send({ kind: 'other', optionIndex: otherIndex, text })}
        />
      )}
      {notice && (
        <p data-testid="attention-notice" className="text-[var(--color-text-dim)]">
          {notice}
        </p>
      )}
    </>
  )
}

// Por que a sessão precisa de você + as ações do menu real, sem abrir o terminal.
export function AttentionPopover({ item, onClose, pinned = false }: PopoverProps) {
  const rootRef = useDialogFocus(pinned)
  const titleId = useId()
  const meta = item.detail ? REASON_META[item.detail] : null

  return (
    <div
      ref={rootRef}
      data-testid="attention-popover"
      data-detail={item.detail ?? ''}
      role={pinned ? 'dialog' : undefined}
      aria-labelledby={pinned ? titleId : undefined}
      tabIndex={pinned ? -1 : undefined}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !onClose) return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
      className="flex w-[340px] max-w-[80vw] flex-col gap-2 rounded-xl border p-3 text-xs shadow-xl outline-none"
      style={{
        background: 'var(--color-surface-2)',
        borderColor: 'var(--color-border)',
        color: 'var(--color-text)',
      }}
    >
      <div className="flex items-center gap-2">
        {meta && (
          <Icon as={meta.icon} size={14} className="shrink-0" style={{ color: meta.color }} />
        )}
        <span id={titleId} className="font-semibold">
          {meta?.label ?? 'Aguardando você'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--color-text-dim)]">
          {[item.projectName, item.title].filter(Boolean).join(' · ')}
        </span>
        {onClose && (
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            <Icon as={X} size={12} />
          </button>
        )}
      </div>

      <AttentionMenuPanel item={item} />

      <div className="flex justify-end gap-1.5">
        {/* Filha do dock fica fora dos alvos de envio: fala com ela pelo CrewPeek. */}
        {item.detail === 'turn-end' && item.kind !== 'crew' && item.sessionId && (
          <Button
            variant="ghost"
            data-testid="attention-send-message"
            className="!px-3 !py-1 text-xs"
            onClick={() => {
              useQuickComposerStore.getState().openFor(item.sessionId)
              onClose?.()
            }}
          >
            Enviar mensagem
          </Button>
        )}
        <Button
          variant="ghost"
          data-testid="attention-open"
          className="!px-3 !py-1 text-xs"
          onClick={() => {
            openAttentionItem(item)
            onClose?.()
          }}
        >
          Abrir
        </Button>
      </div>
    </div>
  )
}

function QueueRow({
  item,
  expanded,
  onToggle,
}: {
  item: AttentionItem
  expanded: boolean
  onToggle: () => void
}) {
  const meta = item.detail ? REASON_META[item.detail] : null
  const panelId = useId()
  return (
    <li className="flex flex-col gap-1.5">
      <button
        type="button"
        data-testid="attention-queue-item"
        data-key={item.key}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-surface)]"
      >
        <Icon
          as={meta?.icon ?? MessageCircleQuestion}
          size={13}
          className="shrink-0"
          style={{ color: meta?.color ?? 'var(--color-text-dim)' }}
        />
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        <span className="shrink-0 text-[var(--color-text-dim)]">{meta?.label ?? 'aguardando'}</span>
      </button>
      {expanded && (
        <div id={panelId}>
          <AttentionPopover item={item} />
        </div>
      )}
    </li>
  )
}

// Lista da fila a partir da TitleBar: cada item abre o popover inline. O badge ao
// lado continua pulando para a próxima (Alt+A); este botão só mostra a lista.
export function AttentionQueueButton({ queue }: { queue: AttentionItem[] }) {
  const [open, setOpen] = useState(false)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const claim = useAttentionStore((s) => s.popoverClaim)
  const expandedSession = queue.find((i) => i.key === expandedKey)?.sessionId

  useEffect(() => {
    if (isClaimedByOther(claim, expandedSession, 'list')) setExpandedKey(null)
  }, [claim, expandedSession])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  if (queue.length === 0) return null
  return (
    <div
      ref={ref}
      className="relative"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        data-testid="titlebar-attention-list"
        aria-label="Ver a fila de atenção"
        aria-expanded={open}
        title="Ver a fila de atenção"
        onClick={() => setOpen((v) => !v)}
        onDoubleClick={(e) => e.stopPropagation()}
        className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--color-accent)] transition hover:brightness-125"
        style={{ background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)' }}
      >
        <Icon as={ChevronDown} size={12} />
      </button>
      {open && (
        <div
          data-testid="attention-queue-list"
          className="absolute left-0 top-7 z-[1200] w-[360px] max-w-[85vw] rounded-xl border p-1.5 text-xs shadow-xl"
          style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
        >
          <ul className="flex max-h-[70vh] flex-col gap-0.5 overflow-auto">
            {queue.map((item) => (
              <QueueRow
                key={item.key}
                item={item}
                expanded={expandedKey === item.key}
                onToggle={() => {
                  if (expandedKey === item.key) {
                    setExpandedKey(null)
                    return
                  }
                  claimAttentionPopover(item.sessionId, 'list')
                  setExpandedKey(item.key)
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
