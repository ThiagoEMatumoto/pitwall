import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// Evidência do polimento r3 do mapa, sobre a CÓPIA do perfil real com HOME fake
// e o stub do `claude` (PTYs vivas, nada toca os repos):
//   feature cross-project "Checkout E2E" com mãe (M) + 2 filhas (C1, C2) e 2
//   sessões soltas (X, Y) → 100%, Enquadrar com a Equipe fechada e aberta,
//   lembretes no card, painel da feature (recolhe a Equipe), modal do terminal;
//   depois 8+ sessões em 3 projetos; e as telas fora do mapa (Home, paleta,
//   seletor, Ctrl+K no xterm sem vazar).
// Rodar: POLISH_SHOTS=<dir> npx tsx e2e/scenarios/polish-r4-shots.ts
// r4: cartão >30% sob o dock conta como fora (e abrir o dock reenquadra), fade
// neutro só do lado com cartão fora, raia compacta com "+" e sem prefixo abaixo
// de 0.6, vão de 12px no resumo, enquadrar centraliza com poucas sessões, uma
// frase de "sem saída", handles escondidos, <kbd> nos rodapés, toggle da equipe
// no seletor.

const SHOTS = process.env.POLISH_SHOTS ?? join(tmpdir(), `polish-r4-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0

const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[polish-r4] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

interface RepoRow {
  id: string
  label: string
  path: string
  project_id: string
  project: string
}
const repos = (
  await queryDb<RepoRow>(
    userData,
    `SELECT r.id, r.label, r.path, r.project_id, p.name AS project
       FROM repos r JOIN projects p ON p.id = r.project_id ORDER BY p.position, r.position`,
  )
).filter((r) => r.path?.startsWith('/') && existsSync(r.path))
const labelCount = new Map<string, number>()
for (const r of repos) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)
const unique = repos.filter((r) => labelCount.get(r.label) === 1)
const back = unique.find((r) => unique.filter((x) => x.project_id === r.project_id).length >= 2)
const front = unique.find((r) => r.project_id === back?.project_id && r.id !== back?.id)
const data = unique.find((r) => r.project_id !== back?.project_id)
const third = unique.find(
  (r) => r.project_id !== back?.project_id && r.project_id !== data?.project_id,
)
if (!back || !front || !data || !third) throw new Error('a cópia precisa de repos em 3 projetos')

writeCopyPrefs(userData, {
  claude_command: fake.fakeCliPath('claude'),
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

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

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[polish-r4] timeout esperando: ${label}`)
      return false
    }
    await page.waitForTimeout(300)
  }
}

function mcpAs(sessionId: string) {
  const cfg = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8'))
  const url = new URL(cfg.url)
  url.searchParams.set('s', sessionId)
  const dir = join(fake.root, `mcp-as-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ ...cfg, url: url.toString() }))
  return connectMcp(dir)
}

type Box = { x: number; y: number; width: number; height: number }
const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const featureLane = (featureId: string) =>
  page.locator(`[data-lane-kind="feature"][data-feature-id="${featureId}"]`)
const graph = () =>
  page.evaluate(() => window.api.sessionGraph.get()) as Promise<{
    nodes: Array<{ sessionId: string; featureId?: string | null }>
  }>

async function newSessionFile(before: Set<number>, label: string) {
  let created: FakeSessionEntry | undefined
  await waitFor(label, async () => {
    created = files().find((f) => !before.has(f.data.pid))
    return !!created
  })
  return created
}

async function sessionIdOf(cc: string): Promise<string> {
  // O grafo/snapshot do main é a fonte da PTY viva; o banco pode estar no WAL.
  let id = ''
  await waitFor(`sessions.id de ${cc}`, async () => {
    const live = (await page.evaluate(() => window.api.sessions.listLiveGlobal())) as Array<{
      id: string
      ccSessionId: string
    }>
    id = live.find((s) => s.ccSessionId === cc)?.id ?? ''
    return id !== ''
  })
  return id
}

async function spawnNoTab(repoId: string, name: string) {
  const before = new Set(files().map((f) => f.data.pid))
  const s = (await page.evaluate((a) => window.api.sessions.spawn(a), { repoId, name })) as {
    id: string
    ccSessionId: string
  }
  const file = await newSessionFile(before, `session file de ${name}`)
  if (file) fake.setStatus(file.data.pid, 'busy')
  return { id: s.id, cc: s.ccSessionId, file }
}

async function fit() {
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForTimeout(700)
}

async function cardsUnder(sel: string, ids: string[]): Promise<string[]> {
  if ((await page.locator(sel).count()) === 0) return []
  const over = await page.locator(sel).boundingBox()
  if (!over) return []
  const hit: string[] = []
  for (const id of ids) {
    const b = await card(id).boundingBox()
    if (b && intersects(b, over)) hit.push(id)
  }
  return hit
}

const mapBox = () => page.getByTestId('session-map').boundingBox()
const dockOpen = async () => (await page.locator('[data-testid="crew-dock"][data-overlay]').count()) > 0
async function collapseDock() {
  if (await dockOpen()) await page.getByTitle('Recolher a equipe').click().catch(() => {})
  await page.waitForTimeout(500)
}
async function expandDock() {
  if (!(await dockOpen())) await page.keyboard.press('Control+j')
  await page.waitForTimeout(700)
}
// O card da feature inteiro dentro da área livre do mapa (descontado o que
// cobre a borda direita: dock ou painel).
async function laneInside(sel: string, rightCover: string | null) {
  const lb = await page.locator(sel).boundingBox()
  const mb = await mapBox()
  const cover = rightCover ? await page.locator(rightCover).boundingBox().catch(() => null) : null
  if (!lb || !mb) return { ok: false, detail: 'sem bbox' }
  const right = cover && cover.width > 0 ? Math.min(mb.x + mb.width, cover.x) : mb.x + mb.width
  const ok = lb.x >= mb.x - 1 && lb.x + lb.width <= right + 1
  return { ok, detail: `card ${Math.round(lb.x)}..${Math.round(lb.x + lb.width)} em ${Math.round(mb.x)}..${Math.round(right)}` }
}

// O contador "N fora da vista" tem de bater com a tela: cartões com mais de 30%
// fora da área livre (mapa menos o que cobre a borda direita).
async function offscreenTruth(ids: string[], rightCover: string | null) {
  const mb = await mapBox()
  if (!mb) return { truth: -1, shown: -1 }
  const cover = rightCover ? await page.locator(rightCover).boundingBox().catch(() => null) : null
  const right = cover && cover.width > 0 ? Math.min(mb.x + mb.width, cover.x) : mb.x + mb.width
  const top = (await page.getByTestId('map-top-bar').boundingBox().catch(() => null))?.y ?? mb.y
  let truth = 0
  for (const id of ids) {
    const b = await card(id).boundingBox()
    if (!b) {
      truth++
      continue
    }
    const vw = Math.max(0, Math.min(b.x + b.width, right) - Math.max(b.x, mb.x))
    const vh = Math.max(0, Math.min(b.y + b.height, mb.y + mb.height) - Math.max(b.y, top))
    if (vw * vh < 0.7 * b.width * b.height) truth++
  }
  const label = await page.getByTestId('map-offscreen-count').innerText().catch(() => '')
  const shown = label ? Number(label.match(/\d+/)?.[0] ?? -1) : 0
  return { truth, shown }
}
const zoomNow = () =>
  page.evaluate(() => {
    const vp = document.querySelector('.react-flow__viewport') as HTMLElement | null
    const m = vp?.style.transform.match(/scale\(([\d.]+)\)/)
    return m ? Number(m[1]) : NaN
  })

const overflowShown = () =>
  page
    .locator('[data-testid^="map-overflow-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))

let fatal: unknown = null
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})

  const mcp = await connectMcp(userData)
  const { feature: checkout } = await mcp.call<{ feature: { id: string } }>('feature_create', {
    projectId: back.project_id,
    title: 'Checkout E2E',
    status: 'in-progress',
    repos: [
      { repoId: back.id, branch: 'feat/checkout-e2e' },
      { repoId: front.id, branch: 'feat/checkout-e2e' },
      { repoId: data.id, branch: 'feat/checkout-e2e' },
    ],
  })
  await mcp.call('feature_pulse_set', {
    featureId: checkout.id,
    body: 'Pagamento integrado; falta o estorno no front',
  })
  await page.evaluate((a) => window.api.features.updateSection(a), {
    featureId: checkout.id,
    section: 'Notas fixadas',
    markdown:
      'Estorno só pela API nova de pagamentos: a antiga duplica o lançamento quando o cliente cancela em menos de 5 minutos\n\n---\n\nValores sempre em centavos (inteiro) em todas as camadas, inclusive nos webhooks do provedor',
  })

  // M (mãe) na feature pelo menu; filhas via MCP herdam a feature.
  await goToArea(page, 'projects')
  const M = await spawnNoTab(back.id, 'mae-checkout')
  const X = await spawnNoTab(back.id, 'solta-x')
  const Y = await spawnNoTab(front.id, 'solta-y')
  await page.keyboard.press('Control+Shift+KeyG')
  await waitFor('mapa', async () => page.getByTestId('session-map').isVisible())
  await page
    .getByRole('button', { name: 'Todos os projetos' })
    .click()
    .catch(() => {})
  await waitFor('cartão de M', async () => (await card(M.id).count()) > 0)
  await card(M.id).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mover para feature…' }).click()
  const picker = page.getByTestId('map-feature-picker')
  await picker.waitFor({ state: 'visible', timeout: 10_000 })
  await picker.getByTestId('map-feature-picker-search').fill('Checkout')
  await picker.locator(`[role="option"][data-feature-id="${checkout.id}"]`).click()
  const asM = await mcpAs(M.id)
  const kids: string[] = []
  for (const [k, repo] of [
    ['C1', front],
    ['C2', data],
  ] as const) {
    const before = new Set(files().map((f) => f.data.pid))
    await asM.call('session_handoff', {
      targetRepo: repo.label,
      task: `Parte ${k} do checkout`,
      mode: 'plan',
      force: true,
    })
    const f = await newSessionFile(before, `filha ${k}`)
    if (f) fake.setStatus(f.data.pid, 'busy')
    kids.push(f ? await sessionIdOf(f.data.sessionId) : '')
  }
  const [C1, C2] = kids
  await waitFor('filhas na feature', async () => {
    const g = await graph()
    return [M.id, C1, C2].every(
      (id) => g.nodes.find((n) => n.sessionId === id)?.featureId === checkout.id,
    )
  })
  const lane = featureLane(checkout.id)
  await waitFor(
    '3 cartões no card',
    async () => (await lane.locator('[data-testid="session-card"]').count()) === 3,
  )
  await page.waitForTimeout(1500)

  // ---------- 100% ----------
  await collapseDock()
  await page.getByTestId('map-zoom-100').click()
  await page.waitForTimeout(800)
  await shot('feature-cross-project-100')
  const bm = await card(M.id).boundingBox()
  const b1 = await card(C1).boundingBox()
  const b2 = await card(C2).boundingBox()
  const laneBox = await lane.boundingBox()
  check(
    !!bm && !!b1 && !!b2 && Math.abs(b1.y - bm.y) < 4 && Math.abs(b2.y - bm.y) < 4,
    `filhas de outras lanes alinhadas ao topo com a mãe (dy ${b1 && bm ? Math.round(b1.y - bm.y) : '?'} / ${b2 && bm ? Math.round(b2.y - bm.y) : '?'})`,
  )
  check(
    !!bm && !!laneBox && laneBox.y + laneBox.height - (bm.y + bm.height) < 60,
    `card da feature justo ao conteúdo (sobra ${bm && laneBox ? Math.round(laneBox.y + laneBox.height - (bm.y + bm.height)) : '?'}px abaixo do cartão)`,
  )
  const drawnH = await card(M.id).evaluate((e) => (e as HTMLElement).offsetHeight)
  const slotH = await card(M.id).evaluate(
    (e) => (e.closest('.react-flow__node') as HTMLElement).offsetHeight,
  )
  check(Math.abs(drawnH - slotH) <= 2, `vaga do nó = altura desenhada (${drawnH} vs ${slotH})`)
  const laneLabel = await page
    .locator('[data-testid="lane-repo"]', { has: page.getByTestId('lane-repo-project') })
    .first()
    .innerText()
    .catch(() => '')
  check(
    laneLabel.includes(`${data.project} · ${data.label}`),
    `rótulo da lane alheia: "${laneLabel.split('\n')[0]}"`,
  )
  const reminders = lane.getByTestId('feature-card-reminder')
  const remInfo = await reminders.evaluateAll((els) =>
    els.map((e) => ({
      title: e.getAttribute('title') ?? '',
      w: e.getBoundingClientRect().width,
      color: getComputedStyle(e).borderTopColor,
    })),
  )
  const statusColor = await lane
    .getByTestId('feature-card-status')
    .evaluate((e) => getComputedStyle(e).borderTopColor)
  const pulseBox = await lane.getByTestId('feature-card-pulse').boundingBox()
  const remBox = await lane.getByTestId('feature-card-reminders').boundingBox()
  check(
    remInfo.length === 2 &&
      remInfo.every((r) => r.title.length > 40 && r.w <= 281 && r.color !== statusColor),
    `2 lembretes neutros (borda ≠ status), max 280px, texto inteiro no title (${JSON.stringify(remInfo.map((r) => Math.round(r.w)))})`,
  )
  check(
    !!pulseBox && !!remBox && remBox.y >= pulseBox.y + pulseBox.height - 1,
    'lembretes numa linha própria abaixo do pulso',
  )
  const tailCwd = await card(M.id).getByTestId('card-cwd').innerText().catch(() => '')
  const tailText0 = await card(M.id).getByTestId('card-live-tail').innerText().catch(() => '')
  check(
    tailCwd.startsWith('~/…/') && !/sessao:\s/.test(tailText0),
    `prévia do cartão sem o banner de boot, cwd no pé ("${tailCwd}")`,
  )
  const tails = await page.locator('[data-banner-only]').evaluateAll((els) =>
    els.map((e) => (e.querySelector('p')?.textContent ?? '').trim()),
  )
  check(
    tails.length > 0 && new Set(tails).size === 1,
    `uma frase só para "sem saída" (${JSON.stringify([...new Set(tails)])})`,
  )
  await card(M.id).hover()
  await page.waitForTimeout(300)
  const anchors = await card(M.id)
    .evaluate((e) => {
      const node = e.closest('.react-flow__node')!
      return [...node.querySelectorAll('.react-flow__handle.target')].map(
        (h) => getComputedStyle(h).opacity,
      )
    })
    .catch(() => [] as string[])
  check(
    anchors.length === 4 && anchors.every((o) => o === '0'),
    `âncoras do cartão invisíveis mesmo em hover (${anchors.join(',')})`,
  )
  await page.mouse.move(5, 5)
  const off100 = await page.getByTestId('map-offscreen-count').getAttribute('data-side').catch(() => null)
  const fade100 = await page
    .locator('[data-testid^="map-overflow-"]')
    .evaluateAll((els) =>
      els.map((e) => ({ id: e.getAttribute('data-testid'), bg: getComputedStyle(e).backgroundImage })),
    )
  check(
    fade100.every((f) => off100 && f.id === `map-overflow-${off100}`) &&
      fade100.every((f) => !/rgba?\((1[3-9]\d|2\d\d), ?\d+, ?2[0-5]\d/.test(f.bg)),
    `fade só do lado com cartão fora (${off100 ?? 'nenhum'}), neutro: ${JSON.stringify(fade100.map((f) => f.id))}`,
  )
  const header = await lane.getByTestId('feature-card-header').boundingBox()
  if (header)
    await page.screenshot({
      path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-card-lembretes.png`),
      clip: {
        x: header.x - 8,
        y: header.y - 8,
        width: Math.min(header.width + 16, 1400),
        height: 120,
      },
    })

  // ---------- Enquadrar com a Equipe fechada e aberta ----------
  const laneSel = `[data-lane-kind="feature"][data-feature-id="${checkout.id}"]`
  check(!(await dockOpen()), 'Equipe fechada antes do 1º enquadrar')
  await fit()
  await shot('enquadrar-equipe-fechada')
  const closedFit = await laneInside(laneSel, null)
  check(closedFit.ok, `Enquadrar (Equipe fechada): feature inteira na vista (${closedFit.detail})`)
  const ids = [M.id, C1, C2, X.id, Y.id]
  {
    const mb0 = await mapBox()
    const bar = await page.getByTestId('map-top-bar').boundingBox()
    const tops = await page.locator('[data-lane-kind]').evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })),
    )
    const top = Math.min(...tops.map((t) => t.top))
    const bottom = Math.max(...tops.map((t) => t.bottom))
    const freeTop = bar ? bar.y + bar.height : (mb0?.y ?? 0)
    const freeBottom = mb0 ? mb0.y + mb0.height : 0
    const above = top - freeTop
    const below = freeBottom - bottom
    check(
      Math.abs(above - below) < 0.25 * (freeBottom - freeTop),
      `enquadrar com 5 sessões centraliza na vertical (acima ${Math.round(above)}px, abaixo ${Math.round(below)}px)`,
    )
  }
  const off1 = await offscreenTruth(ids, null)
  check(off1.truth === off1.shown, `contador "fora da vista" bate com a tela, Equipe fechada (tela ${off1.truth}, aviso ${off1.shown})`)
  // As raias de repo são nós irmãos do card no DOM do xyflow (não filhas).
  const repoLanes = await page.locator(`.react-flow__node[data-id^="lane:f:${checkout.id}:r:"]`).evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().height),
  )
  const cardHs = await Promise.all([M.id, C1, C2].map(async (id) => (await card(id).boundingBox())?.height ?? 0))
  const z1 = await zoomNow()
  const details = await page
    .locator('[data-testid="session-card"]')
    .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-detail')))])
  check(details.length === 1, `uma densidade só no mapa (${details.join(',')} a ${z1.toFixed(2)})`)
  check(
    Math.max(...repoLanes) - Math.max(...cardHs) >= -2 &&
      Math.max(...repoLanes) - Math.max(...cardHs) < 70 * Math.max(z1, 0.5),
    `raia justa ao cartão na densidade atual (zoom ${z1.toFixed(2)}; raia ${Math.round(Math.max(...repoLanes))}px, cartão ${Math.round(Math.max(...cardHs))}px)`,
  )
  // Partindo de 100% (cartões cheios até a borda direita): abrir a Equipe cobre
  // a 3ª raia e o mapa tem de se reenquadrar sozinho, sem fechar o dock.
  await page.getByTestId('map-zoom-100').click()
  await page.waitForTimeout(600)
  await expandDock()
  await page.waitForTimeout(600)
  check(await dockOpen(), 'Equipe aberta sobre o mapa')
  await shot('equipe-aberta-auto-enquadra')
  const autoOff = await offscreenTruth(ids, '[data-testid="crew-dock"][data-overlay]')
  const autoUnder = await cardsUnder('[data-testid="crew-dock"][data-overlay]', [M.id, C1, C2])
  check(
    autoOff.truth === autoOff.shown && autoUnder.length === 0,
    `abrir a Equipe reenquadra: nenhum cartão da feature sob o dock (${autoUnder.length}); contador = tela (${autoOff.truth} = ${autoOff.shown})`,
  )
  await fit()
  await shot('enquadrar-equipe-aberta')
  const stillOpen = await dockOpen()
  const openFit = await laneInside(laneSel, stillOpen ? '[data-testid="crew-dock"][data-overlay]' : null)
  check(
    openFit.ok,
    `Enquadrar (Equipe aberta): feature inteira fora do dock (${stillOpen ? 'dock aberto' : 'dock recolhido pelo enquadrar'}; ${openFit.detail})`,
  )
  const under = await cardsUnder('[data-testid="crew-dock"][data-overlay]', [M.id, C1, C2])
  check(under.length === 0, `nenhuma raia da feature embaixo do dock (${under.length})`)
  await page.waitForTimeout(400)
  const off2 = await offscreenTruth(ids, (await dockOpen()) ? '[data-testid="crew-dock"][data-overlay]' : null)
  check(off2.truth === off2.shown, `contador bate com a tela depois do enquadrar com a Equipe (tela ${off2.truth}, aviso ${off2.shown})`)
  const mbx = await mapBox()
  const strays = await page.locator('[data-testid="map-overflow-right"]').evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().right),
  )
  const dockLeft = (await dockOpen())
    ? ((await page.locator('[data-testid="crew-dock"][data-overlay]').boundingBox())?.x ?? 0)
    : 0
  check(
    strays.every((r) => !mbx || Math.abs(r - (dockLeft || mbx.x + mbx.width)) < 12),
    `sombra da borda direita encostada na borda real (sem faixa no meio do mapa): ${JSON.stringify(strays.map(Math.round))}`,
  )

  // ---------- Painel da feature recolhe a Equipe ----------
  await lane.getByTestId('feature-card-header').click()
  await page.getByTestId('feature-panel').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)
  const dockOverlay = await page.locator('[data-testid="crew-dock"][data-overlay]').count()
  check(dockOverlay === 0, 'abrir o painel da feature recolheu a Equipe para a trilha')
  check(
    (await page.getByTestId('feature-panel-tab-state').getAttribute('aria-selected')) === 'true',
    'painel abre na aba "Estado"',
  )
  const tabs = page.locator('[data-testid="feature-panel"] [role="tablist"]')
  const tabOverflow = await tabs.evaluate((e) => e.scrollWidth - e.clientWidth)
  check(
    (await tabs.getByRole('tab').count()) === 4 && tabOverflow <= 0,
    `4 abas sem transbordo (overflow ${tabOverflow}px)`,
  )
  const counts = await page.getByTestId('feature-panel-state-counts').innerText().catch(() => '')
  const rulesN = await page.locator('[data-testid="feature-panel-state-rules"] li').count()
  check(
    /3\s*trabalhando/.test(counts.replace(/\n/g, ' ')) && rulesN >= 2,
    `Estado com dados: "${counts.replace(/\s+/g, ' ')}", ${rulesN} regras fixadas`,
  )
  // Sem clicar no Enquadrar: o mapa se reenquadra sozinho ao abrir o painel.
  const panelFit = await laneInside(laneSel, '[data-testid="feature-panel"]')
  await shot('painel-da-feature')
  // r3: no resumo o cartão estreita (BRIEF_W) e o painel tem 380px: as 3 raias cabem a 0.6.
  // o começo da feature na vista e a sombra/contador avisam o resto.
  const panelHints = await overflowShown()
  const panelOff = await page.getByTestId('map-offscreen-count').innerText().catch(() => '')
  check(panelFit.ok, `abrir o painel reenquadra e a feature inteira cabe ao lado dele (${panelFit.detail}; aviso: "${panelOff}"; dicas ${panelHints.join(',')})`)
  const cardStatus = await lane.getByTestId('feature-card-status').innerText()
  const panelStatus = await page.getByTestId('feature-panel-status').innerText().catch(() => '')
  const liveIn = await page
    .getByTestId('liveness-chip')
    .evaluate((e) => e.closest('h3')?.textContent ?? '')
    .catch(() => '')
  check(
    panelStatus === cardStatus && /Pulso/i.test(liveIn),
    `um status só: painel "${panelStatus}" = card "${cardStatus}"; vitalidade junto do Pulso ("${liveIn}")`,
  )
  const pulseWhen = await page
    .locator('[data-testid="feature-panel"] [title*="2026"]')
    .first()
    .evaluate((e) => ({ text: e.textContent ?? '', font: getComputedStyle(e).fontFamily }))
    .catch(() => ({ text: '', font: '' }))
  check(
    /^(agora|há )/.test(pulseWhen.text) && !/mono/i.test(pulseWhen.font),
    `hora do pulso relativa e em sans ("${pulseWhen.text}")`,
  )
  const zPanel = await zoomNow()
  const repoLaneSel = `.react-flow__node[data-id^="lane:f:${checkout.id}:r:"]`
  const btns = await page.locator(`${repoLaneSel} [data-testid="lane-new-session"]`).evaluateAll((els) =>
    els.map((e) => ({ compact: e.hasAttribute('data-compact'), text: (e.textContent ?? '').trim() })),
  )
  const prefixN = await page.locator(`${repoLaneSel} [data-testid="lane-repo-project"]`).count()
  check(
    btns.length === 3 && btns.every((b) => b.compact && b.text === ''),
    `raias no resumo: "+ Nova sessão" vira só "+" (${JSON.stringify(btns)} a ${zPanel.toFixed(2)})`,
  )
  check(
    zPanel >= 0.6 || prefixN === 0,
    `abaixo de 0.6 o prefixo do projeto sai da raia (zoom ${zPanel.toFixed(2)}, prefixos ${prefixN})`,
  )
  const repoNames = await page.locator(`${repoLaneSel} [data-testid="lane-repo"]`).evaluateAll((els) =>
    els.map((e) => {
      const s = e.querySelector('.text-\\[var\\(--color-text\\)\\]') as HTMLElement | null
      const outer = s?.parentElement as HTMLElement | null
      return outer ? outer.scrollWidth <= outer.clientWidth + 1 : false
    }),
  )
  console.log('[polish-r4] nomes de repo inteiros com o painel:', JSON.stringify(repoNames))
  const underPanel = await cardsUnder('[data-testid="feature-panel"]', ids)
  const hints2 = await overflowShown()
  check(
    underPanel.length === 0 || hints2.includes('map-overflow-right'),
    `painel aberto: Enquadrar desconta o painel ou avisa o transbordo (sob o painel: ${underPanel.length}, dicas: ${hints2.join(',') || 'nenhuma'})`,
  )
  await page.keyboard.press('Control+j')
  await page.waitForTimeout(600)
  check(
    (await page.getByTestId('feature-panel').count()) === 0,
    'expandir a Equipe fecha o painel da feature',
  )
  await page.keyboard.press('Escape')

  // ---------- Modal do terminal + Ctrl+K não vaza pro PTY ----------
  // O enquadrar pode ter deixado os cartões no resumo (zoom < 0.75): a 100% o
  // botão de terminal do cartão volta.
  await page.getByTestId('map-zoom-100').click()
  await page.waitForTimeout(600)
  await card(M.id).getByTestId('card-interact').click()
  const liftT = page.locator('[role="dialog"][data-peek-lift][data-peek-mode="terminal"]')
  await liftT.waitFor({ state: 'visible', timeout: 10_000 })
  await liftT
    .locator('.xterm')
    .click()
    .catch(() => {})
  await page.keyboard.type('rascunho')
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(600)
  const paletteOpen = await page.getByPlaceholder(/buscar|Buscar|comando/i).first().isVisible().catch(() => false)
  console.log('[polish-r4] paleta aberta sobre a modal após Ctrl+K:', paletteOpen)
  // Fecha a paleta pelo próprio input dela (o Esc não pode cair no xterm).
  if (paletteOpen) await page.getByPlaceholder(/buscar|Buscar|comando/i).first().press('Escape')
  await page.waitForTimeout(300)
  await liftT
    .locator('.xterm')
    .click()
    .catch(() => {})
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  await shot('modal-terminal')
  const liftText = await liftT.innerText()
  check(!/trabalhando há/.test(liftText), 'status só no header da modal (sem "trabalhando há" no rodapé)')
  const headerH = (await liftT.getByTestId('peek-header').boundingBox())?.height ?? 999
  const meta = await liftT.getByTestId('peek-header-meta').innerText().catch(() => '')
  check(headerH <= 42 && meta.includes('/'), `header da modal numa linha (${Math.round(headerH)}px: "${meta}")`)
  const hintsText = (await liftT.getByTestId('peek-lift-hints').getAttribute('aria-label').catch(() => '')) ?? ''
  const kbds = await liftT.getByTestId('peek-lift-hints').locator('kbd').count()
  const kbdColor = await liftT
    .getByTestId('peek-lift-hints')
    .evaluate((e) => getComputedStyle(e).color)
    .catch(() => '')
  check(
    hintsText.includes('Alt+, / Alt+. trocar') && hintsText.includes('Shift+Esc fecha') && kbds >= 4,
    `dicas da modal com <kbd> (${kbds} teclas, cor ${kbdColor}): "${hintsText}"`,
  )
  check(
    (await liftT.getByRole('button', { name: 'Inserir', exact: true }).count()) === 0 &&
      (await liftT.getByRole('button', { name: 'Inserir sem enviar' }).count()) === 1,
    '"Inserir" vira ícone com tooltip ao lado do Enviar',
  )
  const cli = fake.readCliLog('claude')
  console.log('[polish-r4] stdin do stub:', JSON.stringify(cli.split('\n').filter((l) => l.includes('stdin:')).slice(-3)))
  check(
    cli.includes('stdin: rascunho') && !cli.includes('\\x0b') && !cli.includes('\u000b'),
    'Ctrl+K com o xterm focado não chega ao PTY (rascunho intacto)',
  )
  await page.keyboard.press('Shift+Escape')
  await page.waitForTimeout(500)

  // ---------- 8+ sessões, 3 projetos ----------
  for (const [i, r] of [back, front, data, third, third, data].entries())
    await spawnNoTab(r.id, `extra-${i + 1}`)
  await waitFor('11 cartões', async () => (await page.getByTestId('session-card').count()) >= 11)
  await page.waitForTimeout(1500)
  // O cruzamento para 7+ cartões já reenquadra sozinho (visão geral).
  await shot('mapa-muitas-sessoes-auto')
  await fit()
  await shot('mapa-muitas-sessoes')
  {
    const z = await zoomNow()
    const byLane = await page.locator('.react-flow__node-session').evaluateAll((els) => {
      const m = new Map<string, Array<{ top: number; bottom: number }>>()
      for (const e of els) {
        const r = e.getBoundingClientRect()
        const key = `${Math.round(r.left)}`
        m.set(key, [...(m.get(key) ?? []), { top: r.top, bottom: r.bottom }])
      }
      const out: number[] = []
      for (const list of m.values()) {
        list.sort((a, b) => a.top - b.top)
        for (let i = 1; i < list.length; i++) out.push(list[i].top - list[i - 1].bottom)
      }
      return out
    })
    // Só vizinhos da mesma raia (entre linhas de cards o vão é outro).
    const flowGaps = byLane.map((g) => Math.round(g / z)).filter((g) => g < 60)
    check(
      flowGaps.length > 0 && flowGaps.every((g) => Math.abs(g - 12) <= 2),
      `resumo: vão de 12px entre cartões da mesma raia (${JSON.stringify(flowGaps)} a ${z.toFixed(2)})`,
    )
  }
  const projectsOnMap = await page.locator('[data-lane-kind]').count()
  check(
    (await page.getByTestId('session-card').count()) >= 8 && projectsOnMap >= 3,
    `8+ cartões em 3+ cards (${projectsOnMap} cards)`,
  )
  const mb = await mapBox()
  const boxes = await page.getByTestId('session-card').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }),
  )
  const offLeft = boxes.filter((b) => mb && b.x < mb.x - 1).length
  const inView = boxes.filter(
    (b) => mb && b.x >= mb.x - 1 && b.x + b.w <= mb.x + mb.width + 1 && b.y >= mb.y - 1 && b.y + b.h <= mb.y + mb.height + 1,
  ).length
  const offCount = await page.getByTestId('map-offscreen-count').innerText().catch(() => '')
  check(offLeft === 0, `nenhum cartão à esquerda do canvas (${offLeft})`)
  const zMany = await zoomNow()
  check(
    inView === boxes.length && zMany >= 0.7 && !offCount,
    `visão geral: ${inView}/${boxes.length} cartões inteiros na vista a ${zMany.toFixed(2)}${offCount ? ` + "${offCount}"` : ''}`,
  )
  const orphan = await page.locator('[data-lane-kind="project"]').evaluateAll((els) =>
    els.map((e) => {
      const h = e.querySelector('[data-testid="lane-project-header"]')!.getBoundingClientRect()
      const firstRepo = (e.closest('.react-flow__node') as HTMLElement).id
      return { hb: h.bottom, firstRepo, bullet: !!e.querySelector('.rounded-full.h-2') }
    }),
  )
  const repoTops = await page.locator('.react-flow__node-lane').evaluateAll((els) =>
    els.map((e) => ({ id: e.getAttribute('data-id') ?? '', top: e.getBoundingClientRect().top })),
  )
  const projIds = await page
    .locator('.react-flow__node-lane:has([data-lane-kind="project"])')
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect()
        const h = e.querySelector('[data-testid="lane-project-header"]')!.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, hb: h.bottom }
      }),
    )
  const repoBoxes = await page.locator('[data-testid="lane-repo"]').evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
  )
  const overlaps = projIds.filter((p) =>
    repoBoxes.some((r) => r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom && r.top < p.hb - 1),
  ).length
  check(projIds.length > 0 && overlaps === 0 && orphan.every((o) => !o.bullet), `"Sem feature": cabeçalho acima das raias, sem bullet (${projIds.length} grupos, ${overlaps} sobrepostos; ${repoTops.length} lanes)`)
  const mm = await page.locator('.react-flow__minimap').boundingBox()
  check(!!mm && mm.height <= 142, `minimapa na proporção do conteúdo (${mm ? `${Math.round(mm.width)}x${Math.round(mm.height)}` : '—'})`)
  check((await page.locator('.react-flow__minimap').count()) === 1, 'minimapa com 7+ cartões')
  const strip = page.getByTestId('session-strip-scroll')
  const stripBar = await strip.evaluate((e) => e.offsetHeight - e.clientHeight).catch(() => -1)
  const more = await page.getByTestId('session-strip-more').innerText().catch(() => '')
  check(stripBar === 0, `barra de abas sem scrollbar visível (${stripBar}px)`)
  check(/\+\d+/.test(more), `overflow da barra vira "${more.trim()}"`)

  // ---------- Fora do mapa ----------
  await page.keyboard.press('Control+k')
  await page
    .getByPlaceholder(/buscar|Buscar|comando/i)
    .first()
    .fill('Checkout E2E')
    .catch(() => {})
  await page.waitForTimeout(800)
  await shot('paleta-feature')
  const palText = await page.locator('body').innerText()
  check(
    /Features/i.test(palText) && palText.includes('Checkout E2E'),
    'paleta acha a feature "Checkout E2E"',
  )
  check(/3 repos/.test(palText), 'item da feature na paleta diz "3 repos" no lugar do projeto dono')
  const palKbd = await page.locator('[data-modal-overlay] kbd, kbd').count()
  check(palKbd >= 3, `rodapé da paleta com <kbd> (${palKbd})`)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Shift+KeyA')
  await page.waitForTimeout(800)
  await shot('seletor')
  const sw = await page.getByTestId('switcher-crew-count').innerText().catch(() => '')
  check(/\+2 na equipe/.test(sw), `seletor diz a diferença para o mapa ("${sw}")`)
  const swKbd = await page.locator('kbd').count()
  check(swKbd >= 4, `rodapé do seletor com o mesmo <kbd> (${swKbd})`)
  await page.getByTestId('switcher-crew-count').click()
  await page.waitForTimeout(400)
  await shot('seletor-com-equipe')
  const crewRows = await page.getByTestId('switcher-row-crew').count()
  check(
    crewRows === 2 &&
      (await page.getByTestId('switcher-crew-count').getAttribute('aria-pressed')) === 'true',
    `"+2 na equipe" é um toggle: 2 filhas entram na lista marcadas (${crewRows})`,
  )
  const chips = await page.locator('[data-modal-overlay] li').filter({ hasText: 'Checkout E2E' }).count()
  check(chips >= 3, `com a equipe na lista, as 3 sessões da Checkout E2E aparecem com o chip (${chips})`)
  await page.keyboard.press('Escape')
  await page
    .getByTitle('Home', { exact: true })
    .first()
    .click()
    .catch(() => {})
  await page.waitForTimeout(1200)
  await shot('home')
  const hc = await page.getByTestId('home-sessions-crew').innerText().catch(() => '')
  check(/\+2 na equipe/.test(hc), `"Sessões agora" diz quantas estão só na equipe ("${hc}")`)
  const titles = await page.getByTestId('task-row-title').count()
  console.log('[polish-r4] tasks com título em linha própria na Home:', titles)
} catch (e) {
  fatal = e
  console.log('[polish-r4] FATAL', e)
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
console.log(
  '[polish-r4] erros de console:',
  consoleErrors.length ? consoleErrors.join(' | ') : 'nenhum',
)
const failed = results.filter((r) => !r.ok)
console.log(
  `[polish-r4] ${results.length - failed.length}/${results.length} PASS${fatal ? ' (FATAL)' : ''}`,
)
process.exit(failed.length || fatal ? 1 : 0)
