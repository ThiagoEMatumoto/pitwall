import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import {
  LEDGER_ENTRY_ID_PATTERN,
  PULSE_MAX_LENGTH,
  type PulseSource,
} from '../../../shared/feature-loop'
import type {
  AppendLedgerInput,
  DeclareMetricInput,
  FeatureLedgerEntry,
  FeatureMetricColumn,
  FeatureMetricPoint,
  FeaturePulse,
  ListLedgerOpts,
  ProgressDirection,
} from '../../../shared/types/ipc'

// Store do loop da feature (migration 042): leitura e escrita das três tabelas
// (pulsos, ledger, métricas). Só I/O — nenhuma DERIVAÇÃO mora aqui; a projeção
// que junta tudo e chama shared/feature-loop.ts está em ./loop-snapshot.
//
// Nenhuma operação aqui deleta linha: pulso é append-only e ledger "apaga" com
// archived_at (norma do projeto — ver cabeçalho de services/mcp/tools.ts).

// ---- rows <-> entidades ----

interface PulseRow {
  id: string
  feature_id: string
  body: string
  source: string
  session_id: string | null
  created_at: number
}

interface LedgerRow {
  feature_id: string
  entry_id: string
  kind: string | null
  title: string
  body: string | null
  created_at: number
  updated_at: number
  archived_at: number | null
}

interface MetricRow {
  feature_id: string
  column_key: string
  label: string | null
  unit: string | null
  target: number | null
  floor: number | null
  baseline: number | null
  direction: string | null
  is_headline: number
  alarm: number
}

interface MetricPointRow {
  id: string
  feature_id: string
  column_key: string
  at: number
  value: number | null
  note: string | null
}

function rowToPulse(row: PulseRow): FeaturePulse {
  return {
    id: row.id,
    featureId: row.feature_id,
    body: row.body,
    source: row.source as PulseSource,
    sessionId: row.session_id,
    createdAt: row.created_at,
  }
}

function rowToLedgerEntry(row: LedgerRow): FeatureLedgerEntry {
  return {
    featureId: row.feature_id,
    entryId: row.entry_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function rowToMetricColumn(row: MetricRow): FeatureMetricColumn {
  return {
    featureId: row.feature_id,
    columnKey: row.column_key,
    label: row.label,
    unit: row.unit,
    target: row.target,
    floor: row.floor,
    baseline: row.baseline,
    direction: row.direction as ProgressDirection | null,
    isHeadline: row.is_headline === 1,
    alarm: row.alarm === 1,
  }
}

function rowToMetricPoint(row: MetricPointRow): FeatureMetricPoint {
  return {
    id: row.id,
    featureId: row.feature_id,
    columnKey: row.column_key,
    at: row.at,
    value: row.value,
    note: row.note,
  }
}

// ---- Pulso ----

/**
 * Grava um pulso NOVO — nunca faz UPDATE. A tabela é append-only e o vigente é
 * derivado por MAX(created_at): reescrever o pulso apagaria o histórico de
 * "como ia a frente" em cada momento, que é justamente o que se quer guardar.
 */
export function setPulse(
  featureId: string,
  body: string,
  source: PulseSource,
  sessionId?: string | null,
): FeaturePulse {
  const trimmed = body.trim()
  if (trimmed === '') throw new Error('pulse body is empty')
  if (trimmed.length > PULSE_MAX_LENGTH) {
    throw new Error(
      `pulse body has ${trimmed.length} characters (max ${PULSE_MAX_LENGTH}): it is one sentence, not a report`,
    )
  }
  const pulse: FeaturePulse = {
    id: randomUUID(),
    featureId,
    body: trimmed,
    source,
    sessionId: sessionId ?? null,
    createdAt: Date.now(),
  }
  getDb()
    .prepare(
      `INSERT INTO feature_pulses (id, feature_id, body, source, session_id, created_at)
       VALUES (@id, @feature_id, @body, @source, @session_id, @created_at)`,
    )
    .run({
      id: pulse.id,
      feature_id: pulse.featureId,
      body: pulse.body,
      source: pulse.source,
      session_id: pulse.sessionId,
      created_at: pulse.createdAt,
    })
  return pulse
}

// Desempate por rowid: dois pulsos gravados no MESMO milissegundo (seed, import
// em lote) empatam em created_at, e sem o desempate o "vigente" seria o que o
// SQLite escolhesse. rowid cresce com a ordem de inserção — o último a entrar
// vence, que é a semântica de append-only.
const PULSE_ORDER = 'ORDER BY created_at DESC, rowid DESC'

export function currentPulse(featureId: string): FeaturePulse | null {
  const row = getDb()
    .prepare(`SELECT * FROM feature_pulses WHERE feature_id = ? ${PULSE_ORDER} LIMIT 1`)
    .get(featureId) as PulseRow | undefined
  return row ? rowToPulse(row) : null
}

export function pulseHistory(featureId: string, limit = 50): FeaturePulse[] {
  const rows = getDb()
    .prepare(`SELECT * FROM feature_pulses WHERE feature_id = ? ${PULSE_ORDER} LIMIT ?`)
    .all(featureId, limit) as PulseRow[]
  return rows.map(rowToPulse)
}

// ---- Ledger ----

/**
 * Upsert por (feature_id, entry_id) — o entry_id é o id estável escolhido por
 * quem escreve, então regravá-lo ATUALIZA a entrada em vez de duplicar.
 *
 * Semântica "as-of": o input é o estado completo da entrada agora, não um
 * patch. Corpo vazio/ausente arquiva (archived_at), corpo de volta desarquiva —
 * nunca DELETE, o histórico da linha permanece.
 */
export function appendLedger(featureId: string, entry: AppendLedgerInput): FeatureLedgerEntry {
  const entryId = entry.entryId.trim()
  if (!LEDGER_ENTRY_ID_PATTERN.test(entryId)) {
    throw new Error(
      `invalid ledger entry_id ${JSON.stringify(entry.entryId)}: expected ${LEDGER_ENTRY_ID_PATTERN.source}`,
    )
  }
  const now = Date.now()
  const body = (entry.body ?? '').trim()
  const next: FeatureLedgerEntry = {
    featureId,
    entryId,
    kind: entry.kind?.trim() ? entry.kind.trim() : null,
    // title é NOT NULL; sem título o próprio entry_id serve de rótulo (estável
    // e nunca vazio) em vez de rejeitar a escrita.
    title: entry.title?.trim() ? entry.title.trim() : entryId,
    body: body === '' ? null : body,
    createdAt: now,
    updatedAt: now,
    archivedAt: body === '' ? now : null,
  }
  getDb()
    .prepare(
      `INSERT INTO feature_ledger
         (feature_id, entry_id, kind, title, body, created_at, updated_at, archived_at)
       VALUES (@feature_id, @entry_id, @kind, @title, @body, @created_at, @updated_at, @archived_at)
       ON CONFLICT(feature_id, entry_id) DO UPDATE SET
         kind = excluded.kind,
         title = excluded.title,
         body = excluded.body,
         updated_at = excluded.updated_at,
         archived_at = excluded.archived_at`,
    )
    .run({
      feature_id: next.featureId,
      entry_id: next.entryId,
      kind: next.kind,
      title: next.title,
      body: next.body,
      created_at: next.createdAt,
      updated_at: next.updatedAt,
      archived_at: next.archivedAt,
    })
  // created_at do INSERT original é preservado pelo DO UPDATE, então o retorno
  // vem do banco, não do objeto montado acima.
  const row = getDb()
    .prepare('SELECT * FROM feature_ledger WHERE feature_id = ? AND entry_id = ?')
    .get(featureId, entryId) as LedgerRow
  return rowToLedgerEntry(row)
}

export function listLedger(featureId: string, opts?: ListLedgerOpts): FeatureLedgerEntry[] {
  const clause = opts?.includeArchived ? '' : 'AND archived_at IS NULL'
  const rows = getDb()
    .prepare(
      `SELECT * FROM feature_ledger
        WHERE feature_id = ? ${clause}
        ORDER BY created_at DESC, entry_id ASC
        LIMIT ?`,
    )
    .all(featureId, opts?.limit ?? 200) as LedgerRow[]
  return rows.map(rowToLedgerEntry)
}

// ---- Métricas ----

export function declareMetric(featureId: string, cfg: DeclareMetricInput): FeatureMetricColumn {
  const columnKey = cfg.columnKey.trim()
  if (columnKey === '') throw new Error('metric column_key is empty')
  const column: FeatureMetricColumn = {
    featureId,
    columnKey,
    label: cfg.label?.trim() ? cfg.label.trim() : null,
    unit: cfg.unit?.trim() ? cfg.unit.trim() : null,
    target: cfg.target ?? null,
    floor: cfg.floor ?? null,
    baseline: cfg.baseline ?? null,
    direction: cfg.direction ?? null,
    isHeadline: cfg.isHeadline ?? false,
    alarm: cfg.alarm ?? false,
  }
  getDb()
    .prepare(
      `INSERT INTO feature_metrics
         (feature_id, column_key, label, unit, target, floor, baseline, direction, is_headline, alarm)
       VALUES (@feature_id, @column_key, @label, @unit, @target, @floor, @baseline, @direction,
               @is_headline, @alarm)
       ON CONFLICT(feature_id, column_key) DO UPDATE SET
         label = excluded.label,
         unit = excluded.unit,
         target = excluded.target,
         floor = excluded.floor,
         baseline = excluded.baseline,
         direction = excluded.direction,
         is_headline = excluded.is_headline,
         alarm = excluded.alarm`,
    )
    .run({
      feature_id: column.featureId,
      column_key: column.columnKey,
      label: column.label,
      unit: column.unit,
      target: column.target,
      floor: column.floor,
      baseline: column.baseline,
      direction: column.direction,
      is_headline: column.isHeadline ? 1 : 0,
      alarm: column.alarm ? 1 : 0,
    })
  return column
}

function isForeignKeyViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || code === 'SQLITE_CONSTRAINT_TRIGGER'
}

/**
 * Upsert por (feature_id, column_key, at) — remedir o mesmo instante corrige o
 * valor em vez de criar um segundo ponto.
 *
 * A FK composta pra feature_metrics é o que impede série órfã; ela dispara um
 * "FOREIGN KEY constraint failed" cru que não diz NADA sobre o que faltou, daí
 * a tradução aqui: quem chamou esqueceu de declarar a coluna.
 */
export function recordMetricPoint(
  featureId: string,
  columnKey: string,
  at: number,
  value: number | null,
  note?: string | null,
): FeatureMetricPoint {
  const point: FeatureMetricPoint = {
    id: randomUUID(),
    featureId,
    columnKey,
    at,
    value,
    note: note?.trim() ? note.trim() : null,
  }
  try {
    getDb()
      .prepare(
        `INSERT INTO feature_metric_points (id, feature_id, column_key, at, value, note)
         VALUES (@id, @feature_id, @column_key, @at, @value, @note)
         ON CONFLICT(feature_id, column_key, at) DO UPDATE SET
           value = excluded.value,
           note = excluded.note`,
      )
      .run({
        id: point.id,
        feature_id: point.featureId,
        column_key: point.columnKey,
        at: point.at,
        value: point.value,
        note: point.note,
      })
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new Error(
        `metric column "${columnKey}" is not declared for feature ${featureId}: call declareMetric first`,
      )
    }
    throw err
  }
  const row = getDb()
    .prepare(
      'SELECT * FROM feature_metric_points WHERE feature_id = ? AND column_key = ? AND at = ?',
    )
    .get(featureId, columnKey, at) as MetricPointRow
  return rowToMetricPoint(row)
}

export function listMetrics(featureId: string): FeatureMetricColumn[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM feature_metrics WHERE feature_id = ?
        ORDER BY is_headline DESC, column_key ASC`,
    )
    .all(featureId) as MetricRow[]
  return rows.map(rowToMetricColumn)
}

export function listMetricPoints(featureId: string): FeatureMetricPoint[] {
  const rows = getDb()
    .prepare('SELECT * FROM feature_metric_points WHERE feature_id = ? ORDER BY at ASC')
    .all(featureId) as MetricPointRow[]
  return rows.map(rowToMetricPoint)
}
