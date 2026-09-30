import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { launchApp } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { goToArea, waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// Fila de atenção de ponta a ponta: 2 sessões comuns em waiting + 1 filha da
// equipe com pergunta aberta (handoff_ask pelo MCP, o caminho de produção).
//   1. badge "N no box" da TitleBar = sessões da fila (a filha NÃO conta);
//   2. ordem da spec, com B ativa: Alt+A → A (a mais antiga), Alt+A → B, Alt+A → a
//      filha abre no quick look SEM criar aba nem trocar a ativa; Alt+Shift+A volta
//      pra B (fecha o peek) e de novo pra A;
//   3. Alt+Q volta pra sessão anterior (MRU: B);
//   4. nenhum Alt+A/Alt+Q chegou ao PTY (o stub loga cada linha do stdin).
// HOME fake + stub do claude: nenhuma API é chamada, ~/.claude real intocado.
//
// Rodar: npm run build (Electron ABI) e então
//   ATTN_SCRATCH=<dir> npx tsx e2e/scenarios/attention-cycle.ts

const require = createRequire(import.meta.url)
const SCRATCH = process.env.ATTN_SCRATCH ?? mkdtempSync(join(tmpdir(), 'attention-cycle-'))
mkdirSync(SCRATCH, { recursive: true })
const fake = createFakeHome({ parentDir: SCRATCH })
const CREW_ID = 'attn-crew'

function fail(msg: string): never {
  throw new Error(`[attention] FALHOU: ${msg}`)
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
console.log('[attention] repo-alvo:', target.label, target.path)

// ---------- seed ----------
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
const setPref = (key: string, value: string) =>
  db.run('INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)', [key, value])
setPref('claude_command', fake.fakeCliPath('claude'))
setPref('app.showIntroOnBoot', JSON.stringify(false))
setPref('session.defaultPaneMode', JSON.stringify('terminal'))
// A filha sobe sozinha (sem o diálogo de aprovação).
setPref('handoffs.requireApproval', JSON.stringify(false))
// Atalhos do perfil real poderiam ter remapeado Alt+A/Alt+Q.
db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
db.run(
  "UPDATE handoffs SET status = 'done' WHERE status IN ('pending','approved','running','needs_input')",
)
db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
const now = Date.now()
db.run(
  `INSERT INTO handoffs
     (id, mother_session_id, target_repo_id, child_session_id, feature_id, task,
      context_json, composed_prompt, status, mode, summary, error, created_at, updated_at)
   VALUES (?, NULL, ?, NULL, NULL, ?, NULL, ?, 'pending', 'interactive', NULL, NULL, ?, ?)`,
  [CREW_ID, target.id, 'Investigar fila lenta', '## Tarefa\nInvestigar fila lenta', now, now],
)
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()

// ---------- 2ª subida ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const logs = captureLogs(app, page)
console.log('[attention] log:', logs.logFile)
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))

async function waitFor(label: string, fn: () => boolean | Promise<boolean>, timeoutMs = 60_000) {
  const started = Date.now()
  while (!(await fn())) {
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: join(SCRATCH, 'attention-timeout.png') }).catch(() => {})
      fail(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(400)
  }
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const tabCount = () => page.locator('.dv-tab').count()
const hud = page.locator('[data-testid="attention-hud"]')
const hudActiveCc = async () => (await hud.getAttribute('data-active-cc')) ?? ''
const badgeText = async () =>
  (
    await page
      .locator('[data-testid="titlebar-attention-badge"]')
      .innerText()
      .catch(() => '')
  ).trim()

async function spawnSession(): Promise<FakeSessionEntry> {
  const before = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(target.label)
  await search.press('Enter')
  await page
    .getByText(`Nova sessão · ${target.label}`)
    .waitFor({ state: 'visible', timeout: 10_000 })
  // O toast da filha também tem um "Abrir": escopar ao overlay do diálogo.
  await page
    .locator('div.fixed.inset-0', { hasText: `Nova sessão · ${target.label}` })
    .getByRole('button', { name: 'Abrir', exact: true })
    .click()
  let created: FakeSessionEntry | undefined
  await waitFor('session file da sessão nova', () => {
    created = files().find((f) => !before.has(f.data.pid))
    return !!created
  })
  return created!
}

// O dockview (renderer "always") monta o conteúdo num overlay fora do groupview:
// o xterm da aba ativa é o que cai dentro da caixa do grupo ativo.
async function focusActiveXterm(): Promise<void> {
  const group = await page.locator('.dv-active-group').boundingBox()
  if (!group) fail('sem grupo ativo no dock')
  const xterms = page.locator('.xterm:visible')
  for (let i = 0; i < (await xterms.count()); i++) {
    const box = await xterms.nth(i).boundingBox()
    const cx = box ? box.x + box.width / 2 : -1
    if (box && cx > group.x && cx < group.x + group.width) {
      await xterms.nth(i).click()
      return
    }
  }
  fail('nenhum xterm visível no grupo ativo')
}

// HUD fora da faixa de abas e sem encostar no peek (o overlay mede os vizinhos).
async function checkHudPlacement(label: string): Promise<void> {
  await page.waitForTimeout(100)
  const box = await hud.boundingBox()
  if (!box) fail(`${label}: HUD sem caixa`)
  const tabs = await page.evaluate(() => {
    let best: { top: number; bottom: number } | null = null
    for (const el of document.querySelectorAll('.dv-tabs-and-actions-container')) {
      const r = el.getBoundingClientRect()
      if (r.height > 0 && (!best || r.top < best.top)) best = { top: r.top, bottom: r.bottom }
    }
    return best
  })
  const peekLoc = page.locator('[data-peek-mode]')
  const peek = (await peekLoc.count()) > 0 ? await peekLoc.boundingBox() : null
  console.log(`[attention] ${label}: HUD y=${box.y.toFixed(0)}..${(box.y + box.height).toFixed(0)}`, {
    tabs,
    peek: peek ? { top: peek.y, bottom: peek.y + peek.height } : null,
  })
  if (peek) {
    const touches = box.y + box.height > peek.y - 2 && box.y < peek.y + peek.height + 2
    if (touches) fail(`${label}: HUD encosta no peek`)
  } else if (tabs && box.y < tabs.bottom) {
    fail(`${label}: HUD sobre a faixa de abas (${box.y} < ${tabs.bottom})`)
  }
}

async function pressAndExpectActive(combo: string, cc: string, label: string): Promise<void> {
  await page.keyboard.press(combo)
  await waitFor(`${label}: sessão ativa = ${cc}`, async () => (await hudActiveCc()) === cc, 15_000)
  console.log(`[attention] ${label}: HUD "${(await hud.innerText()).trim()}" · ativa ${cc}`)
}

try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})

  // A filha nasce primeiro (dispatch automático) — o 1º session file é o dela.
  await waitFor('filha da equipe no ar', () => files().length === 1, 90_000)
  const crew = files()[0]
  const a = await spawnSession()
  const b = await spawnSession()
  await waitFor('2 abas abertas', async () => (await tabCount()) === 2, 30_000)
  console.log('[attention] sessões:', {
    crew: crew.data.sessionId,
    a: a.data.sessionId,
    b: b.data.sessionId,
  })

  // A espera primeiro (mais antiga), B depois.
  fake.setStatus(a.data.pid, 'waiting')
  await page.waitForTimeout(1200)
  fake.setStatus(b.data.pid, 'waiting')
  const mcp = await connectMcp(userData)
  await mcp.call('handoff_ask', { handoffId: CREW_ID, question: 'Posso apagar o índice antigo?' })

  await waitFor('badge "2 no box"', async () => (await badgeText()) === '2 no box', 30_000)
  console.log('[attention] badge:', await badgeText(), '(filha fora: badge == sessões da fila)')

  // Ctrl+N não troca de área (openSession só cria a pane): sai da Home para o dock.
  await goToArea(page, 'projects')
  await page.screenshot({ path: join(SCRATCH, 'attention-before-cycle.png') })
  // Foco no xterm da aba ativa (B): se o Alt+A vazasse, cairia no PTY dela.
  await focusActiveXterm()
  const tabsBefore = await tabCount()

  // B está ativa: o 1º Alt+A vai pra mais antiga (A), não pro item depois de B.
  await pressAndExpectActive('Alt+a', a.data.sessionId, '1º Alt+A (mais antiga)')
  const hudFirst = (await hud.innerText()).trim()
  if (!hudFirst.startsWith('1/3')) fail(`1º Alt+A fora da ordem: ${hudFirst}`)
  await page.screenshot({ path: join(SCRATCH, 'attention-hud-session.png') })
  await checkHudPlacement('HUD na sessão')
  await pressAndExpectActive('Alt+a', b.data.sessionId, '2º Alt+A')

  await page.keyboard.press('Alt+a')
  await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 10_000 })
  await waitFor('HUD na filha', async () => (await hud.getAttribute('data-item-kind')) === 'crew')
  const hudCrewText = (await hud.innerText()).trim()
  await page.screenshot({ path: join(SCRATCH, 'attention-hud-crew.png') })
  await checkHudPlacement('HUD no peek')
  if (!hudCrewText.endsWith('pergunta pendente'))
    fail(`motivo da filha com pergunta: ${hudCrewText}`)
  const tabsAfterPeek = await tabCount()
  if (tabsAfterPeek !== tabsBefore) fail(`peek criou aba: ${tabsBefore} → ${tabsAfterPeek}`)
  if ((await hudActiveCc()) !== b.data.sessionId) fail('peek da filha trocou a aba ativa')
  console.log(`[attention] 3º Alt+A: HUD "${hudCrewText}" · abas ${tabsAfterPeek} (sem aba nova)`)
  if (!hudCrewText.startsWith('3/3')) fail(`HUD da filha fora de ordem: ${hudCrewText}`)

  await pressAndExpectActive('Alt+Shift+a', b.data.sessionId, 'Alt+Shift+A (da filha → B)')
  await waitFor('peek fechado', async () => (await page.getByRole('dialog').count()) === 0, 5000)
  await pressAndExpectActive('Alt+Shift+a', a.data.sessionId, 'Alt+Shift+A (→ A)')
  // Alt+Q volta pra B (a sessão focada antes de A).
  await pressAndExpectActive('Alt+q', b.data.sessionId, 'Alt+Q (volta)')

  // Com a palette aberta o Alt+A não pode trocar a aba por baixo.
  await page.waitForTimeout(1400)
  const hudBeforePalette = (await hud.innerText()).trim()
  await page.keyboard.press('Control+k')
  await page.locator('[data-modal-overlay]').first().waitFor({ state: 'visible', timeout: 5000 })
  await page.keyboard.press('Alt+a')
  await page.waitForTimeout(800)
  if ((await hudActiveCc()) !== b.data.sessionId) fail('Alt+A com a palette aberta trocou a aba')
  if ((await hud.getAttribute('data-visible')) === 'true')
    fail(`Alt+A com a palette aberta andou a fila: ${(await hud.innerText()).trim()}`)
  if ((await page.locator('[data-peek-mode]').count()) > 0) fail('Alt+A com a palette abriu o peek')
  console.log(`[attention] palette aberta: Alt+A ignorado (HUD segue "${hudBeforePalette}")`)
  await page.keyboard.press('Escape')
  await page.locator('[data-modal-overlay]').first().waitFor({ state: 'detached', timeout: 5000 })

  // Enter em B revela o que chegou ao PTY dela desde o clique.
  await focusActiveXterm()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  const leaked = fake
    .readCliLog('claude')
    .split('\n')
    .filter((l) => l.startsWith('stdin:') && /\x1b|[aAqQ]\s*$/.test(l.slice('stdin:'.length)))
  if (leaked.length > 0) fail(`tecla vazou pro PTY: ${JSON.stringify(leaked)}`)
  const stdinLines = fake
    .readCliLog('claude')
    .split('\n')
    .filter((l) => l.startsWith('stdin:'))
  console.log('[attention] stdin dos PTYs:', JSON.stringify(stdinLines))
  if (stdinLines.length === 0)
    console.log('[attention] AVISO: Enter não chegou a nenhum PTY — vazamento não verificado')
  console.log('[attention] page errors:', pageErrors.length ? pageErrors.join('\n') : 'nenhum')
  console.log('[attention] screenshot:', join(SCRATCH, 'attention-hud-crew.png'))
  console.log('[attention] PASS')
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
