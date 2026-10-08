import { isLedByMother } from '../handoff-lead'
import { handoffAsking } from '../tui/attention-reason'
import type {
  AttentionInput,
  AttentionItem,
  AttentionItemAction,
  AttentionLiveSession,
  HandoffTransition,
  SessionMenuReason,
} from '../types/attention'
import type { Handoff } from '../types/ipc'

// A ÚNICA regra de "precisa de você". Pura: sem relógio, sem I/O — o mesmo input
// devolve o mesmo JSON, e é isso que deixa o main só re-broadcastar quando muda.
// Nada aqui lê o carimbo de última escrita do handoff: ele muda a cada UPDATE e
// mentiria sobre "desde quando".

const SEVERITY_RANK = { blocking: 0, action: 1, info: 2 } as const
const TERMINAL = new Set(['done', 'failed', 'interrupted'])

const alive = (s: AttentionLiveSession | undefined): s is AttentionLiveSession =>
  !!s && s.status !== 'ended'

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

type LiveById = Map<string, AttentionLiveSession>

export function projectAttention(input: AttentionInput): AttentionItem[] {
  const live: LiveById = new Map(input.live.map((s) => [s.sessionId, s]))
  // Handoff de que a sessão é filha HOJE e que o dock mostra (isLedByMother).
  const ledByChild = new Map<string, Handoff>()
  for (const h of input.handoffs)
    if (h.childSessionId && isLedByMother(h)) ledByChild.set(h.childSessionId, h)

  const items: AttentionItem[] = []
  // Handoffs já cobertos por um session_menu: o PTY é testemunha de primeira mão
  // e vence a pergunta registrada (no máximo 1 item não-info por sujeito).
  const menuSubjects = new Set<string>()
  for (const s of input.live) {
    // Tela não reconhecida entra ('unrecognized'): suprimir em silêncio é pior
    // que contar a mais. Só o fim de turno reconhecido fica de fora.
    if (s.status !== 'waiting' || s.screenReason === 'turn-end') continue
    const h = ledByChild.get(s.sessionId)
    if (h) menuSubjects.add(h.id)
    items.push(sessionMenuItem(s, h))
  }

  const byHandoff = new Map<string, AttentionItem>()
  for (const h of input.handoffs) {
    const t = input.transitions.get(h.id)
    const item = handoffItem(h, t, live, menuSubjects)
    if (item) {
      items.push(item)
      byHandoff.set(h.id, item)
    }
  }

  for (const h of input.handoffs) {
    if (menuSubjects.has(h.id)) continue
    const orphan = ptyOrphan(h, input.transitions.get(h.id), live, ledByChild, byHandoff)
    if (orphan) items.push(orphan)
  }

  return items.sort(compareItems)
}

function handoffItem(
  h: Handoff,
  t: HandoffTransition | undefined,
  live: LiveById,
  menuSubjects: ReadonlySet<string>,
): AttentionItem | null {
  // Menu na tela da filha já é o item do handoff (pergunta ou interrupção retomável).
  if (menuSubjects.has(h.id)) return null
  if (isLedByMother(h) && handoffAsking(h)) return childQuestionItem(h)
  if (h.status === 'failed' && h.dismissedAt == null && inScope(h, live))
    return childFailedItem(h, t, live)
  if (h.status === 'interrupted' && isLedByMother(h)) return childInterruptedItem(h, t, live)
  if (h.status === 'done' && h.consumedAt == null && h.dismissedAt == null && inScope(h, live))
    return resultUnconsumedItem(h, t, live)
  return null
}

// Recorte de failed/done: só entra se alguém com PTY viva pode agir. Sem isso o
// histórico (centenas de done nunca consumidos) lotaria a fila.
function inScope(h: Handoff, live: LiveById): boolean {
  return alive(live.get(h.motherSessionId ?? '')) || alive(live.get(h.childSessionId ?? ''))
}

function compareItems(a: AttentionItem, b: AttentionItem): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) ||
    a.dedupKey.localeCompare(b.dedupKey)
  )
}

function handoffBase(h: Handoff) {
  return {
    sessionId: h.childSessionId,
    handoffId: h.id,
    featureId: h.featureId,
    repoId: h.targetRepoId,
  }
}

// Sem evento da transição (handoff legado): sem relógio, e a chave diz isso.
const stamp = (t: HandoffTransition | undefined): string => (t ? String(t.at) : 'legacy')

const MENU_WHY: Record<SessionMenuReason, string> = {
  permission: 'Permissão pedida na tela',
  question: 'Pergunta na tela',
  trust: 'Confiar na pasta',
  unrecognized: 'Esperando você (tela não reconhecida)',
}

function sessionMenuItem(s: AttentionLiveSession, h: Handoff | undefined): AttentionItem {
  const reason: SessionMenuReason =
    s.screenReason && s.screenReason !== 'turn-end' ? s.screenReason : 'unrecognized'
  const actions: AttentionItemAction[] = []
  if (s.menuSeq != null && reason !== 'unrecognized')
    actions.push({ kind: 'respond_menu', sessionId: s.sessionId, menuSeq: s.menuSeq })
  actions.push({ kind: 'open_session', sessionId: s.sessionId })
  return {
    kind: 'session_menu',
    dedupKey: `session_menu:${s.sessionId}:${s.menuSeq ?? `w${s.lastActivityAt ?? 0}`}`,
    whyNow: MENU_WHY[reason],
    entryRule: 'sessions/<pid>.json status=waiting e tela ≠ turn-end (tuiMenuWatch)',
    exitRule: 'status sai de waiting, ou a tela vira turn-end, ou a PTY morre (pty:exit)',
    severity: 'blocking',
    audience: 'human',
    sessionId: s.sessionId,
    handoffId: h?.id ?? null,
    featureId: h?.featureId ?? s.featureId,
    repoId: s.repoId,
    createdAt: s.lastActivityAt,
    actions,
    menuReason: reason,
  }
}

function childQuestionItem(h: Handoff): AttentionItem {
  const actions: AttentionItemAction[] = [{ kind: 'send_message', handoffId: h.id }]
  if (h.childSessionId) actions.push({ kind: 'open_session', sessionId: h.childSessionId })
  actions.push({ kind: 'dismiss', handoffId: h.id })
  return {
    kind: 'child_question',
    dedupKey: `child_question:${h.id}:${h.questionAskedAt}`,
    whyNow: `${clip(h.task, 60)} perguntou: ${clip(h.pendingQuestion ?? '', 140)}`,
    entryRule: "handoffs.status='needs_input' (evento 'ask') e stepUpdatedAt ≤ questionAskedAt",
    exitRule:
      'handoffs:send-message → resume (running), handoff_progress com stepUpdatedAt > questionAskedAt, dismiss ou status terminal',
    severity: 'blocking',
    audience: 'human',
    ...handoffBase(h),
    createdAt: h.questionAskedAt,
    actions,
  }
}

// Filha com PTY viva num handoff já encerrado ganha "encerrar sessão" no próprio
// item (ele absorve o pty_orphan do mesmo handoff).
function liveChildActions(h: Handoff, live: LiveById): AttentionItemAction[] {
  const child = live.get(h.childSessionId ?? '')
  if (!alive(child)) return []
  return [
    { kind: 'open_session', sessionId: child.sessionId },
    { kind: 'kill_session', sessionId: child.sessionId },
  ]
}

function childFailedItem(
  h: Handoff,
  t: HandoffTransition | undefined,
  live: LiveById,
): AttentionItem {
  return {
    kind: 'child_failed',
    dedupKey: `child_failed:${h.id}:${stamp(t)}`,
    whyNow: `Falhou: ${clip(h.error ?? 'sem mensagem', 140)}`,
    entryRule:
      "handoffs.status='failed' (evento 'fail'), não dispensado, mãe ou filha com PTY viva",
    exitRule: 'dismiss, retomada (markRunning) ou mãe e filha sem PTY',
    severity: 'action',
    audience: 'human',
    ...handoffBase(h),
    createdAt: t?.at ?? null,
    actions: [{ kind: 'dismiss', handoffId: h.id }, ...liveChildActions(h, live)],
  }
}

function childInterruptedItem(
  h: Handoff,
  t: HandoffTransition | undefined,
  live: LiveById,
): AttentionItem {
  const killOnly = liveChildActions(h, live).filter((a) => a.kind === 'kill_session')
  return {
    kind: 'child_interrupted',
    dedupKey: `child_interrupted:${h.id}:${stamp(t)}`,
    whyNow: 'Interrompida; dá pra retomar',
    entryRule:
      "handoffs.status='interrupted' (interrupt/reconcileStuck), resumable (transcript no disco), não dispensado",
    exitRule: 'retomada, dismiss ou transcript sumiu (resumable=false)',
    severity: 'action',
    audience: 'human',
    ...handoffBase(h),
    createdAt: t?.at ?? null,
    actions: [
      { kind: 'reopen_child', handoffId: h.id },
      { kind: 'dismiss', handoffId: h.id },
      ...killOnly,
    ],
  }
}

function resultUnconsumedItem(
  h: Handoff,
  t: HandoffTransition | undefined,
  live: LiveById,
): AttentionItem {
  const mother = live.get(h.motherSessionId ?? '')
  return {
    kind: 'result_unconsumed',
    dedupKey: `result_unconsumed:${h.id}:${stamp(t)}`,
    whyNow:
      'Resultado pronto que a mãe ainda não leu (item da mãe; fora da fila humana por padrão)',
    entryRule: "handoffs.status='done' (evento 'report') com consumed_at IS NULL",
    exitRule: 'markConsumed (handoff_result) ou dismiss',
    severity: 'info',
    audience: 'mother',
    ...handoffBase(h),
    createdAt: t?.at ?? null,
    actions: alive(mother) ? [{ kind: 'open_session', sessionId: mother.sessionId }] : [],
  }
}

function ptyOrphan(
  h: Handoff,
  t: HandoffTransition | undefined,
  live: LiveById,
  ledByChild: ReadonlyMap<string, Handoff>,
  byHandoff: ReadonlyMap<string, AttentionItem>,
): AttentionItem | null {
  if (!TERMINAL.has(h.status) || !h.childSessionId) return null
  const child = live.get(h.childSessionId)
  if (!alive(child)) return null
  // Soltar a filha mantém a sessão viva de propósito.
  if (t?.event === 'release') return null
  // Outro handoff ativo adotou a sessão (bastão/adoção): ela não é mais deste.
  const owner = ledByChild.get(h.childSessionId)
  if (owner && owner.id !== h.id) return null
  // failed/interrupted já carregam kill_session no próprio item.
  const existing = byHandoff.get(h.id)
  if (existing && existing.kind !== 'result_unconsumed') return null
  return {
    kind: 'pty_orphan',
    dedupKey: `pty_orphan:${h.id}:${stamp(t)}`,
    whyNow: `Handoff ${h.status} com a sessão ainda aberta`,
    entryRule:
      "handoff terminal (done/failed/interrupted, último evento ≠ 'release') com PTY da filha viva",
    exitRule: 'PTY sai (pty:exit) ou outro handoff ativo adota a sessão',
    severity: h.status === 'done' ? 'info' : 'action',
    audience: 'human',
    ...handoffBase(h),
    createdAt: t?.at ?? null,
    actions: [
      { kind: 'kill_session', sessionId: child.sessionId },
      { kind: 'open_session', sessionId: child.sessionId },
    ],
  }
}
