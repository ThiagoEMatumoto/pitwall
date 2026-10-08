import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import {
  classifyChoice,
  permissionSummary,
  type AttentionChoice,
} from '../../../shared/tui/permission-request'
import type { AttentionAction, TuiMenu } from '../../../shared/types/ipc'

export interface AttentionResponseInput {
  sessionId: string
  handoffId: string | null
  menu: TuiMenu
  action: AttentionAction
  // null = aparição do menu não observada (espelho aberto com o menu já na tela).
  waitedMs: number | null
  at: number
}

export function recordAttentionResponse(input: AttentionResponseInput): void {
  const { menu } = input
  const isPermission = menu.kind === 'permission'
  getDb()
    .prepare(
      `INSERT INTO attention_responses
         (id, session_id, handoff_id, menu_kind, tool, command_summary, choice, waited_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.sessionId,
      input.handoffId,
      menu.kind,
      isPermission ? (menu.request?.tool ?? null) : null,
      isPermission ? permissionSummary(menu) : null,
      classifyChoice(menu, input.action),
      input.waitedMs,
      input.at,
    )
}

export const STATS_WINDOW_DAYS = 7

export interface AttentionResponseStats {
  windowDays: number
  count: number
  // Só filhas de handoff: é a espera que trava um agente despachado.
  crewCount: number
  medianWaitMs: number | null
  crewMedianWaitMs: number | null
  byChoice: Partial<Record<AttentionChoice, number>>
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export function attentionResponseStats(now = Date.now()): AttentionResponseStats {
  const rows = getDb()
    .prepare(
      'SELECT handoff_id, choice, waited_ms FROM attention_responses WHERE created_at >= ?',
    )
    .all(now - STATS_WINDOW_DAYS * 86_400_000) as Array<{
    handoff_id: string | null
    choice: AttentionChoice
    waited_ms: number | null
  }>
  const waits = (list: typeof rows) =>
    list.map((r) => r.waited_ms).filter((w): w is number => w != null)
  const crew = rows.filter((r) => r.handoff_id != null)
  const byChoice: Partial<Record<AttentionChoice, number>> = {}
  for (const r of rows) byChoice[r.choice] = (byChoice[r.choice] ?? 0) + 1
  return {
    windowDays: STATS_WINDOW_DAYS,
    count: rows.length,
    crewCount: crew.length,
    medianWaitMs: median(waits(rows)),
    crewMedianWaitMs: median(waits(crew)),
    byChoice,
  }
}
