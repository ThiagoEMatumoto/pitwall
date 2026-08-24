import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { ServiceAuditEntry } from '../../../shared/types/ipc'

// Store de service_proxy_calls (migration 039) — auditoria do proxy de
// serviços. Uma linha por chamada, imutável. Quem grava é o engine
// (service-proxy) já com o erro REDIGIDO; este módulo não vê credencial nem
// corpo de resposta, só metadados.

export interface RecordServiceCallInput {
  sessionId: string | null
  service: string
  operation: string
  status: 'ok' | 'error'
  durationMs: number
  error?: string | null
}

export interface ListServiceCallsFilter {
  service?: string
  limit?: number
}

interface ServiceCallRow {
  id: string
  ts: number
  session_id: string | null
  service: string
  operation: string
  status: string
  duration_ms: number
  error: string | null
}

function rowToEntry(row: ServiceCallRow): ServiceAuditEntry {
  return {
    id: row.id,
    ts: row.ts,
    sessionId: row.session_id,
    service: row.service,
    operation: row.operation,
    status: row.status as ServiceAuditEntry['status'],
    durationMs: row.duration_ms,
    error: row.error,
  }
}

export function recordServiceCall(input: RecordServiceCallInput): ServiceAuditEntry {
  const entry: ServiceAuditEntry = {
    id: randomUUID(),
    ts: Date.now(),
    sessionId: input.sessionId,
    service: input.service,
    operation: input.operation,
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    error: input.error ?? null,
  }
  getDb()
    .prepare(
      `INSERT INTO service_proxy_calls (id, ts, session_id, service, operation, status, duration_ms, error)
       VALUES (@id, @ts, @session_id, @service, @operation, @status, @duration_ms, @error)`,
    )
    .run({
      id: entry.id,
      ts: entry.ts,
      session_id: entry.sessionId,
      service: entry.service,
      operation: entry.operation,
      status: entry.status,
      duration_ms: entry.durationMs,
      error: entry.error,
    })
  return entry
}

export function listServiceCalls(filter: ListServiceCallsFilter = {}): ServiceAuditEntry[] {
  const limit = filter.limit && filter.limit > 0 ? Math.floor(filter.limit) : 50
  const rows = filter.service
    ? (getDb()
        .prepare(`SELECT * FROM service_proxy_calls WHERE service = ? ORDER BY ts DESC, id LIMIT ?`)
        .all(filter.service, limit) as ServiceCallRow[])
    : (getDb()
        .prepare(`SELECT * FROM service_proxy_calls ORDER BY ts DESC, id LIMIT ?`)
        .all(limit) as ServiceCallRow[])
  return rows.map(rowToEntry)
}

export function lastServiceCall(service: string): ServiceAuditEntry | null {
  return listServiceCalls({ service, limit: 1 })[0] ?? null
}
