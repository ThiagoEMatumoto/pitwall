import type Database from 'better-sqlite3'
import { getDb } from './db'
import * as featureStore from './feature-store'
import { loopSnapshot } from './loop-snapshot'
import { wakeHealth } from './handoff/handoff-wake'
import {
  ROOM_TIMELINE_LIMIT,
  type RoomObjectiveLink,
  type RoomSnapshot,
  type RoomTimelineEvent,
} from '../../../shared/types/feature-room'

// O que a Room precisa e só o main sabe. Lanes, nós, handoffs e a fila já chegam
// ao renderer pelas fontes do mapa e do Ctrl+` — não são remontados aqui.

interface EventRow {
  id: string
  handoff_id: string
  event: string
  from_status: string | null
  to_status: string
  detail: string | null
  at: number
  child_session_id: string | null
  mother_session_id: string | null
  task: string
}

const toEvent = (r: EventRow): RoomTimelineEvent => ({
  id: r.id,
  handoffId: r.handoff_id,
  event: r.event,
  fromStatus: r.from_status,
  toStatus: r.to_status,
  detail: r.detail,
  at: r.at,
  childSessionId: r.child_session_id,
  motherSessionId: r.mother_session_id,
  task: r.task,
})

export function listFeatureEvents(
  db: Database.Database,
  featureId: string,
  limit = ROOM_TIMELINE_LIMIT,
): RoomTimelineEvent[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.handoff_id, e.event, e.from_status, e.to_status, e.detail, e.at,
              h.child_session_id, h.mother_session_id, h.task
         FROM handoff_events e JOIN handoffs h ON h.id = e.handoff_id
        WHERE h.feature_id = ?
        ORDER BY e.at DESC, e.rowid DESC LIMIT ?`,
    )
    .all(featureId, limit) as EventRow[]
  return rows.map(toEvent)
}

// Mesmo JOIN de linkedObjectiveTitles (feature-store). Sem importar objective-store:
// import circular.
export function objectiveChainOf(db: Database.Database, featureId: string): RoomObjectiveLink[] {
  return db
    .prepare(
      `SELECT o.id AS objectiveId, o.title AS objectiveTitle, NULL AS krId, NULL AS krTitle
         FROM feature_links l JOIN objectives o ON o.id = l.target_id
        WHERE l.feature_id = ? AND l.target_type = 'objective'
       UNION ALL
       SELECT o.id, o.title, kr.id, kr.title
         FROM feature_links l JOIN key_results kr ON kr.id = l.target_id
         JOIN objectives o ON o.id = kr.objective_id
        WHERE l.feature_id = ? AND l.target_type = 'key_result'
        ORDER BY objectiveTitle, krTitle`,
    )
    .all(featureId, featureId) as RoomObjectiveLink[]
}

export function roomSnapshot(featureId: string, now = Date.now()): RoomSnapshot | null {
  const feature = featureStore.get(featureId)
  // FeatureStatus não tem 'archived': o arquivamento é archived_at.
  if (!feature || feature.archivedAt != null) return null
  const db = getDb()
  let loop: ReturnType<typeof loopSnapshot>
  try {
    loop = loopSnapshot(featureId, now)
  } catch {
    return null // feature apagada entre o get e o snapshot
  }
  return {
    featureId,
    feature,
    objectiveChain: objectiveChainOf(db, featureId),
    timeline: listFeatureEvents(db, featureId),
    loop: { pulse: loop.pulse, liveness: loop.liveness, issues: loop.issues },
    wakeHealth: wakeHealth({ featureId }, now),
  }
}
