import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { getDb } from './db'
import { writeFileAtomic } from './atomic-file'
import { loopSnapshot } from './loop-snapshot'
import type { FeatureLoopSnapshot } from '../../../shared/types/ipc'

// Export do loop pro repo: escreve `.pitwall/loop-<slug>.md` em cada repo
// vinculado à feature. É o lado "de fora" do loop — a sessão que abre o repo
// (ou o humano que abre o editor) vê o estado sem precisar do app.
//
// O arquivo mora no repo do usuário e entra no diff dele, e é isso que dita as
// duas regras não-óbvias daqui:
//
// 1. CONTEÚDO DETERMINÍSTICO. Nenhum carimbo de geração (`generated_at` e afins).
//    Um timestamp de "quando exportei" mudaria os bytes a cada saída de sessão e
//    sujaria o `git status` do usuário sem nada ter mudado no loop. Todo
//    timestamp impresso vem do DADO (última atividade, data da entrada), nunca
//    do relógio da exportação. Datas em UTC pra dois computadores diferentes
//    produzirem o mesmo arquivo.
// 2. NUNCA CRIAR O REPO. Se o diretório-base não existe (worktree removido,
//    repo movido), o repo vira `skipped` — mkdir recursivo materializaria uma
//    árvore fantasma no lugar de um repo que sumiu.

/** Corpo de entrada de ledger acima disso é cortado: o doc é um panorama, não o arquivo-fonte. */
const LEDGER_BODY_MAX = 400

/** O ledger completo vive no app; no repo cabe o passado recente. */
const LEDGER_LIMIT = 10

export interface LoopExportSkip {
  repoId: string
  reason: string
}

export interface LoopExportResult {
  /** Caminhos escritos (ou que seriam escritos, em dryRun). */
  written: string[]
  skipped: LoopExportSkip[]
}

export interface LoopExportOpts {
  /** Calcula tudo e devolve os alvos sem tocar no disco. */
  dryRun?: boolean
}

interface FeatureExportRow {
  slug: string
  title: string
  objective: string | null
  cadence_days: number | null
  loop_export: number
}

interface RepoTargetRow {
  repo_id: string
  worktree_path: string | null
  repo_path: string | null
}

// ---- renderização ----

// Data em UTC (YYYY-MM-DD): o doc é comparado byte a byte entre máquinas, e
// hora local faria o mesmo estado render diferente em fusos diferentes.
function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

// Valor escalar de frontmatter. String sempre entre aspas duplas via
// JSON.stringify: objetivo com `:`, `#` ou quebra de linha quebraria o YAML.
function yamlValue(value: string | number | null): string {
  if (value === null) return 'null'
  return typeof value === 'number' ? String(value) : JSON.stringify(value)
}

function renderPulse(snapshot: FeatureLoopSnapshot): string[] {
  const pulse = snapshot.pulse
  if (!pulse) return ['_Sem pulso registrado._']
  return [`> ${pulse.body}`, '', `— ${pulse.source} · ${fmtDate(pulse.createdAt)}`]
}

function renderLedger(snapshot: FeatureLoopSnapshot): string[] {
  const entries = snapshot.ledger.slice(0, LEDGER_LIMIT)
  if (entries.length === 0) return ['_Nada registrado ainda._']
  const lines: string[] = []
  for (const entry of entries) {
    const kind = entry.kind ? ` (${entry.kind})` : ''
    lines.push(`- \`${entry.entryId}\`${kind} — ${entry.title} · ${fmtDate(entry.createdAt)}`)
    if (entry.body) {
      const body =
        entry.body.length > LEDGER_BODY_MAX ? `${entry.body.slice(0, LEDGER_BODY_MAX)}…` : entry.body
      for (const line of body.split('\n')) lines.push(`  ${line}`.trimEnd())
    }
  }
  return lines
}

function renderMetrics(snapshot: FeatureLoopSnapshot): string[] {
  if (snapshot.metrics.length === 0) return ['_Nenhuma métrica declarada._']
  return snapshot.metrics.map((series) => {
    const { column, latest, tone } = series
    const label = column.label ?? column.columnKey
    const unit = column.unit ? ` ${column.unit}` : ''
    const value = latest && latest.value !== null ? `${latest.value}${unit}` : '—'
    const measured = latest ? ` (${fmtDate(latest.at)})` : ''
    const refs: string[] = []
    if (column.target !== null) refs.push(`alvo ${column.target}`)
    if (column.floor !== null) refs.push(`piso ${column.floor}`)
    if (column.baseline !== null) refs.push(`base ${column.baseline}`)
    const head = column.isHeadline ? '**' : ''
    const suffix = refs.length > 0 ? ` · ${refs.join(' · ')}` : ''
    return `- ${head}${label}${head} (\`${column.columnKey}\`): ${value}${measured}${suffix} · tom: ${tone}`
  })
}

function renderIssues(snapshot: FeatureLoopSnapshot): string[] {
  if (snapshot.issues.length === 0) return ['_Nenhum._']
  return snapshot.issues.map((issue) => `- **${issue.level}** \`${issue.code}\` — ${issue.message}`)
}

export function renderLoopDoc(feature: FeatureExportRow, snapshot: FeatureLoopSnapshot): string {
  const lines = [
    '---',
    `slug: ${yamlValue(feature.slug)}`,
    `title: ${yamlValue(feature.title)}`,
    `liveness: ${snapshot.liveness}`,
    `last_activity: ${yamlValue(fmtDate(snapshot.lastActivityAt))}`,
    `cadence_days: ${yamlValue(feature.cadence_days)}`,
    `objective: ${yamlValue(feature.objective)}`,
    '---',
    '',
    `# Loop — ${feature.title}`,
    '',
    '## Pulso',
    '',
    ...renderPulse(snapshot),
    '',
    '## Ledger',
    '',
    ...renderLedger(snapshot),
    '',
    '## Métricas',
    '',
    ...renderMetrics(snapshot),
    '',
    '## Issues',
    '',
    ...renderIssues(snapshot),
    '',
  ]
  return lines.join('\n')
}

// ---- escrita ----

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Exporta o doc do loop pra cada repo vinculado.
 *
 * `features.loop_export = 0` desliga o export inteiro (nenhuma escrita, nenhum
 * skip: não há repo "pulado", a feature é que não exporta).
 */
export async function exportLoopDoc(
  featureId: string,
  opts: LoopExportOpts = {},
): Promise<LoopExportResult> {
  const db = getDb()
  const feature = db
    .prepare(
      'SELECT slug, title, objective, cadence_days, loop_export FROM features WHERE id = ?',
    )
    .get(featureId) as FeatureExportRow | undefined
  if (!feature) throw new Error(`feature not found: ${featureId}`)

  const result: LoopExportResult = { written: [], skipped: [] }
  if (feature.loop_export !== 1) return result

  const content = renderLoopDoc(feature, loopSnapshot(featureId))
  // ORDER BY pra o resultado (e a ordem das escritas) não depender do plano do
  // SQLite — dois exports do mesmo estado devolvem a mesma lista.
  const targets = db
    .prepare(
      `SELECT fr.repo_id, fr.worktree_path, r.path AS repo_path
         FROM feature_repos fr
         LEFT JOIN repos r ON r.id = fr.repo_id
        WHERE fr.feature_id = ?
        ORDER BY fr.repo_id`,
    )
    .all(featureId) as RepoTargetRow[]

  for (const target of targets) {
    const base = target.worktree_path ?? target.repo_path
    if (!base) {
      result.skipped.push({ repoId: target.repo_id, reason: 'repo sem caminho no banco' })
      continue
    }
    const dir = join(base, '.pitwall')
    const path = join(dir, `loop-${feature.slug}.md`)
    // Guarda de escape: o slug é DADO (vem do frontmatter do `.md`, editável
    // fora do app), então um `../..` nele reposiciona o alvo. Comparar o
    // caminho já normalizado é o que pega isso — validar o slug por regex
    // dependeria de prever toda forma de escrever "sobe um nível".
    //
    // A âncora é o `.pitwall/`, não o repo: `../../../pwn` cancela só o
    // `.pitwall` e aterrissa em `<repo>/pwn.md` — dentro do repo, e ainda assim
    // um arquivo que o app despeja na raiz do projeto de alguém. A checagem
    // contra `base` fica junto porque é a que impede o caso grave (escrever
    // FORA do repo) e não custa nada.
    const rel = relative(dir, path)
    if (rel.startsWith('..') || isAbsolute(rel) || relative(base, path).startsWith('..')) {
      result.skipped.push({
        repoId: target.repo_id,
        reason: `slug escaparia de .pitwall/: ${feature.slug}`,
      })
      continue
    }
    if (!(await isDirectory(base))) {
      result.skipped.push({ repoId: target.repo_id, reason: `repo não encontrado: ${base}` })
      continue
    }
    if (!opts.dryRun) {
      await mkdir(dir, { recursive: true })
      await writeFileAtomic(path, content)
    }
    result.written.push(path)
  }
  return result
}
