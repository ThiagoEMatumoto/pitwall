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
// Rodar: POLISH_SHOTS=<dir> npx tsx e2e/scenarios/polish-r5-shots.ts
// r5: o "N fora da vista" medido contra a tela (minimapa como canto, não faixa),
// pill longe das bordas de frames, barra do mapa encolhe com o painel, enquadrar
// com painel no topo a >= 0.7, lembretes em linha só a 100% (chip abaixo),
// modal com selo MÃE/feature/bastão, contagem única com a Equipe.
// r4: cartão >30% sob o dock conta como fora (e abrir o dock reenquadra), fade
// neutro só do lado com cartão fora, raia compacta com "+" e sem prefixo abaixo
// de 0.6, vão de 12px no resumo, enquadrar centraliza com poucas sessões, uma
// frase de "sem saída", handles escondidos, <kbd> nos rodapés, toggle da equipe
// no seletor.

const SHOTS = process.env.POLISH_SHOTS ?? join(tmpdir(), `polish-r5-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0

const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[polish-r5] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
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
      console.log(`[polish-r5] timeout esperando: ${label}`)
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
const dockOpen = async () =>
  (await page.locator('[data-testid="crew-dock"][data-overlay]').count()) > 0
async function collapseDock() {
  if (await dockOpen())
    await page
      .getByTitle('Recolher a equipe')
      .click()
      .catch(() => {})
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
  const cover = rightCover
    ? await page
        .locator(rightCover)
        .boundingBox()
        .catch(() => null)
    : null
  if (!lb || !mb) return { ok: false, detail: 'sem bbox' }
  const right = cover && cover.width > 0 ? Math.min(mb.x + mb.width, cover.x) : mb.x + mb.width
  const ok = lb.x >= mb.x - 1 && lb.x + lb.width <= right + 1
  return {
    ok,
    detail: `card ${Math.round(lb.x)}..${Math.round(lb.x + lb.width)} em ${Math.round(mb.x)}..${Math.round(right)}`,
  }
}

// O contador "N fora da vista" tem de bater com a tela: cartões com mais de 30%
// fora da área livre (mapa menos o que cobre a borda direita).
async function offscreenTruth(ids: string[], rightCover: string | null) {
  const mb = await mapBox()
  if (!mb) return { truth: -1, shown: -1 }
  const cover = rightCover
    ? await page
        .locator(rightCover)
        .boundingBox()
        .catch(() => null)
    : null
  const right = cover && cover.width > 0 ? Math.min(mb.x + mb.width, cover.x) : mb.x + mb.width
  const barBox = await page
    .getByTestId('map-top-bar')
    .boundingBox()
    .catch(() => null)
  const top = barBox ? barBox.y + barBox.height : mb.y
  const mm = await page
    .locator('.react-flow__minimap')
    .boundingBox()
    .catch(() => null)
  let truth = 0
  for (const id of ids) {
    const b = await card(id).boundingBox()
    if (!b) {
      truth++
      continue
    }
    const vw = Math.max(0, Math.min(b.x + b.width, right) - Math.max(b.x, mb.x))
    const vh = Math.max(0, Math.min(b.y + b.height, mb.y + mb.height) - Math.max(b.y, top))
    // O minimapa cobre só o canto: desconta a interseção real com ele.
    let covered = 0
    if (mm && vw && vh) {
      const l = Math.max(b.x, mb.x)
      const t = Math.max(b.y, top)
      const r = Math.min(b.x + b.width, right)
      const bt = Math.min(b.y + b.height, mb.y + mb.height)
      const ow = Math.min(r, mm.x + mm.width) - Math.max(l, mm.x)
      const oh = Math.min(bt, mm.y + mm.height) - Math.max(t, mm.y)
      if (ow > 0 && oh > 0) covered = ow * oh
    }
    if (vw * vh - covered < 0.7 * b.width * b.height) truth++
  }
  // data-count: com 1 só o pill mostra o nome do cartão (e o nome pode ter dígitos).
  const label = await page
    .getByTestId('map-offscreen-count')
    .getAttribute('data-count')
    .catch(() => null)
  const shown = label ? Number(label) : 0
  return { truth, shown }
}
// O pill não cruza (nem encosta, 6px) a borda de nenhum frame do mapa.
async function pillClearOfFrames(): Promise<{ ok: boolean; detail: string }> {
  const pill = await page
    .getByTestId('map-offscreen-count')
    .boundingBox()
    .catch(() => null)
  if (!pill) return { ok: true, detail: 'sem pill' }
  const frames = await page
    .locator('.react-flow__node-lane')
    .evaluateAll((els) =>
      els
        .map((e) => e.getBoundingClientRect())
        .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
    )
  const s = 6
  const bad = frames.filter((f) => {
    const hitOuter =
      pill.x < f.x + f.w + s &&
      pill.x + pill.width > f.x - s &&
      pill.y < f.y + f.h + s &&
      pill.y + pill.height > f.y - s
    const inside =
      pill.x >= f.x + s &&
      pill.x + pill.width <= f.x + f.w - s &&
      pill.y >= f.y + s &&
      pill.y + pill.height <= f.y + f.h - s
    return hitOuter && !inside
  })
  return {
    ok: bad.length === 0,
    detail: `pill ${Math.round(pill.x)},${Math.round(pill.y)} ${Math.round(pill.width)}w; ${bad.length} bordas cruzadas`,
  }
}

// r3: o pill nunca cobre um cartão À VISTA (>= 70% dentro da área livre) nem o
// cabeçalho de uma lane — no print 07 ele apagava o nome do otavio.
async function pillClearOfCards(
  rightCover: string | null,
): Promise<{ ok: boolean; detail: string }> {
  const pill = await page
    .getByTestId('map-offscreen-count')
    .boundingBox()
    .catch(() => null)
  if (!pill) return { ok: true, detail: 'sem pill' }
  const mb = await mapBox()
  const cover = rightCover
    ? await page
        .locator(rightCover)
        .boundingBox()
        .catch(() => null)
    : null
  const right = mb
    ? cover && cover.width > 0
      ? Math.min(mb.x + mb.width, cover.x)
      : mb.x + mb.width
    : 0
  const rects = await page
    .locator('[data-testid="session-card"], [data-testid="lane-repo"]')
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect()
        // Da raia, só a faixa do cabeçalho (o nome do repo); o corpo dela pode ser coberto.
        const head = e.getAttribute('data-testid') === 'lane-repo'
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: head ? Math.min(r.height, 24) : r.height,
          name: (e.textContent ?? '').slice(0, 24),
        }
      }),
    )
  const hit = rects.filter((r) => {
    const vis = Math.max(0, Math.min(r.x + r.w, right) - Math.max(r.x, mb?.x ?? 0))
    if (vis < 0.7 * r.w) return false
    return (
      pill.x < r.x + r.w &&
      pill.x + pill.width > r.x &&
      pill.y < r.y + r.h &&
      pill.y + pill.height > r.y
    )
  })
  return {
    ok: hit.length === 0,
    detail: `pill ${Math.round(pill.x)},${Math.round(pill.y)} ${Math.round(pill.width)}w; cobre ${hit.map((h) => h.name).join(' | ') || 'nada'}`,
  }
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
    // Prefixo e nome são itens flex (o innerText os separa por quebra de linha).
    laneLabel.replace(/\s+/g, ' ').includes(`${data.project} · ${data.label}`),
    `rótulo da lane alheia: "${laneLabel.replace(/\s+/g, ' ').trim()}"`,
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
      remInfo.every((r) => r.title.length > 40 && r.w <= 341 && r.color !== statusColor),
    `2 lembretes neutros (borda ≠ status), max 340px, texto inteiro no title (${JSON.stringify(remInfo.map((r) => Math.round(r.w)))})`,
  )
  const firstRepoTop = await page
    .locator(`.react-flow__node[data-id^="lane:f:${checkout.id}:r:"]`)
    .evaluateAll((els) => Math.min(...els.map((e) => e.getBoundingClientRect().top)))
  const remGap = remBox ? firstRepoTop - (remBox.y + remBox.height) : -1
  check(
    remGap >= 6,
    `a 100%: lembretes com respiro até o cabeçalho das raias (${Math.round(remGap)}px)`,
  )
  // Rodada 2: o pill fica na faixa do cartão oculto (pode sobrepor um frame,
  // com fundo opaco); sem cartão na faixa, continua longe das bordas.
  {
    const pill = await page
      .getByTestId('map-offscreen-count')
      .boundingBox()
      .catch(() => null)
    const bg = await page
      .getByTestId('map-offscreen-count')
      .evaluate((e) => getComputedStyle(e).backgroundColor)
      .catch(() => '')
    const boxes = (await Promise.all([M.id, C1, C2].map((id) => card(id).boundingBox()))).filter(
      (b): b is NonNullable<typeof b> => !!b,
    )
    const pc = pill ? pill.y + pill.height / 2 : -1
    const inBand = boxes.some((b) => pc >= b.y - 4 && pc <= b.y + b.height + 4)
    const clear = await pillClearOfFrames()
    // r3: sem vaga na faixa (o cartão vizinho à vista nela), o pill vai ao ponto
    // livre mais perto — pode cruzar a borda de um frame, nunca cobrir um nome.
    const clear2 = await pillClearOfCards(null)
    check(
      !pill || (inBand && !/rgba\(.*, 0(\.\d+)?\)$/.test(bg)) || clear.ok || clear2.ok,
      `a 100%: pill na faixa do cartão oculto, longe das bordas, ou num ponto livre (${clear.detail})`,
    )
    check(clear2.ok, `a 100%: pill não cobre cartão à vista nem cabeçalho (${clear2.detail})`)
  }
  const fadeW = await page
    .locator('[data-testid="map-overflow-right"]')
    .evaluate((e) => e.getBoundingClientRect().width)
    .catch(() => 0)
  const sideNow = await page
    .getByTestId('map-offscreen-count')
    .getAttribute('data-side')
    .catch(() => null)
  check(
    sideNow !== 'right' || fadeW >= 50,
    `a 100%: sombra da borda com o lado cortado (${Math.round(fadeW)}px)`,
  )
  // Zoom menor: a linha some e vira o chip "N lembretes" na linha do título.
  await page.locator('.react-flow__controls-zoomout').click()
  await page.waitForTimeout(600)
  const zOut = await zoomNow()
  const chipTxt = await lane
    .getByTestId('feature-card-reminders-chip')
    .innerText()
    .catch(() => '')
  const lineN = await lane.getByTestId('feature-card-reminders').count()
  const headerBottom = await lane
    .getByTestId('feature-card-pulse')
    .evaluate((e) => e.getBoundingClientRect().bottom)
    .catch(() => 0)
  const repoTopOut = await page
    .locator(`.react-flow__node[data-id^="lane:f:${checkout.id}:r:"]`)
    .evaluateAll((els) => Math.min(...els.map((e) => e.getBoundingClientRect().top)))
  check(
    /2 lembretes/.test(chipTxt) && lineN === 0 && repoTopOut - headerBottom >= 4,
    `a ${zOut.toFixed(2)}: chip "${chipTxt}" na linha do título, sem a 3ª linha, respiro ${Math.round(repoTopOut - headerBottom)}px`,
  )
  {
    // Rodada 2: o chip contra-escala (>= 11px na tela) e usa a cor de aviso.
    const chip = await lane
      .getByTestId('feature-card-reminders-chip')
      .evaluate((e) => ({
        px: parseFloat(getComputedStyle(e).fontSize),
        color: getComputedStyle(e).color,
      }))
      .catch(() => ({ px: 0, color: '' }))
    check(
      chip.px * zOut >= 11,
      `chip de lembretes legível a ${zOut.toFixed(2)}: ${(chip.px * zOut).toFixed(1)}px na tela, cor ${chip.color}`,
    )
  }
  const hdrOut = await lane.getByTestId('feature-card-header').boundingBox()
  if (hdrOut)
    await page.screenshot({
      path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-card-lembretes-chip.png`),
      clip: {
        x: hdrOut.x - 8,
        y: hdrOut.y - 8,
        width: Math.min(hdrOut.width + 16, 1400),
        height: 110,
      },
    })
  await page.getByTestId('map-zoom-100').click()
  await page.waitForTimeout(700)
  check(
    !!pulseBox && !!remBox && remBox.y >= pulseBox.y + pulseBox.height - 1,
    'lembretes numa linha própria abaixo do pulso',
  )
  const tailCwd = await card(M.id)
    .getByTestId('card-cwd')
    .innerText()
    .catch(() => '')
  const tailText0 = await card(M.id)
    .getByTestId('card-live-tail')
    .innerText()
    .catch(() => '')
  check(
    tailCwd.startsWith('~/…/') && !/sessao:\s/.test(tailText0),
    `prévia do cartão sem o banner de boot, cwd no pé ("${tailCwd}")`,
  )
  const tails = await page
    .locator('[data-banner-only]')
    .evaluateAll((els) => els.map((e) => (e.querySelector('p')?.textContent ?? '').trim()))
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
  const off100 = await page
    .getByTestId('map-offscreen-count')
    .getAttribute('data-side')
    .catch(() => null)
  const fade100 = await page.locator('[data-testid^="map-overflow-"]').evaluateAll((els) =>
    els.map((e) => ({
      id: e.getAttribute('data-testid'),
      bg: getComputedStyle(e).backgroundImage,
    })),
  )
  check(
    fade100.every((f) => off100 && f.id === `map-overflow-${off100}`) &&
      fade100.every((f) => !/rgba?\((1[3-9]\d|2\d\d), ?\d+, ?2[0-5]\d/.test(f.bg)),
    `fade só do lado com cartão fora (${off100 ?? 'nenhum'}), neutro: ${JSON.stringify(fade100.map((f) => f.id))}`,
  )
  const offT100 = await offscreenTruth([M.id, C1, C2, X.id, Y.id], null)
  check(
    offT100.truth === offT100.shown,
    `a 100%: contador = tela (tela ${offT100.truth}, aviso ${offT100.shown})`,
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
  {
    // r4: mãe → filhas em leque pelo barramento do pé do card (borda inferior).
    const rects = async (id: string) => card(id).boundingBox()
    const [rm, r1, r2] = await Promise.all([rects(M.id), rects(C1), rects(C2)])
    const paths = await page
      .locator('.react-flow__edge[data-id^="e:h:"] path.react-flow__edge-path')
      .evaluateAll((els) =>
        els.map((el) => {
          const p = el as SVGPathElement
          const m = p.getScreenCTM()!
          const len = p.getTotalLength()
          // Sem função nomeada aqui dentro: o tsx injeta __name, que não existe na página.
          const pts = Array.from({ length: 82 }, (_, i) => {
            const q = p.getPointAtLength((len * i) / 81)
            return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f }
          })
          return { start: pts[0], end: pts[81], samples: pts.slice(1, 81) }
        }),
      )
    const nearBottom = (pt: { x: number; y: number }, r: { x: number; y: number; width: number; height: number } | null) =>
      !!r && Math.abs(pt.y - (r.y + r.height)) <= 6 && Math.abs(pt.x - (r.x + r.width / 2)) <= 6
    const toC1 = paths.find((p) => nearBottom(p.end, r1))
    const toC2 = paths.find((p) => nearBottom(p.end, r2))
    const inside = (pt: { x: number; y: number }, r: { x: number; y: number; width: number; height: number } | null) =>
      !!r && pt.x > r.x + 2 && pt.x < r.x + r.width - 2 && pt.y > r.y + 2 && pt.y < r.y + r.height - 2
    check(
      paths.length === 2 && !!toC1 && !!toC2 && paths.every((p) => nearBottom(p.start, rm)),
      `mãe → 2 filhas: saem do pé da mãe e entram pelo pé de cada filha (${JSON.stringify(paths.map((p) => ({ s: p.start, e: p.end })))})`,
    )
    check(
      !!toC2 && !toC2.samples.some((pt) => inside(pt, r1) || inside(pt, rm)),
      'o fio da 2ª filha não passa por baixo do cartão da 1ª (nem da mãe)',
    )
  }
  {
    // r4: o cartão resumo diz o que a filha faz (o propósito, sem saída ainda).
    const c1Text = await card(C1).innerText().catch(() => '')
    check(/Parte C1 do checkout/.test(c1Text), `cartão resumo com o propósito da sessão ("${c1Text.replace(/\n/g, ' · ')}")`)
    // r4: trilho da Equipe com rótulo e as iniciais das filhas.
    const railChildren = await page
      .locator('[data-testid="crew-rail-child"]')
      .evaluateAll((els) => els.map((e) => ({ t: (e.textContent ?? '').trim(), a: e.getAttribute('aria-label') ?? '' })))
    const railLabel = await page
      .locator('[data-testid="crew-dock"] button[aria-label^="Equipe ·"]')
      .first()
      .getAttribute('aria-label')
      .catch(() => null)
    check(
      railChildren.length === 2 && railChildren.every((c) => /^[A-Z0-9]$/.test(c.t) && c.a) && /filhas ativas|esperando/.test(railLabel ?? ''),
      `trilho da Equipe: "${railLabel}" + iniciais ${JSON.stringify(railChildren.map((c) => c.t))}`,
    )
  }
  const ids = [M.id, C1, C2, X.id, Y.id]
  {
    const mb0 = await mapBox()
    const bar = await page.getByTestId('map-top-bar').boundingBox()
    const tops = await page
      .locator('[data-lane-kind]')
      .evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })),
      )
    const top = Math.min(...tops.map((t) => t.top))
    const bottom = Math.max(...tops.map((t) => t.bottom))
    const freeTop = bar ? bar.y + bar.height : (mb0?.y ?? 0)
    const freeBottom = mb0 ? mb0.y + mb0.height : 0
    const above = top - freeTop
    const below = freeBottom - bottom
    // Rodada 2: limitado pela largura (a feature de 3 raias), encosta 32px abaixo
    // da barra; só centraliza quando sobra largura (zoom no teto).
    const zFit = await zoomNow()
    check(
      zFit < 0.99
        ? Math.abs(above - 32) <= 3
        : Math.abs(above - below) < 0.25 * (freeBottom - freeTop),
      `enquadrar (zoom ${zFit.toFixed(2)}): ${zFit < 0.99 ? 'encostado 32px abaixo da barra' : 'centralizado'} (acima ${Math.round(above)}px, abaixo ${Math.round(below)}px)`,
    )
  }
  const off1 = await offscreenTruth(ids, null)
  check(
    off1.truth === off1.shown,
    `contador "fora da vista" bate com a tela, Equipe fechada (tela ${off1.truth}, aviso ${off1.shown})`,
  )
  // As raias de repo são nós irmãos do card no DOM do xyflow (não filhas).
  const repoLanes = await page
    .locator(`.react-flow__node[data-id^="lane:f:${checkout.id}:r:"]`)
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))
  const cardHs = await Promise.all(
    [M.id, C1, C2].map(async (id) => (await card(id).boundingBox())?.height ?? 0),
  )
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
  {
    const bar = await page.getByTestId('map-top-bar').boundingBox()
    const laneTop = (await lane.boundingBox())?.y ?? 0
    const z = await zoomNow()
    const gap = bar ? laneTop - (bar.y + bar.height) : -1
    check(
      z >= 0.99 || Math.abs(gap - 32) <= 3,
      `Equipe aberta, auto-enquadrar: feature 32px abaixo da barra (${Math.round(gap)}px, zoom ${z.toFixed(2)})`,
    )
    // A moldura da mãe é identidade, não seleção: sem glow e sem o accent do foco.
    const motherStyle = await card(M.id)
      .evaluate((e) => {
        const f = (e.closest('[data-mother]') ??
          e.querySelector('[data-mother]') ??
          e) as HTMLElement
        const cs = getComputedStyle(f)
        return { shadow: cs.boxShadow, style: cs.borderTopStyle }
      })
      .catch(() => ({ shadow: '?', style: '?' }))
    // r3: identidade por faixa no topo (inset), nunca por contorno (o contorno é do foco).
    check(
      motherStyle.style !== 'double' && /inset/.test(motherStyle.shadow),
      `mãe com faixa no topo, sem contorno próprio (borda ${motherStyle.style}, sombra ${motherStyle.shadow})`,
    )
  }
  const autoOff = await offscreenTruth(ids, '[data-testid="crew-dock"][data-overlay]')
  const autoUnder = await cardsUnder('[data-testid="crew-dock"][data-overlay]', [M.id, C1, C2])
  check(
    autoOff.truth === autoOff.shown && autoUnder.length === 0,
    `abrir a Equipe reenquadra: nenhum cartão da feature sob o dock (${autoUnder.length}); contador = tela (${autoOff.truth} = ${autoOff.shown})`,
  )
  await fit()
  await shot('enquadrar-equipe-aberta')
  {
    const bar = await page.getByTestId('map-top-bar').boundingBox()
    const laneTop = (await lane.boundingBox())?.y ?? 0
    const z = await zoomNow()
    const gap = bar ? laneTop - (bar.y + bar.height) : -1
    check(
      z >= 0.99 || Math.abs(gap - 32) <= 3,
      `Enquadrar com a Equipe: feature 32px abaixo da barra (${Math.round(gap)}px, zoom ${z.toFixed(2)})`,
    )
  }
  const stillOpen = await dockOpen()
  const openFit = await laneInside(
    laneSel,
    stillOpen ? '[data-testid="crew-dock"][data-overlay]' : null,
  )
  check(
    openFit.ok,
    `Enquadrar (Equipe aberta): feature inteira fora do dock (${stillOpen ? 'dock aberto' : 'dock recolhido pelo enquadrar'}; ${openFit.detail})`,
  )
  const under = await cardsUnder('[data-testid="crew-dock"][data-overlay]', [M.id, C1, C2])
  check(under.length === 0, `nenhuma raia da feature embaixo do dock (${under.length})`)
  await page.waitForTimeout(400)
  const off2 = await offscreenTruth(
    ids,
    (await dockOpen()) ? '[data-testid="crew-dock"][data-overlay]' : null,
  )
  check(
    off2.truth === off2.shown,
    `contador bate com a tela depois do enquadrar com a Equipe (tela ${off2.truth}, aviso ${off2.shown})`,
  )
  const mbx = await mapBox()
  const strays = await page
    .locator('[data-testid="map-overflow-right"]')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))
  const dockLeft = (await dockOpen())
    ? ((await page.locator('[data-testid="crew-dock"][data-overlay]').boundingBox())?.x ?? 0)
    : 0
  check(
    strays.every((r) => !mbx || Math.abs(r - (dockLeft || mbx.x + mbx.width)) < 12),
    `sombra da borda direita encostada na borda real (sem faixa no meio do mapa): ${JSON.stringify(strays.map(Math.round))}`,
  )

  // ---------- Painel da feature recolhe a Equipe ----------
  // No título (o chip "N lembretes" na mesma linha abre Notas & regras).
  await lane.getByTestId('feature-card-header').click({ position: { x: 24, y: 12 } })
  await page.getByTestId('feature-panel').waitFor({ state: 'visible', timeout: 10_000 })
  const zOpen = await zoomNow()
  await page.waitForTimeout(800)
  console.log('[probe] zoom ao abrir / +800ms:', zOpen.toFixed(3), (await zoomNow()).toFixed(3))
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
  const counts = await page
    .getByTestId('feature-panel-state-counts')
    .innerText()
    .catch(() => '')
  const rulesN = await page.locator('[data-testid="feature-panel-state-rules"] li').count()
  check(
    /3\s*trabalhando/.test(counts.replace(/\n/g, ' ')) && rulesN >= 2,
    `Estado com dados: "${counts.replace(/\s+/g, ' ')}", ${rulesN} regras fixadas`,
  )
  // Sem clicar no Enquadrar: o mapa se reenquadra sozinho ao abrir o painel.
  const panelFit = await laneInside(laneSel, '[data-testid="feature-panel"]')
  console.log('[polish-r5] zoom no painel:', (await zoomNow()).toFixed(3))
  await shot('painel-da-feature')
  {
    // r4: a aba Estado diz quem é a mãe, com Abrir/Passar o bastão, e lista as sessões.
    const mom = await page.getByTestId('feature-panel-mother').innerText().catch(() => '')
    const crewN = await page.locator('[data-testid="feature-panel-crew"] li').count()
    const batonBtn = await page.getByTestId('feature-panel-mother-baton').count()
    check(
      /mae-checkout/.test(mom) && /2 filhas/.test(mom) && batonBtn === 1 && crewN === 3,
      `painel: "Mãe: mae-checkout · 2 filhas" com o bastão e as 3 sessões listadas ("${mom.replace(/\n/g, ' ')}"; ${crewN} linhas)`,
    )
    const iconBtns = await page
      .getByTestId('map-top-bar')
      .locator('button')
      .evaluateAll((els) =>
        els
          .filter((e) => !(e as HTMLElement).innerText.trim())
          .map((e) => ({ t: e.getAttribute('title') ?? '', a: e.getAttribute('aria-label') ?? '' })),
      )
    check(
      iconBtns.every((b) => b.t && b.a),
      `botões só-ícone da barra com tooltip e aria-label (${JSON.stringify(iconBtns)})`,
    )
    const scopeTxt = await page
      .getByRole('group', { name: 'Escopo do mapa' })
      .innerText()
      .catch(() => '')
    check(!/(^|\s)Projeto(\s|$)/.test(scopeTxt), `escopo sem "Projeto" ambíguo ("${scopeTxt.replace(/\n/g, ' | ')}")`)
  }
  // r3: no resumo o cartão estreita (BRIEF_W) e o painel tem 380px: as 3 raias cabem a 0.6.
  // o começo da feature na vista e a sombra/contador avisam o resto.
  const panelHints = await overflowShown()
  const panelOff = await page
    .getByTestId('map-offscreen-count')
    .innerText()
    .catch(() => '')
  // r3: a feature inteira ao lado do painel (no resumo o piso desce até 0.5).
  check(
    panelFit.ok,
    `abrir o painel reenquadra: a feature cabe ao lado dele ou a borda avisa o resto (${panelFit.detail}; aviso: "${panelOff}"; dicas ${panelHints.join(',')})`,
  )
  const cardStatus = await lane.getByTestId('feature-card-status').innerText()
  const panelStatus = await page
    .getByTestId('feature-panel-status')
    .innerText()
    .catch(() => '')
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
  {
    const panelB = await page.getByTestId('feature-panel').boundingBox()
    const barB = await page.getByTestId('map-top-bar').boundingBox()
    const cnt = await page.getByTestId('map-status-counters').boundingBox()
    const laneB = await lane.boundingBox()
    check(
      !!panelB &&
        !!barB &&
        !!cnt &&
        barB.x + barB.width <= panelB.x + 1 &&
        cnt.x + cnt.width <= panelB.x,
      `painel aberto: a barra do mapa encolhe e o pill de status fica inteiro (barra até ${barB ? Math.round(barB.x + barB.width) : '?'}, status até ${cnt ? Math.round(cnt.x + cnt.width) : '?'}, painel em ${panelB ? Math.round(panelB.x) : '?'})`,
    )
    const gapTop = laneB && barB ? laneB.y - (barB.y + barB.height) : 999
    check(
      zPanel >= 0.49 && gapTop < 60,
      `painel aberto: zoom ${zPanel.toFixed(2)} (>= 0.5, resumo) e a feature encostada no topo (${Math.round(gapTop)}px abaixo da barra)`,
    )
    const offP = await offscreenTruth(ids, '[data-testid="feature-panel"]')
    check(
      offP.truth === offP.shown,
      `painel aberto: contador = tela (tela ${offP.truth}, aviso ${offP.shown})`,
    )
    const clearP = await pillClearOfCards('[data-testid="feature-panel"]')
    check(
      clearP.ok,
      `painel aberto: pill não cobre cartão à vista nem cabeçalho (${clearP.detail})`,
    )
    // r3: a barra do mapa numa linha só (o contador caía numa 2ª linha solta).
    const barTops = await page
      .getByTestId('map-top-bar')
      .evaluate((e) => [...e.children].map((c) => Math.round(c.getBoundingClientRect().top)))
    check(
      new Set(barTops).size <= 1 || Math.max(...barTops) - Math.min(...barTops) < 12,
      `painel aberto: barra do mapa numa linha (tops ${barTops.join(',')})`,
    )
  }
  const repoLaneSel = `.react-flow__node[data-id^="lane:f:${checkout.id}:r:"]`
  const btns = await page
    .locator(`${repoLaneSel} [data-testid="lane-new-session"]`)
    .evaluateAll((els) =>
      els.map((e) => ({
        compact: e.hasAttribute('data-compact'),
        text: (e.textContent ?? '').trim(),
      })),
    )
  const prefixes = await page
    .locator(`${repoLaneSel} [data-testid="lane-repo-project"]`)
    .evaluateAll((els) =>
      els.map((e) => ({
        short: e.hasAttribute('data-short'),
        text: (e.textContent ?? '').trim(),
        w: e.getBoundingClientRect().width,
      })),
    )
  check(
    btns.length === 3 && btns.every((b) => b.compact && b.text === ''),
    `raias no resumo: "+ Nova sessão" vira só "+" (${JSON.stringify(btns)} a ${zPanel.toFixed(2)})`,
  )
  check(
    prefixes.length === 1 && prefixes[0].w > 0 && prefixes[0].text.length > 1 &&
      (zPanel >= 0.6 || prefixes[0].short),
    `o prefixo do projeto alheio nunca some da raia; abaixo de 0.6 vira ponto + abreviado (zoom ${zPanel.toFixed(2)}, ${JSON.stringify(prefixes)})`,
  )
  const repoNames = await page
    .locator(`${repoLaneSel} [data-testid="lane-repo"]`)
    .evaluateAll((els) =>
      els.map((e) => {
        const s = e.querySelector('.text-\\[var\\(--color-text\\)\\]') as HTMLElement | null
        const outer = s?.parentElement as HTMLElement | null
        return outer ? outer.scrollWidth <= outer.clientWidth + 1 : false
      }),
    )
  console.log('[polish-r5] nomes de repo inteiros com o painel:', JSON.stringify(repoNames))
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
  const paletteOpen = await page
    .getByPlaceholder(/buscar|Buscar|comando/i)
    .first()
    .isVisible()
    .catch(() => false)
  console.log('[polish-r5] paleta aberta sobre a modal após Ctrl+K:', paletteOpen)
  // Fecha a paleta pelo próprio input dela (o Esc não pode cair no xterm).
  if (paletteOpen)
    await page
      .getByPlaceholder(/buscar|Buscar|comando/i)
      .first()
      .press('Escape')
  await page.waitForTimeout(300)
  await liftT
    .locator('.xterm')
    .click()
    .catch(() => {})
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  await shot('modal-terminal')
  const liftText = await liftT.innerText()
  check(
    !/trabalhando há/.test(liftText),
    'status só no header da modal (sem "trabalhando há" no rodapé)',
  )
  const roleTxt = await liftT
    .getByTestId('peek-role')
    .innerText()
    .catch(() => '')
  const featTxt = await liftT
    .getByTestId('peek-feature')
    .innerText()
    .catch(() => '')
  const batonBtn = await liftT.getByTestId('peek-baton').count()
  check(
    /MÃE · 2/.test(roleTxt) && featTxt.includes('Checkout E2E') && batonBtn === 1,
    `modal da mãe: selo "${roleTxt}", feature "${featTxt}", "Passar o bastão" (${batonBtn})`,
  )
  const stripRoles = await liftT
    .locator('[data-testid="peek-lift-strip"] [data-lift-session]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-role') ?? '-'))
  check(
    stripRoles[0] === 'mother' && stripRoles.filter((r) => r === 'child').length >= 1,
    `tira do rodapé: mãe primeiro e filhas marcadas (${stripRoles.join(',')})`,
  )
  await liftT.getByTestId('peek-baton').click()
  const batonDlg = page
    .getByRole('dialog')
    .filter({ hasText: /bastão/i })
    .last()
  const batonUp = await batonDlg.isVisible({ timeout: 5000 }).catch(() => false)
  // Espera o fade de entrada (pw-rise) terminar: o print 09 saiu no meio dele.
  await page
    .waitForFunction(() =>
      [...document.querySelectorAll('.pw-rise')].every((e) =>
        e.getAnimations().every((a) => a.playState === 'finished'),
      ),
    )
    .catch(() => {})
  await page.waitForTimeout(200)
  {
    const note = await page
      .getByTestId('baton-note')
      .boundingBox()
      .catch(() => null)
    const confirmB = await page
      .getByTestId('baton-confirm')
      .boundingBox()
      .catch(() => null)
    const ta = await page
      .getByTestId('baton-briefing')
      .boundingBox()
      .catch(() => null)
    const helper = await page.getByTestId('baton-briefing-required').count()
    const disabled = await page
      .getByTestId('baton-confirm')
      .isDisabled()
      .catch(() => false)
    check(
      !!note &&
        !!confirmB &&
        note.y + note.height <= confirmB.y - 8 &&
        !!ta &&
        ta.height <= 0.4 * 1800 + 2,
      `bastão: campos opcionais inteiros acima do rodapé (nota até ${note ? Math.round(note.y + note.height) : '?'}, rodapé em ${confirmB ? Math.round(confirmB.y) : '?'}; briefing ${ta ? Math.round(ta.height) : '?'}px)`,
    )
    check(
      !disabled || helper === 1,
      `bastão: botão desabilitado diz o motivo (disabled ${disabled}, helper ${helper})`,
    )
  }
  await shot('modal-bastao')
  {
    // r4: uma ação de regerar só; o motivo do "Subir" desabilitado fica ao lado dele.
    const regen =
      (await page.getByRole('button', { name: 'Tentar de novo' }).count()) +
      (await page.getByRole('button', { name: 'Destilar de novo' }).count())
    check(regen === 1, `diálogo do bastão com uma ação de regerar só (${regen})`)
    const hint = await page.getByTestId('baton-briefing-required').boundingBox()
    const confirmBox = await page.getByTestId('baton-confirm').boundingBox()
    check(
      !hint || (!!confirmBox && Math.abs(hint.y + hint.height / 2 - (confirmBox.y + confirmBox.height / 2)) <= 12),
      `hint do briefing na linha do botão desabilitado (${hint ? Math.round(hint.y) : '—'} vs ${confirmBox ? Math.round(confirmBox.y) : '—'})`,
    )
  }
  check(batonUp, '"Passar o bastão" na modal abre o diálogo do bastão')
  {
    const err = page.getByTestId('baton-error')
    if (await err.count()) {
      const info = await err.evaluate((e) => {
        const btn = [...e.querySelectorAll('button')].find((b) =>
          /Tentar de novo/.test(b.textContent ?? ''),
        )
        const r = e.getBoundingClientRect()
        const br = btn?.getBoundingClientRect()
        return {
          style: e.getAttribute('style') ?? '',
          inline: !!br && br.top >= r.top && br.bottom <= r.bottom && br.height > r.height * 0.4,
        }
      })
      check(
        info.style.includes('--color-warning') &&
          !info.style.includes('--color-danger') &&
          info.inline,
        `fallback do resumo em tom de aviso e com "Tentar de novo" na mesma linha (${info.inline})`,
      )
    } else console.log('[polish-r5] (sem fallback do resumo nesta execução)')
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  check(
    await liftT.isVisible(),
    'Esc fecha só o diálogo do bastão; a modal do terminal segue aberta',
  )
  const headerH = (await liftT.getByTestId('peek-header').boundingBox())?.height ?? 999
  const meta = await liftT
    .getByTestId('peek-header-meta')
    .innerText()
    .catch(() => '')
  check(
    headerH <= 42 && meta.includes('/'),
    `header da modal numa linha (${Math.round(headerH)}px: "${meta}")`,
  )
  const hintsText =
    (await liftT
      .getByTestId('peek-lift-hints')
      .getAttribute('aria-label')
      .catch(() => '')) ?? ''
  const kbds = await liftT.getByTestId('peek-lift-hints').locator('kbd').count()
  const kbdColor = await liftT
    .getByTestId('peek-lift-hints')
    .evaluate((e) => getComputedStyle(e).color)
    .catch(() => '')
  check(
    hintsText.includes('Alt+, / Alt+. trocar') &&
      hintsText.includes('Shift+Esc fecha') &&
      kbds >= 4,
    `dicas da modal com <kbd> (${kbds} teclas, cor ${kbdColor}): "${hintsText}"`,
  )
  check(
    (await liftT.getByRole('button', { name: 'Inserir', exact: true }).count()) === 0 &&
      (await liftT.getByRole('button', { name: 'Inserir sem enviar' }).count()) === 1,
    '"Inserir" vira ícone com tooltip ao lado do Enviar',
  )
  const cli = fake.readCliLog('claude')
  console.log(
    '[polish-r5] stdin do stub:',
    JSON.stringify(
      cli
        .split('\n')
        .filter((l) => l.includes('stdin:'))
        .slice(-3),
    ),
  )
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
  {
    const spin = await page
      .locator('.animate-spin')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.color))
    const tabDots = await page.getByTestId('tab-project-dot').count()
    check(
      spin.length > 0 && spin.every((c) => !c || c.includes('--color-info')) && tabDots > 0,
      `spinner das abas na cor do status; projeto num dot à parte (${[...new Set(spin)].join(',')}; dots ${tabDots})`,
    )
  }
  {
    const allIds = await page
      .getByTestId('session-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id') ?? ''))
    const offA = await offscreenTruth(allIds, null)
    check(
      offA.truth === offA.shown,
      `visão geral (enquadrar automático): contador = tela (tela ${offA.truth}, aviso ${offA.shown})`,
    )
    const neutral = await page
      .locator('[data-lane-kind="project"]')
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopColor))
    const reddish = neutral.filter((c) => {
      const m = c.match(/\d+(\.\d+)?/g)?.map(Number) ?? []
      return m.length >= 3 && m[0] > m[2] + 40 && m[0] > m[1] + 40
    })
    check(
      neutral.length > 0 && reddish.length === 0,
      `"Sem feature" com borda neutra (${JSON.stringify([...new Set(neutral)])})`,
    )
  }
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
    (b) =>
      mb &&
      b.x >= mb.x - 1 &&
      b.x + b.w <= mb.x + mb.width + 1 &&
      b.y >= mb.y - 1 &&
      b.y + b.h <= mb.y + mb.height + 1,
  ).length
  const offCount = await page
    .getByTestId('map-offscreen-count')
    .innerText()
    .catch(() => '')
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
  const repoTops = await page
    .locator('.react-flow__node-lane')
    .evaluateAll((els) =>
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
  const repoBoxes = await page
    .locator('[data-testid="lane-repo"]')
    .evaluateAll((els) =>
      els
        .map((e) => e.getBoundingClientRect())
        .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
    )
  const overlaps = projIds.filter((p) =>
    repoBoxes.some(
      (r) =>
        r.left >= p.left &&
        r.right <= p.right &&
        r.top >= p.top &&
        r.bottom <= p.bottom &&
        r.top < p.hb - 1,
    ),
  ).length
  check(
    projIds.length > 0 && overlaps === 0 && orphan.every((o) => !o.bullet),
    `"Sem feature": cabeçalho acima das raias, sem bullet (${projIds.length} grupos, ${overlaps} sobrepostos; ${repoTops.length} lanes)`,
  )
  {
    // r4: com tudo à vista o minimapa some (e o botão dele); a 1:1 volta.
    const mmFit = await page.locator('.react-flow__minimap').count()
    check(
      inView === boxes.length ? mmFit === 0 : mmFit === 1,
      `minimapa só com conteúdo fora da vista (${inView}/${boxes.length} à vista, minimapa ${mmFit})`,
    )
    // Empacotamento: o "Sem feature" mais baixo fica embaixo de uma coluna de largura parecida.
    const proj = await page.locator('.react-flow__node-lane:has([data-lane-kind="project"])').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect()
        return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), b: Math.round(r.bottom) }
      }),
    )
    const lowest = [...proj].sort((a, b) => b.t - a.t)[0]
    const above = proj.find((p) => p !== lowest && Math.abs(p.l - lowest.l) <= 2 && p.b <= lowest.t)
    const lowestRow = proj.filter((p) => Math.abs(p.t - lowest.t) <= 2)
    check(
      !!lowest && (lowestRow.length > 1 || (!!above && Math.abs(above.w - lowest.w) <= 4)),
      `"Sem feature" empacotadas por coluna, sem card sozinho numa linha nova (${JSON.stringify(proj)})`,
    )
    await page.getByTestId('map-zoom-100').click()
    await page.waitForTimeout(700)
    const mm = await page.locator('.react-flow__minimap').boundingBox()
    check(
      !!mm && mm.height <= 142,
      `a 1:1 (conteúdo fora da vista) o minimapa volta, na proporção do conteúdo (${mm ? `${Math.round(mm.width)}x${Math.round(mm.height)}` : '—'})`,
    )
    await fit()
  }
  const strip = page.getByTestId('session-strip-scroll')
  const stripBar = await strip.evaluate((e) => e.offsetHeight - e.clientHeight).catch(() => -1)
  const more = await page
    .getByTestId('session-strip-more')
    .innerText()
    .catch(() => '')
  check(stripBar === 0, `barra de abas sem scrollbar visível (${stripBar}px)`)
  check(/\+\d+/.test(more), `overflow da barra vira "${more.trim()}"`)
  {
    const tabs = await page.locator('[data-strip-chip]').evaluateAll((els) => {
      const bar = document.querySelector('[data-testid="session-strip-scroll"]')!.getBoundingClientRect()
      return els.map((e) => {
        const r = e.getBoundingClientRect()
        const name = e.querySelector('.truncate')!.getBoundingClientRect()
        return {
          visible: Math.min(r.right, bar.right) - Math.max(r.left, bar.left),
          hidden: getComputedStyle(e).visibility === 'hidden',
          tail: Math.round(r.right - name.right),
        }
      })
    })
    const sliver = tabs.filter((t) => !t.hidden && t.visible > 0 && t.visible < 64)
    check(sliver.length === 0, `nenhuma aba cortada a ponto de virar só ícone (${JSON.stringify(tabs.map((t) => Math.round(t.visible)))})`)
    const tails = tabs.filter((t) => !t.hidden && t.visible >= 64).map((t) => t.tail)
    check(
      tails.length > 0 && tails.every((t) => t <= 40),
      `abas sem vão morto à direita do nome (${JSON.stringify(tails)}px)`,
    )
  }

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
  const sw = await page
    .getByTestId('switcher-crew-count')
    .innerText()
    .catch(() => '')
  const swCount = await page
    .getByTestId('switcher-count-working')
    .innerText()
    .catch(() => '')
  const mapWorking = await page
    .getByTestId('map-count-working')
    .innerText()
    .catch(() => '')
  // r3: o número do grupo = as linhas que ele mostra; o chip diz quantas filhas ficam fora.
  const workingRows = await page
    .getByTestId('switcher-count-working')
    .evaluate((e) => e.closest('.mb-4')?.querySelectorAll('li').length ?? -1)
    .catch(() => -1)
  check(
    /^2 na equipe$/.test(sw.trim()) &&
      Number(swCount.trim()) === workingRows &&
      mapWorking.includes('11'),
    `contagem do seletor = linhas visíveis: "${swCount}" = ${workingRows} linhas · "${sw}" (mapa "${mapWorking}")`,
  )
  const motherRow = await page
    .locator('[data-modal-overlay] li')
    .filter({ hasText: 'mae-checkout' })
    .getByTestId('switcher-row-mother')
    .innerText()
    .catch(() => '')
  check(/MÃE · 2/.test(motherRow), `linha da mãe no seletor com a coroa ("${motherRow}")`)
  {
    // r4: a mãe da feature no topo de TRABALHANDO, à frente das soltas.
    const first = await page
      .getByTestId('switcher-count-working')
      .evaluate((e) => (e.closest('.mb-4')?.querySelector('li') as HTMLElement | null)?.innerText ?? '')
      .catch(() => '')
    check(/mae-checkout/.test(first), `mãe da feature fixada no topo do grupo ("${first.split('\n')[0]}")`)
  }
  await page.keyboard.type('marina')
  await page.waitForTimeout(300)
  const found = await page.locator('[data-modal-overlay] li').filter({ hasText: 'marina' }).count()
  check(found >= 1, `buscar o nome de uma filha da Equipe acha a filha (${found})`)
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  const cbBg = await page
    .locator('[data-modal-overlay] input[type="checkbox"], input[type="checkbox"]')
    .first()
    .evaluate((e) => ({
      bg: getComputedStyle(e).backgroundColor,
      ap: getComputedStyle(e).appearance,
    }))
    .catch(() => ({ bg: '', ap: '' }))
  check(
    cbBg.ap === 'none' && !/rgb\(25[0-5], 25[0-5], 25[0-5]\)/.test(cbBg.bg),
    `checkbox do seletor no tema (appearance ${cbBg.ap}, fundo ${cbBg.bg})`,
  )
  const swKbd = await page.locator('kbd').count()
  check(swKbd >= 4, `rodapé do seletor com o mesmo <kbd> (${swKbd})`)
  await page.getByTestId('switcher-crew-count').click()
  await page.waitForTimeout(400)
  await shot('seletor-com-equipe')
  const crewRows = await page.getByTestId('switcher-row-crew').count()
  const swOn = await page
    .getByTestId('switcher-crew-count')
    .innerText()
    .catch(() => '')
  check(
    crewRows === 2 &&
      (await page.getByTestId('switcher-crew-count').getAttribute('aria-pressed')) === 'true' &&
      swOn.trim() === '2 na equipe',
    `"2 na equipe" é um toggle de rótulo fixo: 2 filhas entram na lista marcadas (${crewRows}; "${swOn.trim()}")`,
  )
  const workingBadges = await page
    .locator('[data-modal-overlay] [data-testid="switcher-row-status"]')
    .allInnerTexts()
    .catch(() => [] as string[])
  check(
    !workingBadges.some((t) => /trabalhando/i.test(t)),
    `linhas sob "Trabalhando" sem o badge redundante (${workingBadges.length} badges: ${[...new Set(workingBadges)].join(',')})`,
  )
  const chips = await page
    .locator('[data-modal-overlay] li')
    .filter({ hasText: 'Checkout E2E' })
    .count()
  check(
    chips >= 3,
    `com a equipe na lista, as 3 sessões da Checkout E2E aparecem com o chip (${chips})`,
  )
  {
    const order = await page
      .getByTestId('switcher-count-working')
      .evaluate((e) =>
        [...(e.closest('.mb-4')?.querySelectorAll('li') ?? [])].slice(0, 3).map((li) => ({
          text: (li as HTMLElement).innerText.split('\n')[0],
          nested: li.hasAttribute('data-nested'),
        })),
      )
      .catch(() => [] as { text: string; nested: boolean }[])
    check(
      order.length === 3 &&
        /mae-checkout/.test(order[0].text) &&
        !order[0].nested &&
        order.slice(1).every((o) => o.nested && /↳/.test(o.text)),
      `com a equipe: mãe e as 2 filhas indentadas com "↳" logo abaixo (${JSON.stringify(order)})`,
    )
  }
  await page.keyboard.press('Escape')
  await page
    .getByTitle('Home', { exact: true })
    .first()
    .click()
    .catch(() => {})
  await page.waitForTimeout(1200)
  await shot('home')
  const hc = await page
    .getByTestId('home-sessions-crew')
    .innerText()
    .catch(() => '')
  const homeCard = await page
    .getByText('Sessões agora')
    .locator('..')
    .innerText()
    .catch(() => '')
  check(
    /^2 na equipe$/.test(hc.trim()) && /11/.test(homeCard),
    `Home: "Sessões agora" com o total e "${hc}" ("${homeCard.replace(/\s+/g, ' ').slice(0, 40)}")`,
  )
  const titles = await page.getByTestId('task-row-title').count()
  console.log('[polish-r5] tasks com título em linha própria na Home:', titles)
} catch (e) {
  fatal = e
  console.log('[polish-r5] FATAL', e)
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
  '[polish-r5] erros de console:',
  consoleErrors.length ? consoleErrors.join(' | ') : 'nenhum',
)
const failed = results.filter((r) => !r.ok)
console.log(
  `[polish-r5] ${results.length - failed.length}/${results.length} PASS${fatal ? ' (FATAL)' : ''}`,
)
process.exit(failed.length || fatal ? 1 : 0)
