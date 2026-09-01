import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import initSqlJs from 'sql.js'

const DIR = '/home/thiagoematumoto/projetos/pessoal/claude-manager/.worktrees/readme-media/.readme-media-anon'
const DB = join(DIR, 'app.db')
const require = createRequire(import.meta.url)

// Deterministic index from a string (no Math.random / Date.now).
function hashIdx(s: string, mod: number): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % mod
}
const pick = <T>(pool: T[], seed: string) => pool[hashIdx(seed, pool.length)]

// ---- Fake mappings for structured columns (by real value) ----
const PROJECT_NAME: Record<string, string> = {
  Assistente: 'Copilot',
  Diligencia: 'Diligence',
  Pessoal: 'Personal',
  LASS: 'Platform',
  Data: 'Data',
  Infra: 'Infra',
}
const PROJECT_SLUG: Record<string, string> = {
  Copilot: 'copilot',
  Diligence: 'diligence',
  Personal: 'personal',
  Platform: 'platform',
  Data: 'data',
  Infra: 'infra',
}
const REPO_LABEL: Record<string, string> = {
  leia: 'data-warehouse',
  'data-lake': 'data-pipeline',
  'lexter-diligence': 'diligence-core',
  'lexter-imobiliario': 'property-service',
  'admin-console': 'admin-console',
  api: 'gateway-api',
  'diligence-hub': 'diligence-hub',
  'lexter-copilot-api': 'copilot-api',
  'lexter-copilot-addin': 'copilot-addin',
  'lexter-copilot-server': 'copilot-server',
  'legal-ui': 'web-app',
  'legal-core': 'core-api',
  'portfolio-intelligence': 'analytics-engine',
  'lexter-brain-plugin': 'search-plugin',
  lore: 'knowledge-base',
  'legal-hub': 'platform-hub',
  'squad-portfolio-plugin': 'insights-plugin',
  'claude-manager': 'northwind-web',
  Pitwall: 'northwind-web',
  'kaizen-workflow': 'design-system',
  arara: 'billing-service',
  Kakei: 'mobile-app',
  'claude-config': 'platform-config',
  'matumoto-dev': 'marketing-site',
  ThiagoEMatumoto: 'docs-site',
  dotfiles: 'dev-tools',
  infrastructure: 'infrastructure',
}
// which fake project each fake repo belongs to (for building paths)
const REPO_PROJ_SLUG: Record<string, string> = {
  'data-warehouse': 'data',
  'data-pipeline': 'data',
  'diligence-core': 'diligence',
  'property-service': 'diligence',
  'admin-console': 'diligence',
  'gateway-api': 'diligence',
  'diligence-hub': 'diligence',
  'copilot-api': 'copilot',
  'copilot-addin': 'copilot',
  'copilot-server': 'copilot',
  'web-app': 'platform',
  'core-api': 'platform',
  'analytics-engine': 'platform',
  'search-plugin': 'platform',
  'knowledge-base': 'platform',
  'platform-hub': 'platform',
  'insights-plugin': 'platform',
  'northwind-web': 'personal',
  'design-system': 'personal',
  'billing-service': 'personal',
  'mobile-app': 'personal',
  'platform-config': 'personal',
  'marketing-site': 'personal',
  'docs-site': 'personal',
  'dev-tools': 'personal',
  infrastructure: 'infra',
}

// ---- Global token replacement (longest-first) for JSON blobs / paths / cwd ----
const PERSON: Record<string, string> = { Eiji: 'Alex', Romulo: 'Jordan', Marcus: 'Sam', Matuki: 'Taylor' }
function buildTokenReplacements(): [string, string][] {
  const reps: [string, string][] = [
    ['/home/thiagoematumoto/projetos', '/home/dev/projects'],
    ['/home/thiagomatumoto/ClaudeManager', '/home/dev/projects'],
    ['thiagoematumoto', 'dev'],
    ['thiagomatumoto', 'dev'],
    ['ThiagoEMatumoto', 'northwind'],
    ['lexter-ai', 'northwind'],
  ]
  // distinctive repo labels (len >= 5, skip generic short dir names)
  const skip = new Set(['api', 'lore', 'leia'])
  for (const [real, fake] of Object.entries(REPO_LABEL)) {
    if (real.length >= 5 && !skip.has(real)) reps.push([real, fake])
  }
  // project name/dir tokens
  reps.push(['Assistente', 'Copilot'], ['Diligencia', 'Diligence'], ['Pessoal', 'Personal'], ['LASS', 'Platform'])
  reps.push(['assistente', 'copilot'], ['diligencia', 'diligence'], ['pessoal', 'personal'], ['/lass/', '/platform/'])
  for (const [real, fake] of Object.entries(PERSON)) reps.push([real, fake])
  reps.push(['lexter', 'northwind'])
  return reps.sort((a, b) => b[0].length - a[0].length)
}
const TOKENS = buildTokenReplacements()
function scrub(v: string | null): string | null {
  if (v == null) return v
  let out = v
  for (const [a, b] of TOKENS) out = out.split(a).join(b)
  return out
}

// ---- Curated free-text pools ----
const FEATURE_TITLES = [
  'Refactor auth flow', 'Add SSO support', 'Migrate to Postgres 16', 'Q3: reduce p95 latency',
  'Dark mode theming', 'Rework onboarding wizard', 'Introduce feature flags', 'Optimize image pipeline',
  'Add webhook retries', 'Rate limiting on public API', 'Bulk export to CSV', 'Realtime notifications',
  'Redesign settings page', 'Add audit log', 'Payment retries and dunning', 'Search relevance tuning',
  'Mobile offline mode', 'GraphQL gateway', 'Background job queue', 'Multi-tenant support',
  'Role-based access control', 'Caching layer for reads', 'CI pipeline hardening', 'Design system tokens',
  'Accessibility pass (WCAG AA)', 'Release 1.4.0', 'Release 1.5.0', 'Observability dashboards',
  'Idempotent webhook handling', 'Server-side pagination', 'Email deliverability fixes', 'Invoice PDF export',
]
const FEATURE_OBJ = [
  'Ship a cleaner, testable flow with full coverage and no regressions.',
  'Reduce latency at the tail and prove it with a dashboard.',
  'Improve activation by simplifying the first-run experience.',
  'Harden the API surface and make failures observable.',
  'Cut operational toil with a durable, idempotent design.',
]
const TASK_TITLES = [
  'Write integration tests for checkout', 'Fix flaky login test', 'Add pagination to orders list',
  'Upgrade to Node 22', 'Document the deploy runbook', 'Add error tracking', 'Migrate CI to GitHub Actions',
  'Cache the product catalog', 'Add health check endpoint', 'Handle expired sessions gracefully',
  'Instrument p95 latency dashboard', 'Backfill missing user avatars', 'Debounce search input',
  'Add retry to email worker', 'Validate webhook signatures', 'Split settings into tabs',
  'Add empty state to inbox', 'Wire up feature flag SDK', 'Reduce bundle size', 'Add rate limit headers',
  'Fix N+1 in orders query', 'Add dark mode toggle', 'Write E2E for signup', 'Add CSV export to reports',
  'Refactor pricing module', 'Add optimistic UI to cart', 'Rotate API keys', 'Add DB read replica',
  'Improve empty-state copy', 'Add Sentry breadcrumbs',
]
const TASK_DESC = [
  'Covers the main path plus edge cases; keep it deterministic.',
  'Scope is intentionally small so it can ship independently.',
  'Blocked on an external dependency; revisit after the release.',
  'Follow-up discovered during review; low risk, high value.',
  '',
]
const SESSION_TITLES = [
  'debug checkout flow', 'fix failing CI', 'investigate latency spike', 'add SSO login',
  'refactor pricing', 'release 1.4.0', 'review PR feedback', 'migrate database',
  'wire up analytics', 'polish settings UI', 'triage prod alerts', 'write e2e tests',
  'update dependencies', 'design review', 'sync data pipeline', 'rework onboarding',
  'add webhook retries', 'tune search relevance',
]
const SUMMARIES = [
  'Implemented and tested the change; all green.',
  'Found the root cause in the cache layer and patched it.',
  'Refactored the module and added coverage.',
  'Shipped the release and updated the changelog.',
  'Investigated the flake; stabilized the test.',
  'Wired the new endpoint and validated end-to-end.',
]
const TOPIC_TAGS = ['backend', 'frontend', 'infra', 'design', 'api', 'data', 'mobile', 'platform']

const OBJECTIVES = [
  { title: 'Q3 · Keep infra and data pipelines healthy', description: 'Foundational reliability work: keep ingestion and services healthy so downstream analytics and product signals stay trustworthy. Tracked via an uptime watchlist rather than a hard KR.', owner: 'Alex', tags: '["okr-q3","infra","platform"]' },
  { title: 'Q3 · Cut post-signup churn', description: 'Own the activation journey and reduce early churn from ~12% to ≤6% via root-cause discovery and a productionized per-account risk signal. Single owner of the result; execution is shared with the ops team.', owner: 'Alex', tags: '["okr-q3","retention"]' },
  { title: 'Product Management post-grad', description: 'Personal study track in Product Management: 360h across 5 phases, each ending with a micro-certification.', owner: null, tags: '["learning","career"]' },
  { title: 'Personal site (Awwwards-grade, motion-first)', description: 'Personal site + technical blog with motion design. Stack: Next.js (App Router) + TS + Tailwind + MDX. Prototype four directions, pick one, then build.', owner: null, tags: '["personal","website","design"]' },
  { title: 'Fluent English for international tech roles (B2+ in 6 months)', description: 'Reach a proven B2 level in 6 months to apply for international remote engineering roles. Method: 1h/day, output-first, daily speaking practice.', owner: null, tags: '["english","career","learning"]' },
]
const KR_BY_ORDER = [
  { title: 'KR3 — Post-signup churn (L90D): ~12% → ≤6%', owner: 'Alex', unit: '%' },
  { title: 'Courses completed', owner: null, unit: 'courses' },
  { title: 'Phases completed (with micro-cert)', owner: null, unit: 'phases' },
  { title: 'Design direction chosen (1 of 4 prototyped)', owner: null, unit: null },
  { title: 'Site live (prod deploy, Lighthouse Perf ≥90 / A11y 100)', owner: null, unit: null },
  { title: 'First technical blog post published', owner: null, unit: null },
  { title: 'Move from B1 to proven B2 (EF SET)', owner: null, unit: 'EF SET (0–100)' },
  { title: 'Accumulate ≥80h active conversation', owner: null, unit: 'hours' },
  { title: 'Complete ≥12 mock interviews with feedback', owner: null, unit: 'interviews' },
  { title: 'Produce ≥20 reviewed technical writing pieces', owner: null, unit: 'pieces' },
]
const BRANCHES = ['main', 'staging', 'feat/update', 'fix/patch', 'chore/release', 'feat/redesign']

// ---- run ----
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(DB))
const run = (sql: string, params: unknown[] = []) => db.run(sql, params as never)
const all = <T = Record<string, unknown>>(sql: string): T[] => {
  const [res] = db.exec(sql)
  if (!res) return []
  return res.values.map((row) => {
    const o: Record<string, unknown> = {}
    res.columns.forEach((c, i) => (o[c] = row[i]))
    return o as T
  })
}

// projects
for (const p of all<{ id: string; name: string }>('SELECT id, name FROM projects')) {
  const fake = PROJECT_NAME[p.name] ?? pick(FEATURE_TITLES, p.id)
  const slug = PROJECT_SLUG[fake] ?? fake.toLowerCase()
  run('UPDATE projects SET name=?, vault_path=? WHERE id=?', [fake, `/home/dev/projects/${slug}`, p.id])
}

// repos
for (const r of all<{ id: string; label: string; remote_url: string | null }>('SELECT id, label, remote_url FROM repos')) {
  const fake = REPO_LABEL[r.label] ?? `service-${hashIdx(r.id, 90)}`
  const slug = REPO_PROJ_SLUG[fake] ?? 'app'
  const path = `/home/dev/projects/${slug}/${fake}`
  const https = r.remote_url?.startsWith('https')
  const remote = https ? `https://github.com/northwind/${fake}.git` : `git@github.com:northwind/${fake}.git`
  run('UPDATE repos SET label=?, path=?, remote_url=? WHERE id=?', [fake, path, remote, r.id])
}

// repo_dependencies labels (mostly null; scrub if present)
for (const d of all<{ rowid: number; label: string | null }>('SELECT rowid, label FROM repo_dependencies WHERE label IS NOT NULL')) {
  run('UPDATE repo_dependencies SET label=? WHERE rowid=?', [scrub(d.label), d.rowid])
}

// features
for (const f of all<{ id: string; project_id: string; slug: string }>('SELECT id, project_id, slug FROM features')) {
  const title = pick(FEATURE_TITLES, f.id)
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const slug = `${base}-${f.id.slice(0, 8)}`
  const doc = `/home/dev/.config/northwind-manager/features/${f.project_id}/${slug}.md`
  run('UPDATE features SET title=?, slug=?, objective=?, doc_path=? WHERE id=?', [title, slug, pick(FEATURE_OBJ, f.id), doc, f.id])
}

// feature_session_records
for (const s of all<{ session_id: string }>('SELECT session_id FROM feature_session_records')) {
  run('UPDATE feature_session_records SET summary=? WHERE session_id=?', [pick(SUMMARIES, s.session_id), s.session_id])
}

// feature_repos (branch + worktree path derived from fake repo)
for (const fr of all<{ rowid: number; repo_id: string }>('SELECT rowid, repo_id FROM feature_repos')) {
  const repo = all<{ path: string; label: string }>(`SELECT path, label FROM repos WHERE id='${fr.repo_id}'`)[0]
  const branch = pick(BRANCHES, String(fr.rowid))
  const wt = repo ? repo.path : '/home/dev/projects/app'
  run('UPDATE feature_repos SET branch=?, worktree_path=? WHERE rowid=?', [branch, wt, fr.rowid])
}

// sessions
for (const s of all<{ id: string; title: string | null }>("SELECT id, title FROM sessions WHERE title IS NOT NULL AND title<>''")) {
  run('UPDATE sessions SET title=? WHERE id=?', [pick(SESSION_TITLES, s.id), s.id])
}

// objectives (5 fixed by position/created order)
{
  const objs = all<{ id: string }>('SELECT id FROM objectives ORDER BY created_at, id')
  objs.forEach((o, i) => {
    const f = OBJECTIVES[i % OBJECTIVES.length]
    run('UPDATE objectives SET title=?, description=?, owner=?, tags=? WHERE id=?', [f.title, f.description, f.owner, f.tags, o.id])
  })
}

// key_results (10 fixed by order)
{
  const krs = all<{ id: string }>('SELECT id FROM key_results ORDER BY created_at, id')
  krs.forEach((k, i) => {
    const f = KR_BY_ORDER[i % KR_BY_ORDER.length]
    run('UPDATE key_results SET title=?, owner=?, unit=? WHERE id=?', [f.title, f.owner, f.unit, k.id])
  })
}

// tasks
for (const t of all<{ id: string; tags: string | null }>('SELECT id, tags FROM tasks')) {
  const title = pick(TASK_TITLES, t.id)
  const desc = pick(TASK_DESC, t.id + 'd')
  const hadAuto = (t.tags ?? '').includes('"auto"')
  const tags = JSON.stringify([...(hadAuto ? ['auto'] : []), pick(TOPIC_TAGS, t.id)])
  run('UPDATE tasks SET title=?, description=?, notes=NULL, tags=? WHERE id=?', [title, desc, tags, t.id])
}

// handoffs (scrub structured/free text; drop embedded prompts/context)
for (const h of all<{ id: string }>('SELECT id FROM handoffs')) {
  run(
    "UPDATE handoffs SET task=?, summary=?, composed_prompt=?, context_json='{}', error=NULL, pending_question=NULL WHERE id=?",
    [pick(TASK_TITLES, h.id), pick(SUMMARIES, h.id), 'Delegated task — see linked feature.', h.id],
  )
}
// handoff_events detail -> null (may embed prompts)
run('UPDATE handoff_events SET detail=NULL')

// metrics_session_cache.cwd — scrub distinct real paths
for (const row of all<{ cwd: string }>("SELECT DISTINCT cwd FROM metrics_session_cache WHERE cwd IS NOT NULL AND cwd<>''")) {
  const scrubbed = scrub(row.cwd)
  if (scrubbed !== row.cwd) run('UPDATE metrics_session_cache SET cwd=? WHERE cwd=?', [scrubbed, row.cwd])
}

// workspace_state JSON blobs — token replace embedded project/repo/path refs
for (const w of all<{ id: number; open_panes: string | null; dock_layout: string | null }>('SELECT id, open_panes, dock_layout FROM workspace_state')) {
  run('UPDATE workspace_state SET open_panes=?, dock_layout=? WHERE id=?', [scrub(w.open_panes), scrub(w.dock_layout), w.id])
}

// app_prefs (vault_root path)
for (const a of all<{ key: string; value: string }>("SELECT key, value FROM app_prefs")) {
  const scrubbed = scrub(a.value)
  if (scrubbed !== a.value) run('UPDATE app_prefs SET value=? WHERE key=?', [scrubbed, a.key])
}

// persist
writeFileSync(DB, Buffer.from(db.export()))
db.close()
for (const f of ['app.db-wal', 'app.db-shm']) {
  const p = join(DIR, f)
  if (existsSync(p)) rmSync(p)
}

// CRITICAL: neutralize git-backed data-sync. The app's syncOnBoot() gate is
// existsSync(<userData>/sync/.git); if present it pulls the REAL backup bundle and
// does a replace-all import that clobbers this anonymized app.db. Remove the clone
// (and the cosmetic config) so boot-restore + push are no-ops.
for (const f of ['sync', 'sync-config.json']) {
  const p = join(DIR, f)
  if (existsSync(p)) rmSync(p, { recursive: true, force: true })
}
console.log('anonymized + wal/shm removed + data-sync neutralized')
