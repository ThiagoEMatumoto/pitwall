import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { launchApp } from '../driver/launch'
import { createFakeHome } from '../driver/fake-home'
import { goToArea, waitReady } from '../driver/nav'

// Pendências de UX do mapa/dock, no app buildado (HOME fake + stubs):
//   1. Dock da Equipe com o mapa na frente: overlay sobre o mapa (o mapa mantém
//      a largura); na vista Terminais segue empurrando o dockview.
//   2. Toolbar do cartão selecionado: no 1º cartão da lane vira pra baixo e não
//      passa da largura do cartão (não cobre o cabeçalho da lane nem a vizinha).
//   4. Aba da sessão Codex: badge antes do título (e do X).
//   5. Ctrl+N a partir da Home: a sessão nasce e o usuário vai junto pra Projetos.

const require = createRequire(import.meta.url)
const SCRATCH = process.env.POLISH_SCRATCH ?? join(tmpdir(), `final-polish-${Date.now()}`)
mkdirSync(SCRATCH, { recursive: true })
const fake = createFakeHome({ parentDir: SCRATCH })
const shot = (name: string) => join(SCRATCH, `polish-${name}.png`)

const PROJECT = { id: 'fp-proj', name: 'Polish', color: '#9d8cff' }
const REPOS = [
  { id: 'fp-api', label: 'fp-api' },
  { id: 'fp-web', label: 'fp-web' },
  { id: 'fp-ops', label: 'fp-ops' },
]

const failures: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[polish] ${ok ? 'OK ' : 'FALHOU'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
{
  const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
  const now = Date.now()
  db.run(
    "UPDATE handoffs SET status = 'done' WHERE status IN ('pending','approved','running','needs_input')",
  )
  db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
  db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('claude_command', ?)", [
    fake.fakeCliPath('claude'),
  ])
  db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('codex_command', ?)", [
    fake.fakeCliPath('codex'),
  ])
  db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
  db.run(
    'INSERT INTO projects (id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [PROJECT.id, PROJECT.name, PROJECT.color, -10, now, now],
  )
  for (const [i, r] of REPOS.entries()) {
    const path = join(SCRATCH, 'repos', r.label)
    mkdirSync(path, { recursive: true })
    db.run(
      'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [r.id, PROJECT.id, r.label, path, i, now],
    )
  }
  writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
  db.close()
}

type Api = {
  sessions: {
    spawn(i: unknown): Promise<{ id: string }>
    listLiveGlobal(): Promise<Array<{ id: string; status: string }>>
  }
  handoffs: {
    createManual(i: unknown): Promise<{ handoff: { id: string } }>
    markRunning(i: unknown): Promise<unknown>
  }
}

const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: shot(`timeout-${label.replace(/\W+/g, '-')}`) }).catch(() => {})
      console.log(`[polish] timeout esperando: ${label}`)
      return false
    }
    await page.waitForTimeout(250)
  }
}

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

const dock = page.getByTestId('crew-dock')
const card = (sessionId: string) =>
  page.locator(`[data-testid="session-card"][data-session-id="${sessionId}"]`)

let fatal: unknown = null
try {
  await waitReady(page)
  await dismissIntro()

  // ---------- seed: mãe + filha (equipe no dock) + uma solta ----------
  const ids = await page.evaluate(async () => {
    const a = (window as unknown as { api: Api }).api
    const mae = await a.sessions.spawn({ repoId: 'fp-api', name: 'mae-api' })
    const filha = await a.sessions.spawn({
      repoId: 'fp-web',
      name: 'filha-web',
      handoffChild: true,
    })
    const { handoff } = await a.handoffs.createManual({
      repoId: 'fp-web',
      motherSessionId: mae.id,
      task: 'Ajustar o layout do checkout',
    })
    await a.handoffs.markRunning({ id: handoff.id, childSessionId: filha.id })
    const solta = await a.sessions.spawn({ repoId: 'fp-ops', name: 'solta-ops' })
    return { mae: mae.id, filha: filha.id, solta: solta.id }
  })

  // ---------- 5 + 4. Ctrl+N da Home, Codex: vai pra Projetos; badge antes do título ----------
  await page.getByTitle(/^Home($| ·)/).first().click()
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill('fp-api')
  await search.press('Enter')
  const providerSeg = page.getByTestId('spawn-provider')
  await providerSeg.waitFor({ state: 'visible', timeout: 10_000 })
  await providerSeg.locator('[data-provider="codex"]').click()
  await page.getByPlaceholder('opcional').first().fill('fp-codex')
  await page.getByRole('button', { name: 'Edita o workspace', exact: true }).click()
  // Um toast com "Abrir" pode estar na pilha: o botão é o do diálogo de spawn.
  await page
    .locator('[data-modal-overlay], .fixed.inset-0')
    .getByRole('button', { name: 'Abrir', exact: true })
    .first()
    .click()

  const inProjects = await waitFor(
    'Projetos depois do Ctrl+N',
    async () => page.getByTestId('projects-view-map').isVisible(),
    15_000,
  )
  check('Ctrl+N a partir da Home leva a Projetos', inProjects)
  const tab = page.locator('.dv-tab', { hasText: 'fp-codex' })
  const tabUp = await waitFor('aba fp-codex', async () => tab.first().isVisible(), 15_000)
  check('a aba nova está visível e em foco', tabUp)
  if (tabUp) {
    await page.waitForTimeout(500)
    const badge = await tab.first().getByTestId('provider-badge').boundingBox()
    const title = await tab.first().locator('.dv-default-tab-content').boundingBox()
    const close = await tab.first().locator('.dv-default-tab-action').boundingBox()
    check(
      'badge CODEX antes do título e do X',
      !!badge && !!title && !!close && badge.x + badge.width <= title.x + 1 && badge.x < close.x,
      JSON.stringify({ badge: badge?.x, title: title?.x, close: close?.x }),
    )
  }
  await page.screenshot({ path: shot('1-ctrl-n-home-codex-tab') })

  // ---------- 1. dock sobre o mapa ----------
  await page.getByTestId('projects-view-map').click()
  const host = page.locator('#map-dock-host')
  await host.waitFor({ state: 'visible', timeout: 10_000 })
  await waitFor('cartão da mãe no mapa', async () => (await card(ids.mae).count()) === 1, 20_000)
  if ((await dock.getAttribute('data-expanded')) === 'true') {
    await dock.getByTitle('Recolher a equipe').click()
  }
  await page.waitForTimeout(400)
  const hostW0 = (await host.boundingBox())?.width ?? 0
  await page.screenshot({ path: shot('2a-map-dock-collapsed') })
  await page.keyboard.press('Control+j')
  const opened = await waitFor(
    'dock expandido',
    async () => (await dock.getAttribute('data-expanded')) === 'true',
    10_000,
  )
  check('Ctrl+J abre o dock com o mapa na frente', opened)
  await page.waitForTimeout(400)
  check(
    'dock vira overlay sobre o mapa',
    (await dock.getAttribute('data-overlay')) === 'true',
    String(await dock.getAttribute('data-overlay')),
  )
  const hostW1 = (await host.boundingBox())?.width ?? 0
  check(
    'o mapa mantém a largura toda com o dock aberto',
    Math.abs(hostW1 - hostW0) <= 1,
    `${hostW0} → ${hostW1}`,
  )
  const dockBox = await dock.boundingBox()
  const hostBox = await host.boundingBox()
  check(
    'overlay encostado na direita do mapa (dentro dele)',
    !!dockBox &&
      !!hostBox &&
      Math.abs(dockBox.x + dockBox.width - (hostBox.x + hostBox.width)) <= 1,
  )
  check('card da filha focável no overlay', (await page.locator(`[data-crew-card]`).count()) >= 1)
  await page.screenshot({ path: shot('2b-map-dock-overlay') })
  await dock.getByTitle('Recolher a equipe').click()
  check(
    'recolher o overlay volta à trilha',
    await waitFor(
      'dock recolhido',
      async () => (await dock.getAttribute('data-expanded')) === 'false',
      5000,
    ),
  )

  // ---------- 1b. vista Terminais: segue empurrando o dockview ----------
  await page.getByTestId('projects-view-terminals').click()
  await page.waitForTimeout(400)
  const dv = page.locator('.dv-dockview').first()
  const dvW0 = (await dv.boundingBox())?.width ?? 0
  await page.keyboard.press('Control+j')
  await waitFor(
    'dock expandido (terminais)',
    async () => (await dock.getAttribute('data-expanded')) === 'true',
    10_000,
  )
  await page.waitForTimeout(500)
  const dvW1 = (await dv.boundingBox())?.width ?? 0
  check(
    'Terminais: dock no layout (não overlay)',
    (await dock.getAttribute('data-overlay')) === null,
  )
  check(
    'Terminais: o dockview encolhe pela largura do dock',
    dvW0 - dvW1 > 200,
    `${dvW0} → ${dvW1}`,
  )
  await page.screenshot({ path: shot('3-terminals-dock-in-layout') })
  await dock.getByTitle('Recolher a equipe').click()

  // ---------- 2. toolbar do 1º cartão da lane ----------
  await page.getByTestId('projects-view-map').click()
  await host.waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('map-zoom-100').click()
  await page.waitForTimeout(500)
  const target = card(ids.solta)
  await target.scrollIntoViewIfNeeded().catch(() => {})
  await target.getByTestId('card-title').click()
  const toolbar = page.getByTestId('map-selection-toolbar')
  const tbUp = await waitFor('toolbar do cartão', async () => toolbar.isVisible(), 10_000)
  check('toolbar aparece no cartão selecionado', tbUp)
  if (tbUp) {
    await page.waitForTimeout(300)
    const tb = await toolbar.boundingBox()
    const cb = await target.boundingBox()
    const lane = page.locator('[data-testid="lane-repo"][data-repo-id="fp-ops"]')
    const laneBox = await lane.boundingBox()
    check(
      '1º cartão da lane: toolbar abaixo do cartão',
      (await toolbar.getAttribute('data-position')) === 'bottom' &&
        !!tb &&
        !!cb &&
        tb.y >= cb.y + cb.height - 1,
      JSON.stringify({ tb: tb?.y, cardBottom: cb ? cb.y + cb.height : null }),
    )
    check('toolbar não sobe no cabeçalho da lane', !!tb && !!laneBox && !!cb && tb.y > cb.y)
    check(
      'toolbar não passa da largura do cartão',
      !!tb && !!cb && tb.width <= Math.max(cb.width, 180) + 1,
      `${tb?.width} vs ${cb?.width}`,
    )
  }
  await page.screenshot({ path: shot('4-toolbar-first-card') })
} catch (err) {
  fatal = err
  await page.screenshot({ path: shot('fatal') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}

if (fatal) {
  console.error('[polish] erro fatal:', fatal)
  failures.push('fatal')
}
const relevantErrors = pageErrors.filter((e) => !/ResizeObserver loop/.test(e))
if (relevantErrors.length) console.log('[polish] erros de página:', relevantErrors.slice(0, 5))
console.log(`[polish] ${failures.length === 0 ? 'PASS' : `FAIL (${failures.join(', ')})`}`)
process.exit(failures.length === 0 ? 0 : 1)
