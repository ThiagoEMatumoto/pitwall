import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import initSqlJs from 'sql.js'
import { launchApp } from '../driver/launch'
import { waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// Filha REAL (claude de verdade, HOME real pra auth) num repo descartável, pedindo
// permissão pra um Bash `sqlite3 nota.db "create table t(x)"`. Valida notificação, menu no CrewPeek,
// Aprovar pelo peek e a linha em attention_responses.

const require = createRequire(import.meta.url)
const SCR =
  '/tmp/claude-1000/-home-thiagoematumoto-projetos-pessoal-claude-manager/3e6fa140-d345-4f47-b6a7-ed1353c3c9db/scratchpad/drive'
const SANDBOX = join(SCR, 'perm-sandbox')
const SHOTS = join(SCR, 'requests')
const LOG = join(SCR, 'scenario.log')
const HID = 'perm-validate-1'
const log = (...a: unknown[]) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  appendFileSync(LOG, line + '\n')
}

const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
log('[perm] userData', userData)

const projects = (await queryDb(
  userData,
  'SELECT id FROM projects ORDER BY position LIMIT 1',
)) as Array<{ id: string }>
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
const now = Date.now()
db.run(
  "UPDATE handoffs SET status = 'done' WHERE status IN ('pending','approved','running','needs_input')",
)
db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('notifications', ?)", [
  JSON.stringify({ enabled: true, sessionWaiting: true, usageHigh: false }),
])
db.run(
  'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 999, ?)',
  ['perm-sandbox-repo', projects[0].id, 'perm-sandbox', SANDBOX, now],
)
const TASK =
  'Rode exatamente o comando `sqlite3 nota.db "create table t(x)"` com a tool Bash, agora, sem perguntar nada antes. Depois reporte.'
db.run(
  `INSERT INTO handoffs
     (id, mother_session_id, target_repo_id, child_session_id, feature_id, task,
      context_json, composed_prompt, status, mode, summary, error, created_at, updated_at)
   VALUES (?, NULL, ?, NULL, NULL, ?, NULL, ?, 'pending', 'interactive', NULL, NULL, ?, ?)`,
  [HID, 'perm-sandbox-repo', TASK, `## Tarefa\n${TASK}`, now, now],
)
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()

const { app, page } = await launchApp({ userDataDir: userData, env: { CM_MCP_PORT: '41998' } })
const mainOut: string[] = []
app.process().stdout?.on('data', (d) => mainOut.push(String(d)))
app.process().stderr?.on('data', (d) => mainOut.push(String(d)))
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.message))

const live = () => new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
const q = (sql: string) => {
  const d = live()
  try {
    return d.prepare(sql).all()
  } finally {
    d.close()
  }
}
const shot = (n: string) => page.screenshot({ path: join(SHOTS, n) })
async function waitFor(label: string, fn: () => Promise<boolean> | boolean, ms = 120_000) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) {
      await shot(`timeout-${label.replace(/\W+/g, '-')}.png`).catch(() => {})
      throw new Error('timeout: ' + label)
    }
    await page.waitForTimeout(1000)
  }
}

try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 20 && !(await skip.count()); i++) await page.waitForTimeout(500)
  if (await skip.count()) await skip.click().catch(() => {})
  log(
    '[perm] drive-safe lines:',
    mainOut
      .join('')
      .split('\n')
      .filter((l) => l.includes('drive-safe')),
  )
  await page.evaluate(() => {
    const w = window as unknown as {
      __notifs: unknown[]
      api: { notifications: { onEvent: (h: (e: unknown) => void) => void } }
    }
    w.__notifs = []
    w.api.notifications.onEvent((e) => w.__notifs.push(e))
  })

  await waitFor(
    'handoff running',
    () => {
      const r = q(`SELECT status, child_session_id FROM handoffs WHERE id='${HID}'`)[0] as
        { status: string } | undefined
      return r?.status === 'running' || r?.status === 'needs_input'
    },
    90_000,
  )
  log('[perm] handoff:', q(`SELECT status, child_session_id FROM handoffs WHERE id='${HID}'`))
  await shot('01-child-running.png')

  async function openPeek() {
    if (await page.locator('.pw-rise').count()) return
    await page.keyboard.press('Control+j')
    await page.waitForTimeout(800)
    const card = page.locator(`[data-crew-card="${HID}"]`)
    if (await card.count()) await card.first().focus()
    await page.keyboard.press(' ')
    await page.waitForTimeout(1500)
    if (!(await page.locator('.pw-rise').count())) {
      await card.first().click().catch(() => {})
      await page.waitForTimeout(1500)
    }
  }
  const menu = page.locator('[data-testid="crew-peek-menu"]')
  const getNotifs = async () =>
    (await page.evaluate(() => (window as unknown as { __notifs: Array<{ title: string }> }).__notifs)) ?? []
  let trusted = false
  let lastSt = ''
  const T0 = Date.now()
  let dumped = false
  await waitFor('Aprovar no peek', async () => {
    await openPeek()
    const st = JSON.stringify(q(`SELECT status, error FROM handoffs WHERE id='${HID}'`))
    if (st !== lastSt) { log('[perm] handoff agora:', st); lastSt = st }
    if (!dumped && !trusted) {
      const peek = page.locator('.pw-rise')
      const txt = await peek.innerText().catch(() => '')
      if (/trust this folder/i.test(txt)) {
        await peek.getByRole('button', { name: /Terminal/ }).first().click().catch(() => {})
        await page.waitForTimeout(2000)
        const t2 = await peek.innerText().catch(() => '')
        if (/Yes, I trust this folder/.test(t2)) {
          dumped = true
          log('[perm] badge com trust na tela:', (await peek.getByText('filha encerrou').count()) > 0)
          await shot('02a-trust-terminal.png')
          await peek.locator('.xterm').first().click().catch(() => {})
          await page.keyboard.press('ArrowDown')
          await page.waitForTimeout(400)
          await page.keyboard.press('Enter')
          trusted = true
          log('[perm] trust respondido pelo terminal do peek')
          await page.waitForTimeout(3000)
          await peek.getByRole('button', { name: /^Chat$/ }).first().click().catch(() => {})
        }
      }
    }
    if (await menu.locator('[data-testid="attention-action-approve"]').count()) return true
    if (!(globalThis as any).__shotChat && Date.now() - T0 > 90_000) {
      ;(globalThis as any).__shotChat = true
      await shot('02b-peek-chat-waiting.png')
      log('[perm] peek (chat) após 90s:\n' + (await page.locator('.pw-rise').innerText().catch(() => '')).slice(0, 1500))
      log('[perm] badge filha encerrou:', (await page.locator('.pw-rise').getByText('filha encerrou').count()) > 0)
      log('[perm] notificações até aqui:', await getNotifs())
    }
    const trust = menu.locator('[data-testid="attention-action-trust"]')
    if (!trusted && (await trust.count())) {
      await shot('02a-peek-trust.png')
      log('[perm] trust menu no peek:\n' + (await menu.innerText()))
      await trust.click()
      trusted = true
      log('[perm] cliquei Confiar')
    }
    return false
  }, 300_000)
  await page.waitForTimeout(2500)
  log('[perm] notificações:', await getNotifs())
  log('[perm] peek aberto:', await page.locator('.pw-rise').count())
  log('[perm] menu peek texto:\n' + (await menu.innerText()))
  const buttons = await menu.locator('[data-testid^="attention-action-"]').evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-testid')}=${(e as HTMLElement).innerText}`),
  )
  log('[perm] botões:', buttons)
  await shot('03-peek-menu.png')
  log('[perm] attention_responses antes:', q('SELECT menu_kind, choice, waited_ms FROM attention_responses'))

  const approve = menu
    .locator('[data-testid="attention-action-approve"], [data-testid="attention-action-yes"]')
    .first()
  const target = (await approve.count())
    ? approve
    : menu.locator('[data-testid^="attention-action-"]').first()
  log('[perm] clicando:', await target.getAttribute('data-testid'))
  await target.click()
  await page.waitForTimeout(1500)
  await shot('04-after-approve.png')

  await waitFor('arquivo movido', () => existsSync(join(SANDBOX, 'nota.db')), 60_000)
  log('[perm] arquivo.txt existe?', existsSync(join(SANDBOX, 'arquivo.txt')))
  await page.waitForTimeout(5000)
  await shot('05-after-exec.png')
  log(
    '[perm] attention_responses:',
    q(
      'SELECT session_id, handoff_id, menu_kind, tool, command_summary, choice, waited_ms, created_at FROM attention_responses ORDER BY created_at DESC LIMIT 5',
    ),
  )
  log('[perm] handoff final:', q(`SELECT status FROM handoffs WHERE id='${HID}'`))
} catch (e) {
  log('[perm] ERRO:', String(e))
} finally {
  try { const { copyFileSync } = await import('node:fs'); copyFileSync(join(userData, 'app.db'), join(SCR, 'app-copy.db')); for (const x of ['-wal','-shm']) { if (existsSync(join(userData, 'app.db'+x))) copyFileSync(join(userData,'app.db'+x), join(SCR,'app-copy.db'+x)) } } catch (e) { log('[perm] copy db falhou', String(e)) }
  log('[perm] page errors:', pageErrors)
  log(
    '[perm] main attention lines:',
    mainOut
      .join('')
      .split('\n')
      .filter((l) => /attention|crew permission|Error/i.test(l))
      .slice(0, 20),
  )
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    /* saiu */
  }
}
