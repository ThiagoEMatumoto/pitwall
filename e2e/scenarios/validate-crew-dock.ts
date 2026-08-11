import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { launchApp, REPO_ROOT } from '../driver/launch'
import { waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// Evidência visual dos 3 estados do Crew Dock (colapsado / auto-reveal / peek).
// O binário `claude` é substituído por um stub (pref claude_command) que só
// escreve os artefatos de disco que o app observa — nenhuma API é chamada e
// nenhum repo é modificado. HOME é redirecionado para um fake-home, então
// ~/.claude do usuário real NÃO é tocado.

const require = createRequire(import.meta.url)
const SCRATCH = process.env.CREW_SCRATCH!
const FAKE_CLAUDE = join(SCRATCH, 'fake-claude.sh')
const FAKE_HOME = join(SCRATCH, 'fake-home')
const MAIN_ENTRY = join(REPO_ROOT, 'out/main/index.js')

interface Seed {
  id: string
  task: string
  mode: string
  expectName: string
}

const SEEDS: Seed[] = [
  {
    id: 'crew-mauricio',
    task: 'Refatorar auth para tokens rotativos',
    mode: 'auto-edits',
    expectName: 'mauricio',
  },
  {
    id: 'crew-otavio',
    task: 'Investigar listagem lenta no dashboard',
    mode: 'plan',
    expectName: 'otavio',
  },
  {
    id: 'crew-renata',
    task: 'Migrar endpoint de export para Cloud SQL',
    mode: 'interactive',
    expectName: 'renata',
  },
]

// ---------- 1ª subida: roda migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const repos = (await queryDb(userData, 'SELECT id, label, path FROM repos ORDER BY label')) as Array<{
  id: string
  label: string
  path: string
}>
const target = repos.find((r) => r.path && existsSync(r.path))
if (!target) throw new Error('nenhum repo da cópia existe no disco')
console.log('[crew] repo-alvo:', target.label, target.path)

// ---------- seed: 3 handoffs pendentes + stub do claude ----------
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
const now = Date.now()

// Silencia handoffs ativos herdados do perfil real: a equipe do screenshot é só a seedada.
db.run(
  "UPDATE handoffs SET status = 'done' WHERE status IN ('pending','approved','running','needs_input')",
)
db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('claude_command', ?)", [FAKE_CLAUDE])

// Sem restaurar o workspace do perfil real: o restore re-spawnaria as sessões do
// usuário (panes de terminal) e poluiria a evidência do dock.
db.run("UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1")

for (const [i, s] of SEEDS.entries()) {
  db.run(
    `INSERT INTO handoffs
       (id, mother_session_id, target_repo_id, child_session_id, feature_id, task,
        context_json, composed_prompt, status, mode, summary, error, created_at, updated_at)
     VALUES (?, NULL, ?, NULL, NULL, ?, NULL, ?, 'pending', ?, NULL, NULL, ?, ?)`,
    [
      s.id,
      target.id,
      s.task,
      `## Tarefa\n${s.task}\n\nContexto: validação visual do Crew Dock.`,
      s.mode,
      now - i * 1000,
      now - i * 1000,
    ],
  )
}
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()
console.log('[crew]', SEEDS.length, 'handoffs pendentes seedados em', userData)

mkdirSync(join(FAKE_HOME, '.claude', 'sessions'), { recursive: true })
mkdirSync(join(FAKE_HOME, '.claude', 'projects'), { recursive: true })
// O spawn usa `zsh -l -i -c`; sem ~/.zshrc o zsh dispara o zsh-newuser-install e
// FICA PARADO num prompt interativo — a filha nunca sobe. Arquivo vazio resolve.
writeFileSync(join(FAKE_HOME, '.zshrc'), '')
writeFileSync(join(FAKE_HOME, '.zshenv'), '')

// ---------- 2ª subida: app real, HOME fake, claude stub ----------
const app = await electron.launch({
  args: [MAIN_ENTRY, '--no-sandbox', `--user-data-dir=${userData}`],
  env: { ...process.env, HOME: FAKE_HOME },
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const consoleErrors: string[] = []
const pageErrors: string[] = []
const failedRequests: string[] = []
const mainErr: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`)
})
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))
page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText ?? '?'} ${r.url()}`))
app.process().stderr?.on('data', (d) => mainErr.push(String(d).trimEnd()))

function sessionFiles(): Array<{ file: string; data: Record<string, unknown> }> {
  const dir = join(FAKE_HOME, '.claude', 'sessions')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      file: join(dir, f),
      data: JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>,
    }))
}

async function dotTitles(): Promise<string[]> {
  return page.$$eval('[data-testid="crew-dock"] button[title]', (els) =>
    els.map((e) => e.getAttribute('title') ?? ''),
  )
}

// Quantas filhas o dock mostra como vivas/trabalhando — vale colapsado (title do
// dot) e expandido (label do badge no card), pra o wait não depender do estado.
async function workingCount(): Promise<number> {
  const fromTitles = (await dotTitles()).filter((t) => t.includes('trabalhando')).length
  const fromText = await page
    .locator('[data-testid="crew-dock"]')
    .evaluate((el) => ((el as HTMLElement).innerText.match(/trabalhando/g) ?? []).length)
    .catch(() => 0)
  return Math.max(fromTitles, fromText)
}

// A intro (Splash) cobre a janela inteira no boot e depois do reload — sem pular,
// todo screenshot vira a animação. O botão é `.spl-skip` ("Pular intro").
async function dismissIntro(): Promise<void> {
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 30; i++) {
    if (await skip.count()) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await skip.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
      return
    }
    await page.waitForTimeout(500)
  }
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 120_000) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: join(SCRATCH, 'crew-timeout-diagnostic.png') }).catch(() => {})
      const dump = await page
        .locator('[data-testid="crew-dock"]')
        .innerText({ timeout: 2000 })
        .catch(() => '(dock ausente)')
      console.log('[crew] DIAGNOSTICO no timeout — dock innerText:\n' + dump)
      throw new Error(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(1000)
  }
}

try {
  await waitReady(page)
  await dismissIntro()
  console.log('[crew] app pronto — aguardando o dispatch das 3 filhas')

  // As 3 filhas sobem sozinhas (gate off): o stub vira PTY viva + status 'busy'.
  await waitFor('3 filhas trabalhando', async () => {
    const working = await workingCount()
    if (working > 0) console.log('[crew] filhas trabalhando:', working)
    return working === 3
  })

  // Zera a preferência persistida do dock: o estado inicial da evidência é o
  // default do produto (colapsado), não o que ficou no perfil real.
  await page.evaluate(() => localStorage.removeItem('cm:crew-dock'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await waitReady(page)
  await dismissIntro()
  await waitFor('dock remontado com 3 dots', async () => (await dotTitles()).length >= 4)
  await page.waitForTimeout(1500)

  const dock = page.locator('[data-testid="crew-dock"]')
  const w1 = await dock.evaluate((el) => el.getBoundingClientRect().width)
  const exp1 = await dock.getAttribute('data-expanded')
  console.log('[crew] estado 1 — largura:', w1, 'expanded:', exp1)
  console.log('[crew] estado 1 — dots:', JSON.stringify(await dotTitles()))
  await page.screenshot({ path: join(SCRATCH, 'crew-1-colapsado.png') })

  // ---------- auto-reveal: mauricio passa a esperar ----------
  const files = sessionFiles()
  console.log('[crew] session files:', files.map((f) => `${f.data.name}=${f.data.status}`).join(' | '))
  const waitingOne = files.find((f) => String(f.data.name ?? '').startsWith('mauricio'))
  if (!waitingOne) throw new Error('sessão da mauricio não encontrada no fake-home')
  writeFileSync(
    waitingOne.file,
    JSON.stringify({ ...waitingOne.data, status: 'waiting', updatedAt: Date.now() }),
  )
  console.log('[crew] flip para waiting em', waitingOne.file)

  await waitFor('dock auto-revelado', async () => {
    const expanded = await dock.getAttribute('data-expanded')
    return expanded === 'true'
  }, 60_000)
  await page.waitForTimeout(1500)

  const w2 = await dock.evaluate((el) => el.getBoundingClientRect().width)
  console.log('[crew] estado 2 — largura:', w2, 'expanded:', await dock.getAttribute('data-expanded'))
  console.log('[crew] estado 2 — header:', await dock.locator('header').innerText())
  await page.screenshot({ path: join(SCRATCH, 'crew-2-autoreveal.png') })

  // ---------- peek: card da filha em espera, sem abrir pane ----------
  const card = dock.locator('[data-testid="handoff-card"]').first()
  console.log('[crew] estado 3 — card:\n' + (await card.innerText()))
  const panes = await page.locator('.dv-tab, .dv-view').count()
  console.log('[crew] panes dockview abertos (nenhum terminal aberto por este cenário):', panes)
  await card.screenshot({ path: join(SCRATCH, 'crew-3-peek.png') })

  console.log('[crew] --- console errors/warnings ---')
  console.log(consoleErrors.length ? consoleErrors.join('\n') : 'nenhum')
  console.log('[crew] --- page errors ---')
  console.log(pageErrors.length ? pageErrors.join('\n') : 'nenhum')
  console.log('[crew] --- requests falhados ---')
  console.log(failedRequests.length ? failedRequests.join('\n') : 'nenhum')
  console.log('[crew] --- main stderr ---')
  console.log(mainErr.length ? mainErr.join('\n') : 'nenhum')
} finally {
  // app.close() pendura quando alguma PTY não morre; mata o processo no timeout.
  const proc = app.process()
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 15_000)),
  ])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
}
