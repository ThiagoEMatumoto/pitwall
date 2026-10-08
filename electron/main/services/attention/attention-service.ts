import type Database from 'better-sqlite3'
import { getDb } from '../db'
import * as handoffStore from '../handoff-store'
import { buildSessionsFileIndex } from '../session-activity'
import { liveSessionStates, type SessionsFileIndex } from '../live-session-states'
import type { LiveSessionState } from '../session-graph'
import { tuiMenuWatch } from '../tui-menu-watch'
import { liveNeedsYou, projectAttention } from '../../../../shared/attention/project-attention'
import { deriveAttentionReason, type ScreenScan } from '../../../../shared/tui/attention-reason'
import {
  PRODUCED_ATTENTION_KINDS,
  type AttentionCounters,
  type AttentionInput,
  type AttentionItem,
  type AttentionLiveSession,
  type HandoffTransition,
  type ProducedAttentionKind,
} from '../../../../shared/types/attention'
import type { Handoff, HandoffStatus } from '../../../../shared/types/ipc'

// Só esses status têm "desde quando" vindo de handoff_events. needs_input usa
// question_asked_at (coluna do próprio ask).
const TRANSITION_STATUSES = new Set<HandoffStatus>(['done', 'failed', 'interrupted'])

export function readTransitions(
  db: Database.Database,
  handoffs: Handoff[],
): Map<string, HandoffTransition> {
  const ids = handoffs.filter((h) => TRANSITION_STATUSES.has(h.status)).map((h) => h.id)
  if (ids.length === 0) return new Map()
  // Última transição REAL (from ≠ to) para o status atual: reconcileFailedChild
  // (failed→failed) e dismiss (X→X) não mexem no "desde quando".
  const rows = db
    .prepare(
      `SELECT e.handoff_id, e.event, e.at FROM handoff_events e
       JOIN handoffs h ON h.id = e.handoff_id
      WHERE e.handoff_id IN (SELECT value FROM json_each(?))
        AND e.to_status = h.status
        AND (e.from_status IS NULL OR e.from_status <> e.to_status)
      ORDER BY e.at`,
    )
    .all(JSON.stringify(ids)) as Array<{ handoff_id: string; event: string; at: number }>
  const out = new Map<string, HandoffTransition>()
  // ORDER BY at: a mais recente sobrescreve.
  for (const r of rows) out.set(r.handoff_id, { at: r.at, event: r.event })
  return out
}

export function toAttentionLive(
  row: { id: string; feature_id: string | null; repo_id: string | null },
  state: LiveSessionState,
  scan: ScreenScan | null,
  menuSeq: number | null,
): AttentionLiveSession {
  const reason = deriveAttentionReason({ status: state.status, scan, handoffAsking: false })
  return {
    sessionId: row.id,
    status: state.status,
    screenReason: reason === 'handoff-input' ? undefined : reason,
    menuSeq,
    lastActivityAt: state.lastActivityAt,
    featureId: row.feature_id,
    repoId: row.repo_id,
  }
}

// Monta o input a partir de estados vivos já lidos (o grafo e os testes passam
// os seus; o caminho do app usa liveSessionStates).
export function readAttentionInputFrom(
  db: Database.Database,
  states: Map<string, LiveSessionState>,
): AttentionInput {
  const rows = db
    .prepare(
      `SELECT id, feature_id, repo_id FROM sessions WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...states.keys()])) as Array<{
    id: string
    feature_id: string | null
    repo_id: string | null
  }>
  const handoffs = handoffStore.list()
  return {
    handoffs,
    transitions: readTransitions(db, handoffs),
    live: rows.map((r) =>
      toAttentionLive(
        r,
        states.get(r.id)!,
        tuiMenuWatch.current(r.id),
        tuiMenuWatch.menuSeqOf(r.id),
      ),
    ),
  }
}

export function readAttentionInput(
  index: SessionsFileIndex = buildSessionsFileIndex(),
): AttentionInput {
  return readAttentionInputFrom(getDb(), liveSessionStates(index))
}

function emptyByKind(): Record<ProducedAttentionKind, number> {
  return Object.fromEntries(PRODUCED_ATTENTION_KINDS.map((k) => [k, 0])) as Record<
    ProducedAttentionKind,
    number
  >
}

let counters: AttentionCounters = {
  computedAt: null,
  byKind: emptyByKind(),
  liveWaitingNotTurnEnd: 0,
  sessionMenuItems: 0,
}

// Contador consumível do fail-closed: se liveWaitingNotTurnEnd ≠ sessionMenuItems,
// a projeção está engolindo menus que a tela mostra.
export function attentionCounters(): AttentionCounters {
  return counters
}

export function projectAndCount(input: AttentionInput): AttentionItem[] {
  const items = projectAttention(input)
  const byKind = emptyByKind()
  for (const i of items) if (i.kind in byKind) byKind[i.kind as ProducedAttentionKind]++
  counters = {
    computedAt: Date.now(),
    byKind,
    liveWaitingNotTurnEnd: input.live.filter(liveNeedsYou).length,
    sessionMenuItems: byKind.session_menu,
  }
  return items
}

export function computeAttention(index?: SessionsFileIndex): AttentionItem[] {
  return projectAndCount(readAttentionInput(index))
}
