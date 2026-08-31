import { STALLED_THRESHOLD_DAYS } from './feature-visibility'
import type { FeatureStatus, ProgressDirection } from './types/ipc'

// Loop da feature: pulso (o que está vivo agora), ledger (o que já mudou) e
// métricas (o que a mudança moveu). Módulo PURO — sem Electron, sem I/O, sem
// banco (precedente: shared/progress.ts). Importável por main e renderer.
//
// A inversão que sustenta o módulo: a vitalidade (`liveness`) de uma frente é
// DERIVADA, nunca declarada nem persistida. Uma feature está "quiet" porque
// ninguém a tocou há N dias — não porque alguém digitou isso. O mesmo vale pros
// issues: são recomputados a cada leitura, não gravados.
//
// Nomes: aqui em camelCase (convenção de shared/types/ipc.ts); as colunas
// equivalentes no SQLite/bundle são snake_case (column_key, entry_id,
// is_headline) — ver shared/schemas/feature-loop.schema.json.

const DAY_MS = 24 * 60 * 60 * 1000

/** Pulso vigente > 200 caracteres é erro: pulso é uma frase, não um relatório. */
export const PULSE_MAX_LENGTH = 200

/** Objetivo acima disso vira parágrafo — cabe no ledger, não no campo objetivo. */
export const OBJECTIVE_MAX_LENGTH = 400

/** Id textual estável de entrada do ledger (validado aqui; o CHECK do SQLite só limita comprimento). */
export const LEDGER_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Faixa de tolerância ao redor do target considerada "no alvo". */
export const METRIC_TARGET_TOLERANCE = 0.15

// ---- Vitalidade ----

export type Liveness = 'alive' | 'quiet' | 'broken' | 'paused' | 'done'

export type IssueLevel = 'error' | 'warn' | 'info'

export interface LoopIssue {
  level: IssueLevel
  /** Chave estável — a UI indexa por ela (nunca traduzir/renomear sem migrar a UI). */
  code: string
  message: string
}

// ---- Entradas ----

export type PulseSource = 'human' | 'session' | 'mcp' | 'seed'

export interface LoopPulse {
  body: string
  source?: PulseSource
  createdAt?: number
}

export interface LoopLedgerEntry {
  entryId: string
  title?: string
  createdAt?: number
}

export interface LoopMetricColumn {
  columnKey: string
  label?: string | null
  unit?: string | null
  target?: number | null
  floor?: number | null
  baseline?: number | null
  direction?: ProgressDirection | null
  isHeadline?: boolean
  alarm?: boolean
}

export interface LoopMetricPoint {
  columnKey: string
  at: number
  value?: number | null
}

// Timestamps de onde a atividade real pode vir. Só `updatedAt` é obrigatório
// (toda feature tem); os demais são opcionais porque a projeção que monta o
// input pode não ter carregado a tabela correspondente — ausente NÃO conta.
export interface LoopActivityInput {
  updatedAt: number
  /** session_at do feature_session_record mais recente. */
  lastRecordAt?: number | null
  /** created_at do pulso vigente. */
  lastPulseAt?: number | null
  /** updated_at da entrada de ledger mais recente. */
  lastLedgerAt?: number | null
  /** `at` do ponto de métrica mais recente. */
  lastMetricPointAt?: number | null
  /** mtime do `.md` da feature — o doc é editável fora do app. */
  docMtime?: number | null
}

/**
 * Candidato a duplicata desta feature, registrado no auto-registro quando a
 * semelhança ficou na faixa do meio (ver feature-heuristics.decideRegistration).
 * `title` e `score` são opcionais porque quem monta o input pode ter só o
 * ponteiro — a mensagem degrada pro id em vez de sumir.
 */
export interface LoopDuplicateSuspect {
  featureId: string
  title?: string | null
  /** Afinidade 0..1 que gerou a suspeita. */
  score?: number | null
}

export interface LoopInput extends LoopActivityInput {
  status: FeatureStatus
  completedAt?: number | null
  /**
   * Quando a feature foi pausada (null/undefined = não pausada). Escolhido
   * timestamp em vez de boolean porque a UI mostra "pausada há Nd" e um bool
   * não responde "desde quando". `status: 'paused'` também conta como pausa —
   * é o que a UI atual já grava, e ignorá-lo marcaria como viva uma feature
   * explicitamente pausada.
   */
  pausedAt?: number | null
  /** Cadência esperada de toque, em dias. Ausente/null = STALLED_THRESHOLD_DAYS. */
  cadenceDays?: number | null
  objective?: string | null
  /** Pulso vigente (MAX(created_at)); null/undefined = nenhum. */
  pulse?: LoopPulse | null
  ledger?: readonly LoopLedgerEntry[]
  metrics?: readonly LoopMetricColumn[]
  metricPoints?: readonly LoopMetricPoint[]
  /** Repos vinculados — shape mínimo, `FeatureRepoLink[]` satisfaz. */
  repos?: readonly { repoId: string }[]
  /**
   * Suspeita de duplicata PERSISTIDA (features.duplicate_of). Entra como dado,
   * igual ao resto: o que se guarda é o candidato, a issue segue derivada aqui.
   */
  duplicateSuspect?: LoopDuplicateSuspect | null
}

// ---- Atividade ----

// O maior timestamp disponível. Campos ausentes/null não participam do máximo
// (um `null` viraria 0 e não muda o resultado, mas filtrar deixa a intenção
// explícita). `updatedAt` garante que sempre há pelo menos um candidato.
export function lastActivityAt(input: LoopActivityInput): number {
  const candidates = [
    input.updatedAt,
    input.lastRecordAt,
    input.lastPulseAt,
    input.lastLedgerAt,
    input.lastMetricPointAt,
    input.docMtime,
  ].filter((t): t is number => typeof t === 'number')
  return Math.max(...candidates)
}

// Cadência efetiva em ms. Valor não-positivo não tem significado (tornaria toda
// feature "quiet" no instante seguinte ao toque) — cai no default.
function cadenceMs(cadenceDays: number | null | undefined): number {
  const days = typeof cadenceDays === 'number' && cadenceDays > 0 ? cadenceDays : STALLED_THRESHOLD_DAYS
  return days * DAY_MS
}

function isPaused(input: LoopInput): boolean {
  return input.status === 'paused' || (input.pausedAt ?? null) !== null
}

// Conclusão declarada: o status 'done' OU um completedAt carimbado (o carimbo
// pode chegar antes do status numa sincronização parcial).
function isDone(input: LoopInput): boolean {
  return input.status === 'done' || (input.completedAt ?? null) !== null
}

// Precedência EXATA (a primeira que casar vence): paused > broken > done >
// quiet > alive. Pausa vem antes de tudo porque silêncio combinado é esperado;
// broken vem antes de done pra uma feature concluída com dado inconsistente não
// se esconder atrás do "done".
export function livenessOf(input: LoopInput, now: number = Date.now()): Liveness {
  if (isPaused(input)) return 'paused'
  if (issuesOf(input).some((i) => i.level === 'error')) return 'broken'
  if (isDone(input)) return 'done'
  if (now - lastActivityAt(input) >= cadenceMs(input.cadenceDays)) return 'quiet'
  return 'alive'
}

// ---- Issues ----

function isBlank(text: string | null | undefined): boolean {
  return (text ?? '').trim() === ''
}

// Issues do loop, em ordem estável de nível (error → warn → info). Cada `code`
// aparece no máximo UMA vez: violações repetidas (vários entry_id inválidos,
// vários pontos órfãos) são agregadas numa issue só, porque a UI usa o code
// como chave de lista.
export function issuesOf(input: LoopInput): LoopIssue[] {
  const issues: LoopIssue[] = []
  const pulseBody = input.pulse?.body
  const hasPulse = pulseBody !== undefined && !isBlank(pulseBody)

  if (hasPulse && pulseBody.length > PULSE_MAX_LENGTH) {
    issues.push({
      level: 'error',
      code: 'pulse_too_long',
      message: `Pulso com ${pulseBody.length} caracteres (máximo ${PULSE_MAX_LENGTH}).`,
    })
  }

  const badIds = (input.ledger ?? [])
    .map((e) => e.entryId)
    .filter((id) => !LEDGER_ENTRY_ID_PATTERN.test(id))
  if (badIds.length > 0) {
    issues.push({
      level: 'error',
      code: 'ledger_id_invalid',
      message: `${badIds.length} entrada(s) de ledger com id inválido: ${badIds.slice(0, 3).join(', ')}.`,
    })
  }

  const declared = new Set((input.metrics ?? []).map((m) => m.columnKey))
  const orphans = (input.metricPoints ?? [])
    .map((p) => p.columnKey)
    .filter((key) => !declared.has(key))
  if (orphans.length > 0) {
    const unique = [...new Set(orphans)]
    issues.push({
      level: 'error',
      code: 'metric_point_orphan',
      message: `${orphans.length} ponto(s) de métrica sem coluna declarada: ${unique.slice(0, 3).join(', ')}.`,
    })
  }

  if (!hasPulse) {
    issues.push({ level: 'warn', code: 'pulse_missing', message: 'Sem pulso: não dá pra saber o que está vivo agora.' })
  }

  const objective = input.objective
  if (isBlank(objective)) {
    issues.push({ level: 'warn', code: 'objective_missing', message: 'Objetivo vazio.' })
  } else if ((objective as string).length > OBJECTIVE_MAX_LENGTH) {
    issues.push({
      level: 'warn',
      code: 'objective_too_long',
      message: `Objetivo com ${(objective as string).length} caracteres (máximo ${OBJECTIVE_MAX_LENGTH}).`,
    })
  }

  // A suspeita não é erro: o rascunho foi criado de propósito (não se perde
  // trabalho por palpite) e o veredito é humano — mesclar ou dispensar.
  const suspect = input.duplicateSuspect
  if (suspect) {
    const label = (suspect.title ?? '').trim() || suspect.featureId
    const affinity =
      typeof suspect.score === 'number' ? ` (afinidade ${Math.round(suspect.score * 100)}%)` : ''
    issues.push({
      level: 'warn',
      code: 'duplicate_suspect',
      message: `Possível duplicata de «${label}»${affinity}.`,
    })
  }

  // Lista ausente é tratada como vazia: a projeção que monta o LoopInput sempre
  // carrega os repos, e um info-level "sem repo" é um empurrão, não um veredito.
  if ((input.repos ?? []).length === 0) {
    issues.push({ level: 'info', code: 'no_repo_linked', message: 'Nenhum repo vinculado à feature.' })
  }

  return issues
}

// ---- Tom de métrica ----

export type MetricTone = 'fail' | 'ok' | 'neutral'

export interface MetricConfig {
  target?: number | null
  floor?: number | null
  /** Coluna em que passar do target é ruim (custo, latência, erro). */
  alarm?: boolean
}

// Tom de um valor medido contra a coluna. Ordem: piso furado → alarme
// estourado → dentro de 15% do target → neutro.
//
// Bordas (decididas aqui, não no chamador):
//  - `floor`/`target` ausentes desligam a regra correspondente; sem nenhum dos
//    dois o tom é sempre 'neutral' (não há contra o que comparar).
//  - `target === 0`: a tolerância é calculada por MULTIPLICAÇÃO
//    (|value − target| ≤ 15% · |target|), nunca por divisão — com target 0 a
//    faixa colapsa em zero e só o valor exatamente 0 é 'ok'. É o único
//    significado defensável de "15% de zero", e não produz NaN/Infinity.
export function metricTone(value: number, cfg: MetricConfig): MetricTone {
  const floor = cfg.floor ?? null
  const target = cfg.target ?? null
  if (floor !== null && value < floor) return 'fail'
  if (cfg.alarm === true && target !== null && value > target) return 'fail'
  if (target !== null && Math.abs(value - target) <= METRIC_TARGET_TOLERANCE * Math.abs(target)) return 'ok'
  return 'neutral'
}
