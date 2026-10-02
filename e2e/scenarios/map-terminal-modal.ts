import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// F1 do Mission Control v2: o terminal do mapa abre numa MODAL grande (lift)
// sem sair do mapa, sobre a CÓPIA do perfil real e com PTYs vivas do stub
// `claude` (HOME fake; o stub nunca toca o repo; CM_DRIVE_SAFE barra pull/clone).
//   M = mãe aberta por Ctrl+N (COM aba) · F = filha de M (sem aba, handoff).
// Asserções (evidência positiva):
//   [role=dialog][data-peek-mode=terminal] visível · vista segue 'map' ·
//   font-size de .xterm-rows >= 14px · texto digitado chega ao stdin da PTY e
//   aparece no tail do cartão · a aba da mãe mostra "Aberto no mapa" (xterm
//   desmontado) e não manda resize enquanto a modal está aberta · ao fechar a
//   aba remonta e refaz o fit · Esc/Shift+Esc/X fecham com o viewport idêntico ·
//   duplo clique no header e Enter no cartão selecionado abrem a modal · Alt+.
//   troca de sessão na faixa · "Abrir na aba" é a única ação que navega.
// Rodar: MODAL_SHOTS=<dir> npx tsx e2e/scenarios/map-terminal-modal.ts

const SHOTS = process.env.MODAL_SHOTS ?? join(tmpdir(), `map-terminal-modal-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0

const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[modal] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
const repos = (
  await queryDb<{ id: string; label: string; path: string }>(
    userData,
    'SELECT id, label, path FROM repos ORDER BY position, label',
  )
).filter((r) => r.path?.startsWith('/') && existsSync(r.path))
const labelCount = new Map<string, number>()
for (const r of repos) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)
const repo = repos.find((r) => labelCount.get(r.label) === 1)
if (!repo) throw new Error('a cópia precisa de um repo com label único')
console.log(`[modal] repo: ${repo.label}`)
writeCopyPrefs(userData, {
  claude_command: fake.fakeCliPath('claude'),
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

// ---------- 2ª subida: app real, HOME fake ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
})
const shot = (name: string) =>
  page
    .screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
    .catch(() => {})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[modal] timeout esperando: ${label}`)
      await shot(`timeout-${label.replace(/\W+/g, '-')}`)
      return false
    }
    await page.waitForTimeout(250)
  }
}

interface Live {
  id: string
  ccSessionId: string
}
const live = () => page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<Live[]>
const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const stdinOf = (pid: number | undefined) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return pid && existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const lift = page.locator('[role="dialog"][data-peek-lift]')
const liftTerminal = page.locator('[role="dialog"][data-peek-lift][data-peek-mode="terminal"]')
const viewport = () =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.react-flow__viewport')
    const m = new DOMMatrix(el ? getComputedStyle(el).transform : 'none')
    return { x: m.e, y: m.f, zoom: m.a }
  })
const sameViewport = (a: { x: number; y: number; zoom: number }, b: typeof a) =>
  Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3
const fmt = (v: { x: number; y: number; zoom: number }) =>
  `${v.x.toFixed(1)},${v.y.toFixed(1)}@${v.zoom.toFixed(3)}`
const mapVisible = () => page.getByTestId('session-map').isVisible()

// Spy do IPC sessions:resize no main: embrulha o handler registrado (ipcMain.handle
// guarda um por canal) e registra cada chamada antes de repassar.
async function installResizeSpy(): Promise<boolean> {
  return app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Function> })
      ._invokeHandlers
    const original = handlers?.get('sessions:resize')
    if (!original) return false
    const log: Array<{ id: string; cols: number; rows: number; t: number }> = []
    ;(globalThis as unknown as { __resizeLog: typeof log }).__resizeLog = log
    ipcMain.removeHandler('sessions:resize')
    ipcMain.handle('sessions:resize', (e, id: string, cols: number, rows: number) => {
      log.push({ id, cols, rows, t: Date.now() })
      return original(e, id, cols, rows)
    })
    return true
  })
}
const resizeLog = () =>
  app.evaluate(
    () =>
      (
        globalThis as unknown as {
          __resizeLog?: Array<{ id: string; cols: number; rows: number; t: number }>
        }
      ).__resizeLog ?? [],
  )

let fatal: unknown = null
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  check(await installResizeSpy(), 'spy do IPC sessions:resize instalado no main')

  // ---------- M: Ctrl+N (com aba) ----------
  await goToArea(page, 'projects')
  const beforeM = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(repo.label)
  await search.press('Enter')
  await page
    .locator('div.fixed.inset-0', { hasText: `Nova sessão · ${repo.label}` })
    .getByRole('button', { name: 'Abrir', exact: true })
    .click()
  let fileM: FakeSessionEntry | undefined
  await waitFor('session file de M', async () => {
    fileM = files().find((f) => !beforeM.has(f.data.pid))
    return !!fileM
  })
  let idM = ''
  await waitFor('sessions.id de M', async () => {
    idM = (await live()).find((s) => s.ccSessionId === fileM?.data.sessionId)?.id ?? ''
    return idM !== ''
  })
  // O dockview monta o conteúdo das panes fora do .dv-groupview: o xterm da aba é
  // qualquer .xterm que não esteja dentro da modal do mapa.
  const tabXterm = {
    count: () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('.xterm')].filter((el) => !el.closest('[data-peek-lift]'))
            .length,
      ),
  }
  check(
    !!idM && (await waitFor('xterm da aba de M', async () => (await tabXterm.count()) >= 1)),
    `M aberta por Ctrl+N em ${repo.label}, com aba e xterm`,
  )

  // ---------- F: filha de M, sem aba ----------
  const idF = await page.evaluate(
    async ({ repoId, mother }) => {
      const b = await window.api.sessions.spawn({ repoId, name: 'filha-modal', handoffChild: true })
      const { handoff } = await window.api.handoffs.createManual({
        repoId,
        motherSessionId: mother,
        task: 'Conferir o contrato da modal',
      })
      await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: b.id })
      return b.id
    },
    { repoId: repo.id, mother: idM },
  )

  // ---------- mapa ----------
  await page.keyboard.press('Control+Shift+KeyG')
  check(await waitFor('mapa', mapVisible), 'Ctrl+Shift+G abre o mapa')
  check(
    await waitFor(
      'cartões de M e F',
      async () => (await card(idM).count()) + (await card(idF).count()) === 2,
    ),
    'cartões de M e F no mapa',
  )
  // O painel da mãe abre sozinho com M (mother-focus-panel.ts cobre a convivência
  // dele com a modal e a aba). Aqui ele fica escondido: o fluxo medido é o da modal
  // sozinha, com a aba de M segurando a PTY quando ela fecha.
  if (await waitFor('painel automático', async () => (await page.getByTestId('mother-dock').count()) > 0, 5000)) {
    await page.keyboard.press('Control+Shift+KeyP')
  }
  check(
    await waitFor('painel escondido', async () => (await page.getByTestId('mother-dock').count()) === 0, 5000),
    'Ctrl+Shift+P esconde o painel da mãe',
  )
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await page.waitForTimeout(700)
  await shot('map')

  // ---------- 1. botão Terminal → modal; digitar; tail; aba cede ----------
  const vp0 = await viewport()
  const logBeforeModal = await resizeLog()
  const logBefore = logBeforeModal.length
  const tabSize = logBeforeModal.filter((r) => r.id === idM).at(-1)
  await card(idM).getByTestId('card-interact').click()
  const opened = await waitFor('modal em terminal', async () => (await liftTerminal.count()) === 1)
  check(opened, '[role=dialog][data-peek-mode=terminal] visível após o clique em Terminal')
  check(await mapVisible(), "a vista continua 'map' com a modal aberta")
  const liftXterm = liftTerminal.locator('.xterm')
  await waitFor('xterm da modal', async () => (await liftXterm.count()) === 1)
  // Com o WebglAddon não há .xterm-rows e o xterm 6 mede a fonte por OffscreenCanvas;
  // o host do Terminal expõe o fontSize que vai para term.options.
  const fontPx = await liftXterm
    .evaluate((el) => Number(el.closest<HTMLElement>('[data-font-size]')?.dataset.fontSize ?? 0))
    .catch(() => 0)
  check(fontPx >= 14, `font-size do xterm na modal = ${fontPx}px (>= 14)`)
  const box = await liftTerminal.boundingBox()
  const win =
    page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  check(
    !!box && box.width <= 1400.5 && box.height >= win.height * 0.85,
    `modal grande: ${box?.width.toFixed(0)}x${box?.height.toFixed(0)} em ${win.width}x${win.height}`,
  )
  const placeholder = await waitFor(
    'aba em "Aberto no mapa"',
    async () =>
      (await page.getByTestId('terminal-leased').count()) === 1 && (await tabXterm.count()) === 0,
    10_000,
  )
  check(placeholder, 'a aba de M desmonta o xterm e mostra "Aberto no mapa"')
  // Sem espera: digitar enquanto o backlog ainda é reproduzido não pode perder
  // teclas (o replay só descarta as respostas do xterm a queries antigas).
  await liftXterm.click()
  await page.keyboard.type('ola da modal')
  await page.keyboard.press('Enter')
  const typed = await waitFor('stdin de M', async () =>
    stdinOf(fileM?.data.pid).includes('stdin: ola da modal'),
  )
  check(typed, 'texto digitado na modal chega ao stdin da PTY de M')
  await shot('modal-typed')
  // O tail do cartão segue por baixo da modal.
  const tailed = await waitFor('tail do cartão', async () =>
    (
      await card(idM)
        .getByTestId('card-live-tail')
        .innerText()
        .catch(() => '')
    ).includes('ola da modal'),
  )
  check(tailed, 'o texto digitado aparece no tail do cartão de M')
  // Durante a modal: resize só no tamanho da modal (nenhum vindo da aba).
  await page.waitForTimeout(800)
  const during = (await resizeLog()).slice(logBefore).filter((r) => r.id === idM)
  // Os primeiros resizes são o próprio fit progressivo da modal; briga seria a aba
  // voltar a mandar o tamanho dela depois que a modal assumiu.
  const modalSize = during.at(-1)
  const firstModal = during.findIndex(
    (r) => modalSize && r.cols === modalSize.cols && r.rows === modalSize.rows,
  )
  const fights = during
    .slice(Math.max(firstModal, 0))
    .filter((r) => r.cols !== modalSize?.cols || r.rows !== modalSize?.rows)
  check(
    !!tabSize &&
      !!modalSize &&
      (modalSize.cols !== tabSize.cols || modalSize.rows !== tabSize.rows) &&
      fights.length === 0,
    `com a modal aberta a PTY de M só recebe o tamanho da modal (${during
      .map((r) => `${r.cols}x${r.rows}`)
      .join(' ')}; aba ${tabSize?.cols}x${tabSize?.rows})`,
  )
  // Fechar: o foco sai do corpo (clique no título) e o Esc fecha.
  await liftTerminal.locator('header span[id]').first().click()
  await page.keyboard.press('Escape')
  const closed = await waitFor('modal fecha no Esc', async () => (await lift.count()) === 0, 5000)
  const vp1 = await viewport()
  check(closed, 'Esc (fora do xterm) fecha a modal')
  check(sameViewport(vp0, vp1), `viewport idêntico após Esc (${fmt(vp0)} → ${fmt(vp1)})`)
  check(await mapVisible(), 'fechar a modal não sai do mapa')
  const back = await waitFor('aba remonta', async () => (await tabXterm.count()) >= 1, 10_000)
  await page.waitForTimeout(1200)
  const after = (await resizeLog()).filter((r) => r.id === idM && r.t > (during.at(-1)?.t ?? 0))
  check(
    back && (await page.getByTestId('terminal-leased').count()) === 0,
    'ao fechar, a aba de M remonta o xterm (replay do backlog)',
  )
  check(
    after.length > 0,
    `a aba refaz o fit e devolve o tamanho dela à PTY (${after.map((r) => `${r.cols}x${r.rows}`).join(' ')})`,
  )

  // ---------- 2. duplo clique no header → modal; Shift+Esc fecha ----------
  const vp2 = await viewport()
  await card(idM).getByTestId('card-title').dblclick()
  check(
    await waitFor('modal pelo duplo clique', async () => (await liftTerminal.count()) === 1),
    'duplo clique no header do cartão abre a modal em terminal',
  )
  check(await mapVisible(), "duplo clique não navega (vista segue 'map')")
  await waitFor('xterm da modal (2)', async () => (await liftXterm.count()) === 1)
  await liftXterm.click()
  await page.keyboard.press('Shift+Escape')
  await waitFor('modal fecha no Shift+Esc', async () => (await lift.count()) === 0, 5000)
  const vp3 = await viewport()
  check(sameViewport(vp2, vp3), `viewport idêntico após Shift+Esc (${fmt(vp2)} → ${fmt(vp3)})`)

  // ---------- 3. Enter no cartão selecionado → modal; Alt+. troca para F ----------
  await card(idM).getByTestId('card-status').click()
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  check(
    await waitFor('modal pelo Enter', async () => (await liftTerminal.count()) === 1),
    'Enter com o cartão selecionado abre a modal',
  )
  const strip = page.getByTestId('peek-lift-strip')
  check(
    (await strip.locator('[data-lift-session]').count()) >= 2,
    'faixa de troca lista as sessões do mesmo agrupamento',
  )
  await waitFor('xterm da modal (3)', async () => (await liftXterm.count()) === 1)
  await liftXterm.click()
  await page.keyboard.press('Alt+Period')
  const switched = await waitFor(
    'faixa em F',
    async () =>
      (await strip.locator(`[data-lift-session="${idF}"]`).getAttribute('aria-pressed')) === 'true',
  )
  check(switched, 'Alt+. troca a modal para a filha F, ainda em terminal')
  check(
    (await liftTerminal.count()) === 1 && (await mapVisible()),
    "a troca mantém a modal em terminal e a vista em 'map'",
  )
  await shot('modal-strip-child')
  await page.getByRole('dialog').getByLabel('Fechar').click()
  await waitFor('modal fecha no X', async () => (await lift.count()) === 0, 5000)
  check(await mapVisible(), 'X fecha sem sair do mapa')

  // ---------- 4. "Abrir na aba" é a única ação que navega ----------
  await card(idM).getByTestId('card-interact').click()
  await waitFor('modal (4)', async () => (await liftTerminal.count()) === 1)
  await page.getByTestId('peek-open-tab').click()
  const navigated = await waitFor(
    'aba de M na frente',
    async () => !(await mapVisible()) && (await tabXterm.count()) >= 1,
    10_000,
  )
  check(navigated, '"Abrir na aba" sai do mapa e leva até a aba de M, com o xterm de volta')
  await shot('open-tab')

  check(consoleErrors.length === 0, `zero erros de console (${consoleErrors.length})`)
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 5).join('\n---\n'))
} catch (err) {
  fatal = err
  console.error('[modal] erro fatal:', err)
  await shot('fatal')
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
  fake.cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log(
  `\n[modal] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS}`,
)
if (fatal || failed.length) process.exit(1)
