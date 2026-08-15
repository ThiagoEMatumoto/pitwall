import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type {
  AllowedFact,
  ContentAudience,
  ContentContract,
  ContentContractListFilter,
  ContentContractStatus,
  ContentContractVersion,
  ContentGateFinding,
  ContentGateKind,
  ContentGateRun,
  ContentGateRunListFilter,
  ContentGateStatus,
  CreateContentContractInput,
  CreateContentGateRunInput,
  DeliveryLimit,
  EthicalRule,
  ForbiddenFact,
  OutOfScopeItem,
  ProductionInvariant,
  SourcePrecedenceEntry,
  ToneSpec,
  UpdateContentContractInput,
} from '../../../shared/types/ipc'

// Store do Content Contract (Fase 1). Molde de scheduled-job-store: funções
// soltas, rows snake_case ⇄ entidades camelCase, `db.transaction` nas mutações
// compostas, JSON.parse sempre defensivo.
//
// O ponto do módulo é `update()`: não é UPDATE, é BUMP. O diff campo a campo
// decide se houve mudança real; diff vazio devolve a cabeça intocada (chamar
// duas vezes com o mesmo payload não polui o changelog), diff não-vazio muta a
// cabeça E grava o snapshot íntegro da versão nova. Quem lê o histórico lê
// `listVersions()` — não existe coluna `changelog`.

// Teto do JSON de findings. O `details` do tone-lint (violações + métricas +
// margens) é kilobytes por run; sem teto uma row de evidência engorda o banco
// sem limite. Cortar a cauda e marcar `truncated` preserva o começo, que é onde
// estão as primeiras violações — as que interessam pra corrigir.
const MAX_FINDINGS_BYTES = 64 * 1024

// ---- rows <-> entidades ----

interface ContentContractRow {
  id: string
  slug: string
  title: string
  status: string
  version: number
  output_label: string
  audience: string
  ethical_line: string
  allowed_facts: string
  forbidden_facts: string
  out_of_scope: string
  tone: string
  delivery_limits: string
  source_precedence: string
  production_invariants: string
  created_at: number
  updated_at: number
}

interface ContentContractVersionRow {
  id: string
  contract_id: string
  version: number
  summary: string
  reason: string
  changed_fields: string
  snapshot_json: string
  created_at: number
}

interface ContentGateRunRow {
  id: string
  contract_id: string
  contract_version: number
  gate: string
  status: string
  material_ref: string | null
  material_hash: string | null
  findings: string
  evidence: string | null
  blocking_count: number
  warning_count: number
  created_at: number
}

// Envelope do findings: o flag `truncated` precisa viajar junto com a lista,
// senão quem lê a evidência não sabe se está vendo tudo.
interface FindingsEnvelope {
  findings: ContentGateFinding[]
  truncated: boolean
  droppedCount?: number
}

const DEFAULT_AUDIENCE: ContentAudience = {
  who: '',
  notWho: [],
  situation: null,
  assumptions: [],
}

// Tone vazio ≠ tone permissivo: o gate trata regra ausente como skip explícito,
// nunca como "roda". Aqui só garantimos que a leitura não quebra.
const DEFAULT_TONE: ToneSpec = { hard_rules: [], anti_tone_words: [] }

// JSON gravado por nós, mas ainda assim defendido: uma row corrompida por edição
// manual no sqlite não pode derrubar o list() inteiro.
function parseObject<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
  } catch {
    // cai no fallback
  }
  return fallback
}

function parseArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function rowToContract(row: ContentContractRow): ContentContract {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status as ContentContractStatus,
    version: row.version,
    outputLabel: row.output_label,
    audience: parseObject<ContentAudience>(row.audience, DEFAULT_AUDIENCE),
    ethicalLine: parseArray<EthicalRule>(row.ethical_line),
    allowedFacts: parseArray<AllowedFact>(row.allowed_facts),
    forbiddenFacts: parseArray<ForbiddenFact>(row.forbidden_facts),
    outOfScope: parseArray<OutOfScopeItem>(row.out_of_scope),
    tone: parseObject<ToneSpec>(row.tone, DEFAULT_TONE),
    deliveryLimits: parseArray<DeliveryLimit>(row.delivery_limits),
    sourcePrecedence: parseArray<SourcePrecedenceEntry>(row.source_precedence),
    productionInvariants: parseArray<ProductionInvariant>(row.production_invariants),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function contractToRowParams(c: ContentContract): Record<string, unknown> {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    status: c.status,
    version: c.version,
    output_label: c.outputLabel,
    audience: JSON.stringify(c.audience),
    ethical_line: JSON.stringify(c.ethicalLine),
    allowed_facts: JSON.stringify(c.allowedFacts),
    forbidden_facts: JSON.stringify(c.forbiddenFacts),
    out_of_scope: JSON.stringify(c.outOfScope),
    tone: JSON.stringify(c.tone),
    delivery_limits: JSON.stringify(c.deliveryLimits),
    source_precedence: JSON.stringify(c.sourcePrecedence),
    production_invariants: JSON.stringify(c.productionInvariants),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  }
}

function rowToVersion(row: ContentContractVersionRow): ContentContractVersion {
  let snapshot: ContentContract | null = null
  try {
    const parsed: unknown = JSON.parse(row.snapshot_json)
    if (parsed && typeof parsed === 'object') snapshot = parsed as ContentContract
  } catch {
    // snapshot ilegível não invalida a linha de changelog (summary/reason).
  }
  return {
    id: row.id,
    contractId: row.contract_id,
    version: row.version,
    summary: row.summary,
    reason: row.reason,
    changedFields: parseArray<string>(row.changed_fields),
    snapshot,
    createdAt: row.created_at,
  }
}

function rowToGateRun(row: ContentGateRunRow): ContentGateRun {
  const envelope = parseObject<FindingsEnvelope>(row.findings, { findings: [], truncated: false })
  return {
    id: row.id,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    gate: row.gate as ContentGateKind,
    status: row.status as ContentGateStatus,
    materialRef: row.material_ref,
    materialHash: row.material_hash,
    findings: Array.isArray(envelope.findings) ? envelope.findings : [],
    findingsTruncated: envelope.truncated === true,
    evidence: row.evidence,
    blockingCount: row.blocking_count,
    warningCount: row.warning_count,
    createdAt: row.created_at,
  }
}

// undefined = mantém o valor atual.
function keep<T>(next: T | undefined, current: T): T {
  return next === undefined ? current : next
}

// ---- diff: o que decide se a versão sobe ----

// Ordem de chave não é diferença de conteúdo. Um upsert vindo do MCP monta o
// JSON na ordem que quiser; com JSON.stringify cru isso bumparia a versão sem
// nenhuma mudança real, que é exatamente o que a invariante 2 proíbe.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

// Campos que compõem o contrato. version/createdAt/updatedAt ficam de fora: são
// consequência do bump, não causa dele.
const VERSIONED_FIELDS = [
  'slug',
  'title',
  'status',
  'outputLabel',
  'audience',
  'ethicalLine',
  'allowedFacts',
  'forbiddenFacts',
  'outOfScope',
  'tone',
  'deliveryLimits',
  'sourcePrecedence',
  'productionInvariants',
] as const satisfies ReadonlyArray<keyof ContentContract>

export function diffFields(current: ContentContract, next: ContentContract): string[] {
  return VERSIONED_FIELDS.filter(
    (field) => stableStringify(current[field]) !== stableStringify(next[field]),
  )
}

// ---- API pública: content_contracts ----

export function list(filter?: ContentContractListFilter): ContentContract[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filter?.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter?.search?.trim()) {
    where.push('(slug LIKE ? OR title LIKE ?)')
    const like = `%${filter.search.trim()}%`
    params.push(like, like)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = getDb()
    .prepare(`SELECT * FROM content_contracts ${clause} ORDER BY updated_at DESC, slug ASC`)
    .all(...params) as ContentContractRow[]
  return rows.map(rowToContract)
}

export function get(id: string): ContentContract | null {
  const row = getDb().prepare('SELECT * FROM content_contracts WHERE id = ?').get(id) as
    | ContentContractRow
    | undefined
  return row ? rowToContract(row) : null
}

export function getBySlug(slug: string): ContentContract | null {
  const row = getDb().prepare('SELECT * FROM content_contracts WHERE slug = ?').get(slug) as
    | ContentContractRow
    | undefined
  return row ? rowToContract(row) : null
}

const INSERT_CONTRACT_SQL = `INSERT INTO content_contracts
    (id, slug, title, status, version, output_label, audience, ethical_line, allowed_facts,
     forbidden_facts, out_of_scope, tone, delivery_limits, source_precedence,
     production_invariants, created_at, updated_at)
   VALUES
    (@id, @slug, @title, @status, @version, @output_label, @audience, @ethical_line, @allowed_facts,
     @forbidden_facts, @out_of_scope, @tone, @delivery_limits, @source_precedence,
     @production_invariants, @created_at, @updated_at)`

const UPDATE_CONTRACT_SQL = `UPDATE content_contracts SET
     slug = @slug, title = @title, status = @status, version = @version,
     output_label = @output_label, audience = @audience, ethical_line = @ethical_line,
     allowed_facts = @allowed_facts, forbidden_facts = @forbidden_facts,
     out_of_scope = @out_of_scope, tone = @tone, delivery_limits = @delivery_limits,
     source_precedence = @source_precedence, production_invariants = @production_invariants,
     updated_at = @updated_at
   WHERE id = @id`

const INSERT_VERSION_SQL = `INSERT INTO content_contract_versions
    (id, contract_id, version, summary, reason, changed_fields, snapshot_json, created_at)
   VALUES
    (@id, @contract_id, @version, @summary, @reason, @changed_fields, @snapshot_json, @created_at)`

function versionRowParams(
  contract: ContentContract,
  summary: string,
  reason: string,
  changedFields: string[],
  now: number,
): Record<string, unknown> {
  return {
    id: randomUUID(),
    contract_id: contract.id,
    version: contract.version,
    summary,
    reason,
    changed_fields: JSON.stringify(changedFields),
    snapshot_json: JSON.stringify(contract),
    created_at: now,
  }
}

export function create(input: CreateContentContractInput): ContentContract {
  const now = Date.now()
  const contract: ContentContract = {
    id: randomUUID(),
    slug: input.slug.trim(),
    title: input.title.trim(),
    status: input.status ?? 'draft',
    version: 1,
    // Sem trim protetor: o CHECK do banco é quem rejeita rótulo vazio, e é ele
    // que vale pra qualquer caminho de escrita (MCP, IPC, teste).
    outputLabel: input.outputLabel.trim(),
    audience: input.audience ?? DEFAULT_AUDIENCE,
    ethicalLine: input.ethicalLine ?? [],
    allowedFacts: input.allowedFacts ?? [],
    forbiddenFacts: input.forbiddenFacts ?? [],
    outOfScope: input.outOfScope ?? [],
    tone: input.tone ?? DEFAULT_TONE,
    deliveryLimits: input.deliveryLimits ?? [],
    sourcePrecedence: input.sourcePrecedence ?? [],
    productionInvariants: input.productionInvariants ?? [],
    createdAt: now,
    updatedAt: now,
  }

  const db = getDb()
  // Cabeça e snapshot 1 na MESMA transação: contrato sem versão 1 gravada seria
  // um contrato contra o qual nenhum gate pode rodar (FK composta).
  const tx = db.transaction(() => {
    db.prepare(INSERT_CONTRACT_SQL).run(contractToRowParams(contract))
    db.prepare(INSERT_VERSION_SQL).run(
      versionRowParams(
        contract,
        input.summary?.trim() || 'versão inicial',
        input.reason?.trim() || 'criação do contrato',
        [...VERSIONED_FIELDS],
        now,
      ),
    )
  })
  tx()
  return contract
}

export function update(input: UpdateContentContractInput): ContentContract {
  const current = get(input.id)
  if (!current) throw new Error(`content contract not found: ${input.id}`)

  const candidate: ContentContract = {
    ...current,
    slug: keep(input.slug?.trim(), current.slug),
    title: keep(input.title?.trim(), current.title),
    status: keep(input.status, current.status),
    outputLabel: keep(input.outputLabel?.trim(), current.outputLabel),
    audience: keep(input.audience, current.audience),
    ethicalLine: keep(input.ethicalLine, current.ethicalLine),
    allowedFacts: keep(input.allowedFacts, current.allowedFacts),
    forbiddenFacts: keep(input.forbiddenFacts, current.forbiddenFacts),
    outOfScope: keep(input.outOfScope, current.outOfScope),
    tone: keep(input.tone, current.tone),
    deliveryLimits: keep(input.deliveryLimits, current.deliveryLimits),
    sourcePrecedence: keep(input.sourcePrecedence, current.sourcePrecedence),
    productionInvariants: keep(input.productionInvariants, current.productionInvariants),
  }

  const changedFields = diffFields(current, candidate)
  // Idempotente: reenviar o mesmo contrato não é uma emenda. Devolve a cabeça
  // sem tocar em updated_at nem gravar linha de changelog.
  if (changedFields.length === 0) return current

  const summary = input.summary?.trim()
  const reason = input.reason?.trim()
  // Só cobrado quando há diff: bump sem changelog é mutação silenciosa, que é o
  // que esta feature existe pra impedir.
  if (!summary || !reason) {
    throw new Error('bump de contrato exige summary e reason não-vazios')
  }

  const now = Date.now()
  const next: ContentContract = { ...candidate, version: current.version + 1, updatedAt: now }

  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(UPDATE_CONTRACT_SQL).run(contractToRowParams(next))
    db.prepare(INSERT_VERSION_SQL).run(versionRowParams(next, summary, reason, changedFields, now))
  })
  tx()
  return next
}

export function remove(id: string): void {
  // Versões saem por ON DELETE CASCADE e levam os gate runs junto pela FK
  // composta (foreign_keys = ON em db.ts).
  getDb().prepare('DELETE FROM content_contracts WHERE id = ?').run(id)
}

// ---- API pública: content_contract_versions (o changelog) ----

export function listVersions(contractId: string): ContentContractVersion[] {
  const rows = getDb()
    .prepare('SELECT * FROM content_contract_versions WHERE contract_id = ? ORDER BY version DESC')
    .all(contractId) as ContentContractVersionRow[]
  return rows.map(rowToVersion)
}

export function getVersion(contractId: string, version: number): ContentContractVersion | null {
  const row = getDb()
    .prepare('SELECT * FROM content_contract_versions WHERE contract_id = ? AND version = ?')
    .get(contractId, version) as ContentContractVersionRow | undefined
  return row ? rowToVersion(row) : null
}

// ---- API pública: content_gate_runs ----

const INSERT_GATE_RUN_SQL = `INSERT INTO content_gate_runs
    (id, contract_id, contract_version, gate, status, material_ref, material_hash,
     findings, evidence, blocking_count, warning_count, created_at)
   VALUES
    (@id, @contract_id, @contract_version, @gate, @status, @material_ref, @material_hash,
     @findings, @evidence, @blocking_count, @warning_count, @created_at)`

function fits(envelope: FindingsEnvelope): boolean {
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_FINDINGS_BYTES
}

// Maior prefixo de findings que cabe no teto. Busca binária porque um run de
// tone-lint em texto longo pode trazer milhares de achados e cortar de um em um
// seria quadrático na gravação.
function serializeFindings(findings: ContentGateFinding[]): string {
  const whole: FindingsEnvelope = { findings, truncated: false }
  if (fits(whole)) return JSON.stringify(whole)

  let lo = 0
  let hi = findings.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate: FindingsEnvelope = {
      findings: findings.slice(0, mid),
      truncated: true,
      droppedCount: findings.length - mid,
    }
    if (fits(candidate)) lo = mid
    else hi = mid - 1
  }
  return JSON.stringify({
    findings: findings.slice(0, lo),
    truncated: true,
    droppedCount: findings.length - lo,
  } satisfies FindingsEnvelope)
}

// Grava a evidência. Lança se (contract_id, contract_version) não corresponde a
// uma versão snapshotada — a FK composta é deliberada: evidência sem o texto que
// valia no momento não é evidência.
export function createGateRun(input: CreateContentGateRunInput): ContentGateRun {
  const now = Date.now()
  const findings = input.findings ?? []
  const id = randomUUID()
  getDb()
    .prepare(INSERT_GATE_RUN_SQL)
    .run({
      id,
      contract_id: input.contractId,
      contract_version: input.contractVersion,
      gate: input.gate,
      status: input.status,
      material_ref: input.materialRef ?? null,
      material_hash: input.materialHash ?? null,
      findings: serializeFindings(findings),
      evidence: input.evidence ?? null,
      blocking_count: input.blockingCount ?? 0,
      warning_count: input.warningCount ?? 0,
      created_at: now,
    })
  return getGateRun(id)!
}

export function getGateRun(id: string): ContentGateRun | null {
  const row = getDb().prepare('SELECT * FROM content_gate_runs WHERE id = ?').get(id) as
    | ContentGateRunRow
    | undefined
  return row ? rowToGateRun(row) : null
}

export function listGateRuns(filter?: ContentGateRunListFilter): ContentGateRun[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filter?.contractId) {
    where.push('contract_id = ?')
    params.push(filter.contractId)
  }
  if (filter?.contractVersion !== undefined) {
    where.push('contract_version = ?')
    params.push(filter.contractVersion)
  }
  if (filter?.gate) {
    where.push('gate = ?')
    params.push(filter.gate)
  }
  if (filter?.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = filter?.limit && filter.limit > 0 ? ` LIMIT ${Math.floor(filter.limit)}` : ''
  const rows = getDb()
    .prepare(`SELECT * FROM content_gate_runs ${clause} ORDER BY created_at DESC, rowid DESC${limit}`)
    .all(...params) as ContentGateRunRow[]
  return rows.map(rowToGateRun)
}

// Último run do contrato (opcionalmente de um gate específico). Desempata por
// rowid porque vários gates do mesmo material caem no mesmo milissegundo.
export function getLastGateRun(contractId: string, gate?: ContentGateKind): ContentGateRun | null {
  const clause = gate ? 'AND gate = ?' : ''
  const params: unknown[] = gate ? [contractId, gate] : [contractId]
  const row = getDb()
    .prepare(
      `SELECT * FROM content_gate_runs WHERE contract_id = ? ${clause}
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...params) as ContentGateRunRow | undefined
  return row ? rowToGateRun(row) : null
}
