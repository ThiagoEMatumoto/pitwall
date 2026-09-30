import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import type { Locator } from 'playwright'
import { launchApp } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { goToArea, waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'
import type { SessionGraph } from '../../shared/types/session-graph'

// Grafo de sessões de ponta a ponta, pelos caminhos de produção:
//   - a MÃE é uma sessão aberta pelo Ctrl+N;
//   - a FILHA nasce do session_handoff do MCP chamado COM a identidade da mãe
//     (?s=<sessions.id>, o mesmo carimbo do mcp-config por sessão);
//   - o BASTÃO é o baton:pass real (sucessora sobe, predecessor_session_id gravado).
// Asserções:
//   1. session-graph:get devolve mãe→sucessora (handoff) e antecessora→sucessora (bastão);
//   2. o header da mãe mostra o chip "↓ <sucessora>"; clicar abre o quick look sem aba nova;
//   3. Alt+. da mãe vai pra filha (peek); Alt+, da filha vai pra antecessora do
//      bastão (abre em aba) — o header dela mostra "⟲ bastão → <sucessora>" — e
//      Alt+. dali volta pra filha;
//   4. nenhum Alt+,/Alt+. chegou ao PTY (o stub loga cada linha do stdin).
// HOME fake + stub do claude: nenhuma API é chamada, ~/.claude real intocado.
//
// Rodar: npm run build (Electron ABI) e então
//   GRAPH_SCRATCH=<dir> npx tsx e2e/scenarios/session-graph-nav.ts

const require = createRequire(import.meta.url)
const SCRATCH = process.env.GRAPH_SCRATCH ?? mkdtempSync(join(tmpdir(), 'session-graph-nav-'))
mkdirSync(SCRATCH, { recursive: true })
const fake = createFakeHome({ parentDir: SCRATCH })

function fail(msg: string): never {
  throw new Error(`[graph] FALHOU: ${msg}`)
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const repos = await queryDb<{ id: string; label: string; path: string }>(
  userData,
  'SELECT id, label, path FROM repos ORDER BY label',
)
const target = repos.find((r) => r.path && existsSync(r.path)) ?? fail('nenhum repo no disco')
console.log('[graph] repo-alvo:', target.label, target.path)

// ---------- seed ----------
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
const setPref = (key: string, value: string) =>
  db.run('INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)', [key, value])
setPref('claude_command', fake.fakeCliPath('claude'))
setPref('app.showIntroOnBoot', JSON.stringify(false))
setPref('session.defaultPaneMode', JSON.stringify('terminal'))
setPref('handoffs.requireApproval', JSON.stringify(false))
db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
// Handoffs ativos herdados do perfil real barrariam o dedup do session_handoff e
// poluiriam o grafo: o sistema do cenário é só o que ele cria.
db.run(
  "UPDATE handoffs SET status = 'done', dismissed_at = COALESCE(dismissed_at, 1) WHERE dismissed_at IS NULL",
)
db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()

// ---------- 2ª subida ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const logs = captureLogs(app, page)
console.log('[graph] log:', logs.logFile)
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))

async function waitFor(label: string, fn: () => boolean | Promise<boolean>, timeoutMs = 60_000) {
  const started = Date.now()
  while (!(await fn())) {
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: join(SCRATCH, 'graph-timeout.png') }).catch(() => {})
      fail(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(400)
  }
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const tabCount = () => page.locator('.dv-tab').count()
const hud = page.locator('[data-testid="session-link-hud"]')
const activeCc = async () =>
  (await page.locator('[data-testid="attention-hud"]').getAttribute('data-active-cc')) ?? ''

async function newSessionFile(before: Set<number>, label: string): Promise<FakeSessionEntry> {
  let created: FakeSessionEntry | undefined
  await waitFor(label, () => {
    created = files().find((f) => !before.has(f.data.pid))
    return !!created
  })
  return created!
}

async function spawnMother(): Promise<FakeSessionEntry> {
  const before = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(target.label)
  await search.press('Enter')
  await page
    .locator('div.fixed.inset-0', { hasText: `Nova sessão · ${target.label}` })
    .getByRole('button', { name: 'Abrir', exact: true })
    .click()
  return newSessionFile(before, 'session file da mãe')
}

// sessions.id (o endereço que o grafo e o MCP usam) a partir do ccSessionId.
async function sessionIdOf(cc: string): Promise<string> {
  let id: string | undefined
  await waitFor(`sessions.id de ${cc}`, async () => {
    const live = (await page.evaluate(() => window.api.sessions.listLiveGlobal())) as Array<{
      id: string
      ccSessionId: string
    }>
    id = live.find((s) => s.ccSessionId === cc)?.id
    return !!id
  })
  return id!
}

// connectMcp lê url+token de <dir>/mcp.json: um mcp.json com ?s=<mãe> é o mesmo
// carimbo que o app grava no mcp-config por sessão.
function mcpAs(motherSessionId: string) {
  const cfg = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8'))
  const url = new URL(cfg.url)
  url.searchParams.set('s', motherSessionId)
  const dir = join(SCRATCH, 'mcp-as-mother')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ ...cfg, url: url.toString() }))
  return connectMcp(dir)
}

async function graph(): Promise<SessionGraph> {
  return (await page.evaluate(() => window.api.sessionGraph.get())) as SessionGraph
}

// O dockview monta o conteúdo das panes num overlay fora do .dv-groupview, então
// "está na pane ativa" é decidido pela geometria do grupo ativo, não pelo DOM.
async function inActiveGroup(selector: string): Promise<Locator | null> {
  const group = await page.locator('.dv-active-group').boundingBox()
  if (!group) return null
  const found = page.locator(`${selector}:visible`)
  for (let i = 0; i < (await found.count()); i++) {
    const box = await found.nth(i).boundingBox()
    if (!box) continue
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const inside =
      cx > group.x && cx < group.x + group.width && cy > group.y && cy < group.y + group.height
    if (inside) return found.nth(i)
  }
  return null
}

async function focusActiveXterm(): Promise<void> {
  const xterm = await inActiveGroup('.xterm')
  if (!xterm) fail('nenhum xterm visível no grupo ativo')
  await xterm.click()
}

async function pressAndExpectHud(combo: string, sessionId: string, label: string): Promise<void> {
  await page.keyboard.press(combo)
  await waitFor(
    `${label}: HUD em ${sessionId}`,
    async () => {
      return (
        (await hud.getAttribute('data-node')) === sessionId &&
        (await hud.getAttribute('data-visible')) === 'true'
      )
    },
    10_000,
  )
  console.log(`[graph] ${label}: HUD "${(await hud.innerText()).trim()}"`)
}

// Header da pane ativa: é nele que a faixa de relações mora.
async function activeChip(testId: string, label: string): Promise<Locator> {
  let chip: Locator | null = null
  await waitFor(
    label,
    async () => {
      const strip = await inActiveGroup('[data-testid="connected-chips"]')
      chip = strip && (await strip.getByTestId(testId).count()) > 0 ? strip : null
      return !!chip
    },
    20_000,
  )
  return chip!
}

try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})

  const mother = await spawnMother()
  const motherId = await sessionIdOf(mother.data.sessionId)
  console.log('[graph] mãe:', motherId, mother.data.sessionId)

  // ---------- filha pelo session_handoff, com a identidade da mãe ----------
  const beforeChild = new Set(files().map((f) => f.data.pid))
  const mcp = await mcpAs(motherId)
  const dispatched = await mcp.call<{ handoffId: string; alias: string }>('session_handoff', {
    targetRepo: target.label,
    task: 'Investigar fila lenta do worker',
    mode: 'plan',
  })
  console.log('[graph] handoff:', dispatched)
  const child = await newSessionFile(beforeChild, 'session file da filha')
  const childId = await sessionIdOf(child.data.sessionId)

  // ---------- bastão pelo baton:pass real ----------
  const beforeSucc = new Set(files().map((f) => f.data.pid))
  const passed = (await page.evaluate(
    (cc) =>
      window.api.baton.pass({
        ccSessionId: cc,
        briefing: '## Estado atual\nFila investigada até o consumer.\n## Próximo passo\nMedir.',
      }),
    child.data.sessionId,
  )) as { session: { id: string }; alias: string | null }
  const successor = await newSessionFile(beforeSucc, 'session file da sucessora')
  const successorId = passed.session.id
  console.log('[graph] bastão:', {
    antecessora: childId,
    sucessora: successorId,
    alias: passed.alias,
  })

  // ---------- 1. o grafo que o main monta ----------
  await waitFor(
    'grafo com handoff e bastão',
    async () => {
      const g = await graph()
      const handoff = g.edges.some(
        (e) => e.kind === 'handoff' && e.from === motherId && e.to === successorId,
      )
      const baton = g.edges.some(
        (e) => e.kind === 'baton' && e.from === childId && e.to === successorId,
      )
      return handoff && baton
    },
    20_000,
  )
  const g = await graph()
  const succNode =
    g.nodes.find((n) => n.sessionId === successorId) ?? fail('sucessora fora do grafo')
  if (succNode.purposeHint !== 'Investigar fila lenta do worker')
    fail(`purposeHint da sucessora: ${succNode.purposeHint}`)
  if (succNode.childOfHandoffId !== dispatched.handoffId) fail('sucessora não é a filha do handoff')
  console.log('[graph] arestas:', JSON.stringify(g.edges.map((e) => e.kind)))

  // ---------- 2. chips no header da mãe ----------
  await goToArea(page, 'projects')
  const motherStrip = await activeChip('chip-children', 'chip da filha no header da mãe')
  const childrenChip = motherStrip.getByTestId('chip-children')
  const chipText = (await childrenChip.innerText()).trim()
  if (!chipText.startsWith('↓ ')) fail(`chip da filha: "${chipText}"`)
  const chipTitle = (await childrenChip.getAttribute('title')) ?? ''
  if (!chipTitle.includes('Investigar fila lenta')) fail(`tooltip sem o propósito: ${chipTitle}`)
  console.log(`[graph] chip na mãe: "${chipText}" · tooltip: ${JSON.stringify(chipTitle)}`)
  await motherStrip.screenshot({ path: join(SCRATCH, 'graph-chips-mother.png') })
  await page.screenshot({ path: join(SCRATCH, 'graph-mother.png') })

  const tabsBefore = await tabCount()
  await childrenChip.click()
  await page.locator('[data-peek-mode]').waitFor({ state: 'visible', timeout: 10_000 })
  if ((await tabCount()) !== tabsBefore) fail('clicar na filha criou aba')
  await page.screenshot({ path: join(SCRATCH, 'graph-peek-from-chip.png') })
  console.log('[graph] clique na filha: quick look aberto, abas', tabsBefore)
  await page.keyboard.press('Escape')
  await page.locator('[data-peek-mode]').waitFor({ state: 'detached', timeout: 5000 })

  // ---------- 3. Alt+. / Alt+, ----------
  await focusActiveXterm()
  await pressAndExpectHud('Alt+Period', successorId, '1º Alt+. (mãe → filha)')
  await page.locator('[data-peek-mode]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.screenshot({ path: join(SCRATCH, 'graph-hud-child.png') })

  await pressAndExpectHud('Alt+Comma', childId, 'Alt+, (filha → antecessora do bastão)')
  await waitFor(
    'antecessora ativa',
    async () => (await activeCc()) === child.data.sessionId,
    15_000,
  )
  if ((await page.locator('[data-peek-mode]').count()) > 0)
    fail('peek continuou aberto sobre a aba')
  const predecessorStrip = await activeChip('chip-baton-out', 'chip de bastão na antecessora')
  const batonChip = predecessorStrip.getByTestId('chip-baton-out')
  console.log(`[graph] chip na antecessora: "${(await batonChip.innerText()).trim()}"`)
  await predecessorStrip.screenshot({ path: join(SCRATCH, 'graph-chips-predecessor.png') })

  await pressAndExpectHud('Alt+Period', successorId, 'Alt+. (antecessora → filha)')
  await page.locator('[data-peek-mode]').waitFor({ state: 'visible', timeout: 10_000 })

  // ---------- 4. nada vazou pro PTY ----------
  await page.keyboard.press('Escape')
  await page.locator('[data-peek-mode]').waitFor({ state: 'detached', timeout: 5000 })
  await focusActiveXterm()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  const stdinLines = fake
    .readCliLog('claude')
    .split('\n')
    .filter((l) => l.startsWith('stdin:'))
  const leaked = stdinLines.filter((l) => /\x1b/.test(l))
  if (leaked.length > 0) fail(`Alt+,/Alt+. vazou pro PTY: ${JSON.stringify(leaked)}`)
  console.log('[graph] stdin dos PTYs:', JSON.stringify(stdinLines))
  if (stdinLines.length === 0)
    console.log('[graph] AVISO: Enter não chegou a nenhum PTY — vazamento não verificado')

  console.log('[graph] sucessora pid:', successor.data.pid)
  console.log('[graph] page errors:', pageErrors.length ? pageErrors.join('\n') : 'nenhum')
  console.log('[graph] screenshots:', SCRATCH)
  console.log('[graph] PASS')
} finally {
  const proc = app.process()
  logs.stop()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
  fake.cleanup()
}
