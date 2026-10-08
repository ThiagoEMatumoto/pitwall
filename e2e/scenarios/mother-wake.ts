import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { REPO_ROOT, launchApp } from '../driver/launch'
import { createFakeHome } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { waitReady } from '../driver/nav'
import type { LiveSessionInfo } from '../../shared/types/ipc'

// F1 — acordador da mãe, de ponta a ponta no app buildado:
//   A) mãe busy → filha chama handoff_ask via MCP (?s=filha) → linha queued →
//      mãe idle → envelope <pitwall-handoff-update> no stdin da mãe, ledger delivered
//   B) mãe com menu de permissão aberto (SIGUSR1 desenha a captura real) → ask →
//      held → fecha menu (SIGUSR2) → delivered
// HOME fake + stub do claude; repo descartável em MW_SANDBOX (git init).
// Rodar: MW_SCRATCH=<dir> MW_SANDBOX=<dir> npx tsx e2e/scenarios/mother-wake.ts

const require = createRequire(import.meta.url)
const SCRATCH = process.env.MW_SCRATCH!
const SANDBOX = process.env.MW_SANDBOX!
mkdirSync(SCRATCH, { recursive: true })
mkdirSync(SANDBOX, { recursive: true })
const SANDBOX_B = join(SANDBOX, 'repo-b')
mkdirSync(SANDBOX_B, { recursive: true })
for (const d of [SANDBOX, SANDBOX_B])
  if (!existsSync(join(d, '.git'))) execFileSync('git', ['init', '-q', d])
const fake = createFakeHome({ parentDir: SCRATCH })
const shot = (name: string) => join(SCRATCH, `mother-wake-${name}.png`)
const FIXTURE = join(REPO_ROOT, 'shared/tui/__fixtures__/claude-2.1.286-permission-bash.ansi')

const failures: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[mother-wake] ${ok ? 'OK ' : 'FALHOU'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const RULE = '─'.repeat(50)
// Stub: como o fake-claude, mas USR1 desenha o menu de permissão real e USR2
// volta para a caixa de input ociosa (limpando a tela nos dois).
const stubPath = join(fake.root, 'bin', 'wake-claude.sh')
writeFileSync(
  stubPath,
  `#!/usr/bin/env bash
SESSIONS_DIR=${shq(fake.sessionsDir)}
LOG=${shq(fake.logDir)}/claude-$$.log
FIXTURE=${shq(FIXTURE)}
session_id=''; name=''
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--resume) session_id="$2"; shift 2 ;;
    -n|--name) name="$2"; shift 2 ;;
    *) shift ;;
  esac
done
now=$(date +%s%3N)
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"busy","name":"%s","startedAt":%s,"updatedAt":%s}' \\
  "$$" "$session_id" "$PWD" "$name" "$now" "$now" > "$SESSIONS_DIR/$$.json"
box() { printf '\\n${RULE}\\n❯ \\n${RULE}\\n'; }
printf 'Fake Claude (wake stub) nome: %s\\n' "$name"
box
trap 'printf "\\033[2J\\033[3J\\033[H"; cat "$FIXTURE"; printf "menu:on\\n" >> "$LOG"' USR1
trap 'printf "\\033[2J\\033[3J\\033[H"; printf "menu fechado\\n"; box; printf "menu:off\\n" >> "$LOG"' USR2
while true; do
  if IFS= read -r line; then
    line=\${line//$'\\e[200~'/}
    line=\${line//$'\\e[201~'/}
    line=\${line%$'\\r'}
    printf 'stdin: %s\\n' "$line" >> "$LOG"
    printf 'recebido: %s\\n' "$line"
    box
  elif [ $? -le 128 ]; then
    exit 0
  fi
done
`,
)
chmodSync(stubPath, 0o755)

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await Promise.race([first.app.close(), new Promise((r) => setTimeout(r, 15_000))])
try {
  first.app.process().kill('SIGKILL')
} catch {
  /* já saiu */
}
const userData = first.userDataCopy
console.log('[mother-wake] userData cópia:', userData)

const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
{
  const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
  const now = Date.now()
  db.run(
    "UPDATE handoffs SET status = 'done' WHERE status IN ('pending','approved','running','needs_input')",
  )
  db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('claude_command', ?)", [stubPath])
  db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
  db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
  db.run(
    `INSERT INTO projects (id, name, color, position, created_at, updated_at)
     VALUES ('mw-proj', 'Wake Sandbox', '#9d8cff', -20, ?, ?)`,
    [now, now],
  )
  db.run(
    "INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('mw-repo', 'mw-proj', 'wake-sandbox', ?, 0, ?)",
    [SANDBOX, now],
  )
  db.run(
    "INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('mw-repo-b', 'mw-proj', 'wake-sandbox-b', ?, 1, ?)",
    [SANDBOX_B, now],
  )
  writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
  db.close()
}

// ---------- 2ª subida ----------
const { app, page, mainOutput } = await launchApp({ userDataDir: userData, env: fake.env })
const mainOut: string[] = []
app.process().stdout?.on('data', (d) => mainOut.push(String(d)))
app.process().stderr?.on('data', (d) => mainOut.push(String(d)))
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: shot('timeout') }).catch(() => {})
      throw new Error(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(500)
  }
}

function mcpAs(sessionId: string) {
  const cfg = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8'))
  const url = new URL(cfg.url)
  url.searchParams.set('s', sessionId)
  const dir = join(SCRATCH, `mcp-as-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ ...cfg, url: url.toString() }))
  return connectMcp(dir)
}
const logOf = (pid: number) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const ledger = (handoffId: string) =>
  queryDbLive(
    `SELECT wake_id, reason, outcome, detail, held_at, delivered_at, finished_at FROM handoff_wake_deliveries WHERE handoff_id = '${handoffId}' ORDER BY created_at`,
  )
// A cópia é escrita pelo app vivo (WAL): node:sqlite lê o -wal.
function queryDbLive(sql: string): Array<Record<string, unknown>> {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (
      p: string,
      o?: { readOnly?: boolean },
    ) => { prepare(s: string): { all(): unknown[] }; close(): void }
  }
  const db = new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 20 && !(await skip.count()); i++) await page.waitForTimeout(300)
  if (await skip.count()) await skip.click().catch(() => {})

  const [ptyM, ptyC] = (await page.evaluate(() =>
    Promise.all([
      window.api.sessions.spawn({ repoId: 'mw-repo', name: 'mae-wake' }),
      window.api.sessions.spawn({ repoId: 'mw-repo', name: 'filha-wake', handoffChild: true }),
    ]),
  )) as Array<{ id: string }>
  await waitFor('2 session files', async () => fake.readSessionFiles().length >= 2)
  const files = fake.readSessionFiles()
  const fileM = files.find((f) => f.data.name === 'mae-wake')!
  const fileC = files.find((f) => f.data.name === 'filha-wake')!
  console.log('[mother-wake] mãe pty', ptyM.id, 'pid', fileM.data.pid, '· filha', ptyC.id)

  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await waitReady(page)
  if (await skip.count()) await skip.click().catch(() => {})
  await waitFor('as duas sessões vivas', async () => {
    const live = (await page.evaluate(() =>
      window.api.sessions.listLiveGlobal(),
    )) as LiveSessionInfo[]
    return [ptyM.id, ptyC.id].every((id) => live.some((s) => s.id === id))
  })
  for (const id of [ptyM.id, ptyC.id])
    await page.evaluate((pty) => window.api.sessions.resize(pty, 100, 30), id)

  // Handoffs semeados direto no banco vivo pelo app? Não: escrever com o app aberto
  // corromperia o WAL. Usa a tool real de handoff? session_handoff exige spawn.
  // Caminho: INSERT via node:sqlite (WAL-safe, mesmo arquivo) — o store relê do banco.
  {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => {
        prepare(s: string): { run(...a: unknown[]): unknown }
        close(): void
      }
    }
    const db = new DatabaseSync(join(userData, 'app.db'))
    const now = Date.now()
    for (const [id, repo] of [['mw-h1', 'mw-repo'], ['mw-h2', 'mw-repo-b']]) {
      db.prepare(
        `INSERT INTO handoffs
           (id, mother_session_id, target_repo_id, child_session_id, feature_id, task,
            context_json, composed_prompt, status, mode, summary, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 'running', 'interactive', NULL, NULL, ?, ?)`,
      ).run(id, ptyM.id, repo, ptyC.id, `Tarefa ${id}`, `## Tarefa\n${id}`, now, now)
    }
    db.close()
  }

  const asChild = await mcpAs(ptyC.id)

  // ---------- A) mãe busy → queued → idle → delivered ----------
  const qA = 'Posso apagar a pasta dist do sandbox? (cenário A)'
  const rA = await asChild.call<{ status: string }>('handoff_ask', {
    handoffId: 'mw-h1',
    question: qA,
  })
  check('A: handoff_ask → needs_input', rA.status === 'needs_input', JSON.stringify(rA))
  await waitFor('A: linha no ledger', async () => ledger('mw-h1').length > 0, 15_000)
  const aQueued = ledger('mw-h1')
  check('A: mãe busy → ledger queued', aQueued[0]?.outcome === 'queued', JSON.stringify(aQueued))
  await page.waitForTimeout(3000)
  check('A: mãe busy → nada no stdin', !logOf(fileM.data.pid).includes('pitwall-handoff-update'))

  fake.setStatus(fileM.data.pid, 'idle')
  await waitFor(
    'A: envelope no stdin da mãe',
    async () => logOf(fileM.data.pid).includes('<pitwall-handoff-update'),
    30_000,
  )
  await waitFor(
    'A: ledger delivered',
    async () => ledger('mw-h1').every((r) => r.outcome === 'delivered'),
    15_000,
  )
  const aRows = ledger('mw-h1')
  console.log('[mother-wake] ledger A:', JSON.stringify(aRows))
  check(
    'A: ledger delivered com delivered_at',
    aRows.every((r) => r.outcome === 'delivered' && r.delivered_at),
  )
  const logM = logOf(fileM.data.pid)
  check(
    'A: envelope com handoff-id/alias/reason/pergunta',
    logM.includes('handoff-id="mw-h1"') &&
      logM.includes('alias="filha-wake"') &&
      logM.includes('reason="asked"') &&
      logM.includes(qA),
  )
  check(
    'A: filha não recebeu o envelope',
    !logOf(fileC.data.pid).includes('pitwall-handoff-update'),
  )
  await page.screenshot({ path: shot('A-delivered') })

  // ---------- B) menu aberto → held → fecha → delivered ----------
  // AWAIT_WORK_MS (15s) depois da entrega A: espera passar antes de testar o hold.
  process.kill(fileM.data.pid, 'SIGUSR1')
  await waitFor('B: menu:on no stub', async () => logOf(fileM.data.pid).includes('menu:on'), 10_000)
  await page.waitForTimeout(1500)
  const beforeB = (logOf(fileM.data.pid).match(/<pitwall-handoff-update/g) ?? []).length
  const qB = 'Qual branch base uso? (cenário B, menu aberto)'
  await asChild.call('handoff_ask', { handoffId: 'mw-h2', question: qB })
  await waitFor(
    'B: ledger held',
    async () => ledger('mw-h2').some((r) => r.outcome === 'held'),
    40_000,
  )
  const bHeld = ledger('mw-h2')
  console.log('[mother-wake] ledger B (held):', JSON.stringify(bHeld))
  check(
    'B: ledger held com held_at e detail menu-open',
    bHeld.some((r) => r.outcome === 'held' && r.held_at && r.detail === 'menu-open'),
    JSON.stringify(bHeld),
  )
  await page.waitForTimeout(4000)
  const midB = (logOf(fileM.data.pid).match(/<pitwall-handoff-update/g) ?? []).length
  check('B: menu aberto → nada novo no stdin', midB === beforeB, `${beforeB}→${midB}`)
  await page.screenshot({ path: shot('B-held') })

  process.kill(fileM.data.pid, 'SIGUSR2')
  await waitFor('B: envelope novo no stdin', async () => logOf(fileM.data.pid).includes(qB), 40_000)
  await waitFor(
    'B: ledger delivered',
    async () => ledger('mw-h2').every((r) => r.outcome === 'delivered'),
    15_000,
  )
  const bRows = ledger('mw-h2')
  console.log('[mother-wake] ledger B (final):', JSON.stringify(bRows))
  check(
    'B: held→delivered (held_at preservado)',
    bRows.every((r) => r.outcome === 'delivered' && r.held_at && r.delivered_at),
  )
  await page.screenshot({ path: shot('B-delivered') })

  // Tela da mãe pelo app: abre a sessão na UI, best-effort pra screenshot.
  const sessionLink = page.getByText('mae-wake', { exact: true }).first()
  if (await sessionLink.count()) {
    await sessionLink.click().catch(() => {})
    await page.waitForTimeout(2500)
  }
  await page.screenshot({ path: shot('mother-terminal') })

  const health = await (await mcpAs(ptyM.id)).call('handoff_list', {})
  console.log('[mother-wake] handoff_list da mãe:', JSON.stringify(health))
  console.log('[mother-wake] stdin da mãe (log do stub):\n' + logOf(fileM.data.pid))
  const drive = mainOutput()
    .split('\n')
    .filter((l) => /drive-safe|cópia sem gatilhos|handoff-wake|handoff_wake/.test(l))
  console.log('[mother-wake] main log relevante:\n' + drive.join('\n'))
  console.log('[mother-wake] page errors:', pageErrors.length ? pageErrors.join('\n') : 'nenhum')
} catch (err) {
  failures.push(String(err))
  console.error('[mother-wake] ERRO', err)
  console.log(
    '[mother-wake] logs stub:',
    readdirSync(fake.logDir)
      .map((f) => f + ':\n' + readFileSync(join(fake.logDir, f), 'utf8'))
      .join('\n'),
  )
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    /* já saiu */
  }
}

if (failures.length > 0) {
  console.error(`[mother-wake] ${failures.length} falha(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('[mother-wake] PASS')
