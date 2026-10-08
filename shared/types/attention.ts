import type { LiveStatus } from '../tui/attention-reason'
import type { Handoff } from './ipc'

// A fila única de "precisa de você". HUD, Crew Dock, switcher e mapa leem a
// MESMA lista (attention:list); cada contagem é o length de um recorte dela.
export type AttentionKind =
  | 'child_question'
  | 'session_menu'
  | 'child_failed'
  | 'child_interrupted'
  | 'pty_orphan'
  | 'result_unconsumed'
  // Declarados pelo contrato, SEM produtor até a fase indicada. A UI não renderiza.
  | 'wake_held'
  | 'wake_expired' // F1
  | 'request' // F3
  | 'review'
  | 'repair_exhausted' // F4
  | 'subtree_stalled' // F5

export const PRODUCED_ATTENTION_KINDS = [
  'child_question',
  'session_menu',
  'child_failed',
  'child_interrupted',
  'pty_orphan',
  'result_unconsumed',
] as const satisfies readonly AttentionKind[]

export type ProducedAttentionKind = (typeof PRODUCED_ATTENTION_KINDS)[number]

export type AttentionSeverity = 'blocking' | 'action' | 'info'
// Quem age no item. result_unconsumed é da mãe (handoff_result); a fila humana
// só o mostra se a UI pedir (humanQueue includeInfo).
export type AttentionAudience = 'human' | 'mother'

// Cada ação aponta para um caminho que JÁ existe. O renderer decide aba vs quick
// look (o main não conhece openPaneKeys).
export type AttentionItemAction =
  | { kind: 'respond_menu'; sessionId: string; menuSeq: number } // sessions:attention-menu / attention-respond
  | { kind: 'send_message'; handoffId: string } // handoffs:send-message
  | { kind: 'dismiss'; handoffId: string } // handoffs:dismiss
  | { kind: 'reopen_child'; handoffId: string } // mesmo handler do "Retomar" do card do dock
  | { kind: 'open_session'; sessionId: string } // renderer: aba ou quick look
  | { kind: 'kill_session'; sessionId: string } // sessions:kill

export type SessionMenuReason = 'permission' | 'trust' | 'question' | 'unrecognized'

export interface AttentionItem {
  kind: AttentionKind
  dedupKey: string
  whyNow: string // pt-BR, frase para o humano
  entryRule: string // cita coluna/evento de origem
  exitRule: string // idem
  severity: AttentionSeverity
  audience: AttentionAudience
  sessionId: string | null
  handoffId: string | null
  featureId: string | null
  repoId: string | null
  createdAt: number | null // nunca updated_at; null = sem relógio confiável
  actions: AttentionItemAction[]
  menuReason?: SessionMenuReason // só session_menu
}

// Uma PTY viva deste app, como o main a vê. Montada SÓ por toAttentionLive (main).
export interface AttentionLiveSession {
  sessionId: string
  status: LiveStatus
  // Motivo da TELA, sem handoffAsking: deriveAttentionReason({ ..., handoffAsking: false }).
  screenReason: 'permission' | 'trust' | 'question' | 'turn-end' | undefined
  menuSeq: number | null // tuiMenuWatch.menuSeqOf (null sem menu na tela)
  lastActivityAt: number | null // sessions/<pid>.json updatedAt (índice), não o DB
  featureId: string | null // sessions.feature_id
  repoId: string | null // sessions.repo_id
}

// Última transição real para o status ATUAL do handoff (handoff_events).
export interface HandoffTransition {
  at: number
  event: string
}

export interface AttentionInput {
  handoffs: Handoff[] // handoffStore.list()
  transitions: ReadonlyMap<string, HandoffTransition>
  live: AttentionLiveSession[]
}

// Contador consumível (attention:debug). liveWaitingNotTurnEnd e sessionMenuItems
// têm que ser iguais: se divergirem, a projeção está suprimindo menus.
export interface AttentionCounters {
  computedAt: number | null
  byKind: Record<ProducedAttentionKind, number>
  liveWaitingNotTurnEnd: number
  sessionMenuItems: number
}
