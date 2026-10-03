import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Locator } from 'playwright'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// F2 — mapa agrupado por FEATURE, sobre a CÓPIA do perfil real, HOME fake e o
// stub do `claude` (PTYs vivas, nada toca os repos):
//   feature "Checkout E2E" com 3 repos de 2 projetos (o 3º com worktree registrado)
//   M  (Ctrl+N, com aba) entra na feature pelo menu "Mover para feature…"
//   C1/C2 filhas de M via MCP session_handoff → herdam a feature da mãe
//   S4 sem aba, ligada pela BRANCH do transcript; depois troca de branch e migra
//      pro card "Painel de pagamentos" (resolução contínua)
//   S5 sem aba, ligada pelo cwd no WORKTREE da feature
//   X  sem feature → "Sem feature · <Projeto>"; E encerrada some do mapa
//   Enquadrar com a Equipe aberta: zoom >= 0.9, nenhum cartão nem a pílula sob ela
// Rodar: MBF_SHOTS=<dir> npx tsx e2e/scenarios/map-by-feature.ts

const SHOTS = process.env.MBF_SHOTS ?? join(tmpdir(), `map-by-feature-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0
const shotPath = (name: string) => join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)

const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[mbf] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

// ---------- 1ª subida: migrations na cópia ----------
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
// Projeto "home" com 2 repos + 1 repo de outro projeto.
const home = unique.find((r) => unique.filter((x) => x.project_id === r.project_id).length >= 2)
const back = home
const front = unique.find((r) => r.project_id === home?.project_id && r.id !== home?.id)
const data = unique.find((r) => r.project_id !== home?.project_id)
if (!back || !front || !data)
  throw new Error('a cópia precisa de 2 repos num projeto e 1 em outro (labels únicos)')
console.log(
  `[mbf] back=${back.project}/${back.label} front=${front.project}/${front.label} data=${data.project}/${data.label}`,
)
const worktree = join(fake.root, 'worktrees', 'checkout-data')
mkdirSync(worktree, { recursive: true })

writeCopyPrefs(userData, {
  claude_command: fake.fakeCliPath('claude'),
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

// ---------- 2ª subida ----------
const { app, page, mainOutput } = await launchApp({ userDataDir: userData, env: fake.env })
const logs = captureLogs(app, page)
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
})
const shot = (name: string) => page.screenshot({ path: shotPath(name) }).catch(() => {})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[mbf] timeout esperando: ${label}`)
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(300)
  }
}

async function dismissIntro(): Promise<void> {
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 10; i++) {
    if (await skip.count()) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await skip.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
      return
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

interface Live {
  id: string
  ccSessionId: string
}
interface GraphNode {
  sessionId: string
  featureId?: string | null
  status: string
}
interface Graph {
  nodes: GraphNode[]
  lanes: Array<{ kind: string; featureId?: string; name: string }>
}
const live = () => page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<Live[]>
const graph = () => page.evaluate(() => window.api.sessionGraph.get()) as Promise<Graph>
const featureOf = async (id: string) =>
  (await graph()).nodes.find((n) => n.sessionId === id)?.featureId ?? null
const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const featureLane = (featureId: string) =>
  page.locator(`[data-lane-kind="feature"][data-feature-id="${featureId}"]`)

async function newSessionFile(before: Set<number>, label: string) {
  let created: FakeSessionEntry | undefined
  await waitFor(label, async () => {
    created = files().find((f) => !before.has(f.data.pid))
    return !!created
  })
  return created
}

async function sessionIdOf(cc: string): Promise<string> {
  // A sessão subida pelo main só entra no snapshot do renderer no próximo
  // refetch: o grafo do main é a fonte de verdade da PTY viva.
  let id = ''
  await waitFor(`sessions.id de ${cc}`, async () => {
    id =
      (await live()).find((s) => s.ccSessionId === cc)?.id ??
      (
        await queryDb<{ id: string }>(
          userData,
          `SELECT id FROM sessions WHERE cc_session_id = '${cc}'`,
        )
      )[0]?.id ??
      ''
    return id !== ''
  })
  return id
}

// Sessão SEM aba, como o MCP/um script sobe: direto pela API, sem pane.
async function spawnNoTab(repoId: string, name: string) {
  const before = new Set(files().map((f) => f.data.pid))
  const s = (await page.evaluate((a) => window.api.sessions.spawn(a), { repoId, name })) as {
    id: string
    ccSessionId: string
  }
  const file = await newSessionFile(before, `session file de ${name}`)
  return { id: s.id, cc: s.ccSessionId, file }
}

function transcriptOf(cc: string): string {
  const dir = join(fake.home, '.claude', 'projects', '-fake-map-by-feature')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${cc}.jsonl`)
}

// O que o Claude Code grava: cada linha carrega o gitBranch do momento.
function writeTurn(cc: string, branch: string, text: string) {
  appendFileSync(
    transcriptOf(cc),
    `${JSON.stringify({ type: 'user', gitBranch: branch, sessionId: cc, message: { role: 'user', content: text } })}\n`,
  )
}

type Box = { x: number; y: number; width: number; height: number }
const inside = (a: Box, b: Box) =>
  a.x >= b.x - 1 &&
  a.y >= b.y - 1 &&
  a.x + a.width <= b.x + b.width + 1 &&
  a.y + a.height <= b.y + b.height + 1
const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

async function cardIn(id: string, lane: Locator) {
  // Card de feature sem sessão some do mapa; boundingBox() esperaria 30s por ele.
  if ((await lane.count()) === 0 || (await card(id).count()) === 0) return false
  const c = await card(id).boundingBox()
  const l = await lane.boundingBox()
  return !!c && !!l && inside(c, l)
}

async function fit() {
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForTimeout(500)
}

async function zoom(): Promise<number> {
  return page.evaluate(() => {
    const t = getComputedStyle(document.querySelector('.react-flow__viewport')!).transform
    return t === 'none' ? 1 : new DOMMatrix(t).a
  })
}

let fatal: unknown = null
try {
  await waitReady(page)
  await dismissIntro()

  // ---------- Features via MCP (o mesmo caminho de uma sessão) ----------
  const mcp = await connectMcp(userData)
  const { feature: checkout } = await mcp.call<{ feature: { id: string } }>('feature_create', {
    projectId: back.project_id,
    title: 'Checkout E2E',
    status: 'in-progress',
    repos: [
      { repoId: back.id, branch: 'feat/checkout-e2e' },
      { repoId: front.id, branch: 'feat/checkout-e2e' },
      { repoId: data.id, branch: 'feat/checkout-e2e', worktreePath: worktree },
    ],
  })
  const { feature: painel } = await mcp.call<{ feature: { id: string } }>('feature_create', {
    projectId: back.project_id,
    title: 'Painel de pagamentos',
    status: 'in-progress',
    repos: [{ repoId: front.id, branch: 'feat/painel-pagamentos' }],
  })
  await mcp.call('feature_pulse_set', {
    featureId: checkout.id,
    body: 'Pagamento integrado; falta o estorno no front',
  })
  check(
    !!checkout.id && !!painel.id,
    'features "Checkout E2E" (3 repos, 2 projetos) e "Painel de pagamentos" criadas',
  )

  // ---------- M: Ctrl+N (com aba), ainda sem feature ----------
  await goToArea(page, 'projects')
  const beforeM = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(back.label)
  await search.press('Enter')
  await page
    .locator('div.fixed.inset-0', { hasText: `Nova sessão · ${back.label}` })
    .getByRole('button', { name: 'Abrir', exact: true })
    .click()
  const fileM = await newSessionFile(beforeM, 'session file de M')
  const idM = fileM ? await sessionIdOf(fileM.data.sessionId) : ''
  check(
    !!idM && (await page.locator('.dv-tab').count()) >= 1,
    `M aberta por Ctrl+N em ${back.label} (com aba)`,
  )

  // X (sem feature) e E (vai encerrar), sem aba.
  const X = await spawnNoTab(back.id, 'x-sem-feature')
  const E = await spawnNoTab(back.id, 'e-encerra')

  // ---------- Mapa ----------
  await page.keyboard.press('Control+Shift+KeyG')
  await waitFor('mapa', async () => page.getByTestId('session-map').isVisible())
  // O painel da mãe abre sozinho quando surge uma mãe (mother-focus-panel.ts);
  // este cenário mede os cartões do mapa com a largura toda. Ctrl+Shift+P troca o
  // modo mesmo sem painel à vista: 'off' vale para quando a mãe aparecer.
  await waitFor('painel automático', async () => (await page.getByTestId('mother-dock').count()) > 0, 3000)
  await page.keyboard.press('Control+Shift+KeyP')
  check(
    await waitFor(
      'painel desligado',
      async () =>
        (await page.getByTestId('mother-dock').count()) === 0 &&
        (await page.evaluate(() => JSON.parse(localStorage.getItem('cm:mother-dock') ?? '{}').mode)) === 'off',
      5000,
    ),
    'Ctrl+Shift+P desliga o painel da mãe (mode off)',
  )
  await page
    .getByRole('button', { name: 'Todos os projetos' })
    .click()
    .catch(() => {})
  await waitFor('cartão de M', async () => (await card(idM).count()) > 0)
  const noFeature = page.locator('[data-lane-kind="project"]', {
    hasText: `Sem feature · ${back.project}`,
  })
  check(
    await waitFor(
      'M e X em "Sem feature"',
      async () => (await cardIn(idM, noFeature)) && (await cardIn(X.id, noFeature)),
    ),
    `M e X caem em "Sem feature · ${back.project}" antes de qualquer vínculo`,
  )
  await shot('sem-feature')

  // ---------- Mover M para a feature pelo menu ----------
  await card(idM).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mover para feature…' }).click()
  const picker = page.getByTestId('map-feature-picker')
  await picker.waitFor({ state: 'visible', timeout: 10_000 })
  await picker.getByTestId('map-feature-picker-search').fill('Checkout')
  await picker.locator(`[role="option"][data-feature-id="${checkout.id}"]`).click()
  const lane = featureLane(checkout.id)
  check(
    await waitFor(
      'M no card da feature',
      async () => (await featureOf(idM)) === checkout.id && (await cardIn(idM, lane)),
    ),
    'M movida pelo menu "Mover para feature…" (sessions.feature_id gravado) e desenhada no card',
  )

  // ---------- C1/C2: filhas de M via MCP, herdam a feature ----------
  const asM = await mcpAs(idM)
  const children: Record<string, string> = {}
  for (const [k, repo] of [
    ['C1', data],
    ['C2', front],
  ] as const) {
    const before = new Set(files().map((f) => f.data.pid))
    await asM.call('session_handoff', {
      targetRepo: repo.label,
      task: `Parte ${k} do checkout`,
      mode: 'plan',
      force: true,
    })
    const f = await newSessionFile(before, `session file de ${k}`)
    children[k] = f ? await sessionIdOf(f.data.sessionId) : ''
  }
  const { C1, C2 } = children
  check(
    await waitFor(
      'filhas herdam a feature',
      async () => (await featureOf(C1)) === checkout.id && (await featureOf(C2)) === checkout.id,
    ),
    'C1 e C2 (session_handoff sem featureId) herdam o feature_id da mãe',
  )

  // ---------- S4: ligada pela branch; S5: pelo worktree ----------
  const S4 = await spawnNoTab(front.id, 's4-branch')
  writeTurn(S4.cc, 'feat/checkout-e2e', 'ajustar o botão de pagar')
  if (S4.file) fake.setStatus(S4.file.data.pid, 'busy')
  const S5 = await spawnNoTab(data.id, 's5-worktree')
  if (S5.file)
    fake.writeSessionFile(S5.file.data.pid, {
      sessionId: S5.cc,
      cwd: worktree,
      status: 'busy',
      name: 's5-worktree',
    })
  check(
    await waitFor(
      'S4/S5 resolvidas',
      async () =>
        (await featureOf(S4.id)) === checkout.id && (await featureOf(S5.id)) === checkout.id,
    ),
    'S4 (branch do transcript) e S5 (cwd no worktree) resolvidas para "Checkout E2E" sem criar feature',
  )

  // ---------- Card da feature ----------
  await page.waitForTimeout(800)
  await fit()
  await shot('card-da-feature')
  const allIn = await waitFor('5 cartões no card', async () => {
    for (const id of [idM, C1, C2, S4.id, S5.id]) if (!(await cardIn(id, lane))) return false
    return true
  })
  check(allIn, 'M, C1, C2, S4 e S5 dentro de [data-lane-kind=feature] "Checkout E2E"')
  check(
    (await lane.innerText()).includes('Checkout E2E') &&
      (await lane.getByTestId('feature-card-pulse').innerText()).includes('Pagamento integrado') &&
      /5 sessões · 3 repos/.test(await lane.getByTestId('feature-card-counts').innerText()),
    'header: título, pulso e "5 sessões · 3 repos"',
  )
  const laneBox = await lane.boundingBox()
  const repoLanes = page.getByTestId('lane-repo')
  let reposInCard = 0
  let otherProject = ''
  for (let i = 0; i < (await repoLanes.count()); i++) {
    const b = await repoLanes.nth(i).boundingBox()
    if (b && laneBox && inside(b, laneBox)) {
      reposInCard++
      otherProject += (
        await repoLanes.nth(i).getByTestId('lane-repo-project').allInnerTexts()
      ).join('')
    }
  }
  check(reposInCard === 3, `3 lanes de repo dentro do card (achadas: ${reposInCard})`)
  check(
    // innerText segue o text-transform (caixa alta do rótulo da lane).
    otherProject.toLowerCase().includes(data.project.toLowerCase()),
    `a lane do repo de outro projeto mostra "${data.project}"`,
  )
  check(
    (await card(S4.id).isVisible()) && (await card(S5.id).isVisible()),
    'S4/S5 sem aba aparecem no mapa',
  )
  const bm = await card(idM).boundingBox()
  const b1 = await card(C1).boundingBox()
  const b2 = await card(C2).boundingBox()
  // Colunas alinham ao topo (graph-to-flow.test: "a hierarquia é o fio, não a
  // altura"): a filha de outra coluna pode ficar ao lado da mãe, nunca acima
  // dela nem por cima dela.
  const overlaps = (a: typeof bm, b: typeof bm) =>
    !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  check(
    !!bm && !!b1 && !!b2 && b1.y >= bm.y - 1 && b2.y >= bm.y - 1 && !overlaps(bm, b1) && !overlaps(bm, b2),
    `mãe no topo, sem filha acima nem por cima (M.top=${bm && Math.round(bm.y)} C1.top=${b1 && Math.round(b1.y)} C2.top=${b2 && Math.round(b2.y)})`,
  )
  check(await cardIn(X.id, noFeature), 'X segue em "Sem feature"')

  // ---------- Clique no header abre o painel da feature ----------
  await lane.getByTestId('feature-card-header').click()
  check(
    await waitFor(
      'painel da feature',
      async () => page.getByTestId('feature-panel').isVisible(),
      8000,
    ),
    'clique no header do card abre o painel da feature (feature-panel-store.open)',
  )
  await shot('painel')
  await page.keyboard.press('Escape')
  await page
    .getByTestId('feature-panel')
    .getByRole('button', { name: /fechar/i })
    .click()
    .catch(() => {})

  // ---------- O header do card é a alça de arrasto (e arrastar não abre o painel) ----------
  {
    const header = lane.getByTestId('feature-card-header')
    const before = await lane.boundingBox()
    const hb = await header.boundingBox()
    if (before && hb) {
      // O card da feature passa da borda do mapa (mãe 1.6x): pega o header num
      // ponto visível, à direita do título.
      const mb = await page.getByTestId('session-map').boundingBox()
      const sx = Math.min(hb.x + hb.width * 0.75, (mb ? mb.x + mb.width : hb.x + hb.width) - 160)
      const sy = hb.y + hb.height / 2
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      await page.mouse.move(sx, sy + 60, { steps: 6 })
      await page.mouse.move(sx, sy + 120, { steps: 6 })
      await page.mouse.up()
    }
    const after = await lane.boundingBox()
    const moved = !!before && !!after ? after.y - before.y : 0
    check(moved >= 60, `arrastar pelo header move o card da feature (Δy=${Math.round(moved)}px)`)
    check(
      !(await page
        .getByTestId('feature-panel')
        .isVisible()
        .catch(() => false)),
      'arrastar pelo header não abre o painel',
    )
  }

  // ---------- Resolução contínua: S4 troca de branch e migra de card ----------
  writeTurn(S4.cc, 'feat/painel-pagamentos', 'agora o painel')
  if (S4.file) fake.setStatus(S4.file.data.pid, 'idle')
  const migrated = await waitFor(
    'S4 migra',
    async () =>
      (await featureOf(S4.id)) === painel.id && (await cardIn(S4.id, featureLane(painel.id))),
    15_000,
  )
  check(migrated, 'S4 mudou de branch → migra do card "Checkout E2E" para "Painel de pagamentos"')
  await fit()
  await shot('s4-migrou')

  // ---------- Voltar para a main solta o vínculo do resolvedor ----------
  // A feat/* antiga continua na cauda do transcript; o que vale é a branch atual.
  writeTurn(S4.cc, 'main', 'voltei pra main')
  const released = await waitFor(
    'S4 solta na main',
    async () =>
      // !== painel (não === null): sem sinal de branch, o fuzzy do 1º prompt pode
      // casar outra feature — o que importa é soltar o vínculo da feat/*.
      (await featureOf(S4.id)) !== painel.id && !(await cardIn(S4.id, featureLane(painel.id))),
    15_000,
  )
  check(released, 'S4 voltou para a main → sai do card "Painel de pagamentos"')
  await shot('s4-main')
  writeTurn(S4.cc, 'feat/painel-pagamentos', 'de volta ao painel')
  check(
    await waitFor(
      'S4 volta ao painel',
      async () =>
        (await featureOf(S4.id)) === painel.id && (await cardIn(S4.id, featureLane(painel.id))),
      15_000,
    ),
    'S4 de volta à feat/painel-pagamentos → reentra no card "Painel de pagamentos"',
  )
  await fit()

  // ---------- Encerrada some ----------
  const t0 = Date.now()
  await page.evaluate((id) => window.api.sessions.kill(id), E.id)
  const gone = await waitFor('E some', async () => (await card(E.id).count()) === 0, 5000)
  const took = Date.now() - t0
  check(gone && took <= 2000, `sessão encerrada some do mapa (${took}ms)`)

  // ---------- Enquadrar com a Equipe aberta ----------
  const overlay = page.locator('[data-testid="crew-dock"][data-overlay]')
  if (!(await overlay.isVisible().catch(() => false)))
    // Recolhida, a trilha é o próprio crew-dock (crew-dock-rail só existe com o
    // painel aberto sobre o mapa). O painel da feature, aberto antes, a recolheu.
    await page
      .locator('[data-testid="crew-dock-rail"] button, [data-testid="crew-dock"][data-expanded="false"] button')
      .first()
      .click()
  await waitFor('Equipe aberta', async () => overlay.isVisible(), 8000)
  await fit()
  await shot('enquadrar-com-equipe')
  const dockBox = await overlay.boundingBox()
  const z = await zoom()
  const cards = page.locator('[data-testid="session-card"]')
  const covered: string[] = []
  for (let i = 0; i < (await cards.count()); i++) {
    const b = await cards.nth(i).boundingBox()
    if (b && dockBox && intersects(b, dockBox))
      covered.push((await cards.nth(i).getAttribute('data-session-id')) ?? '?')
  }
  const pill = await page.getByTestId('map-status-counters').boundingBox()
  check(z >= 0.9 - 1e-3, `Enquadrar: zoom ${z.toFixed(2)} >= 0.9`)
  // Largura do conteúdo (cards de topo) levada a 0.9 contra a largura livre à
  // esquerda da Equipe. Se cabe, NENHUM cartão pode ficar sob ela. Se não cabe,
  // o transbordo é aceito (zoom mínimo 0.9, decisão pendente na SPEC) e o que o
  // Enquadrar garante é a prioridade inteira à esquerda.
  const tops = page.locator('[data-testid="lane-feature"], [data-testid="lane-project"]')
  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < (await tops.count()); i++) {
    const b = await tops.nth(i).boundingBox()
    if (!b) continue
    minX = Math.min(minX, b.x)
    maxX = Math.max(maxX, b.x + b.width)
  }
  const mapBox = await page.locator('.react-flow').first().boundingBox()
  const contentAt09 = ((maxX - minX) * 0.9) / z
  const freeW = mapBox && dockBox ? dockBox.x - mapBox.x : 0
  const fits = Number.isFinite(contentAt09) && contentAt09 <= freeW
  if (fits)
    check(
      covered.length === 0,
      `cabe a 0.9 (${Math.round(contentAt09)} <= ${Math.round(freeW)}px): nenhum cartão sob a Equipe (cobertos: ${covered.join(', ') || 'nenhum'})`,
    )
  else
    console.log(
      `[mbf] não cabe a 0.9 (${Math.round(contentAt09)} > ${Math.round(freeW)}px): ${covered.length} cartão(ões) transbordam para trás da Equipe`,
    )
  const s4Box = await card(S4.id).boundingBox()
  check(
    !!dockBox && !!s4Box && !intersects(s4Box, dockBox) && s4Box.x + s4Box.width <= dockBox.x,
    `a prioridade (S4) fica inteira fora da Equipe (cobertos por transbordo: ${covered.length})`,
  )
  check(
    !!pill && !!dockBox && !intersects(pill, dockBox),
    'a pílula de contadores não fica sob a Equipe',
  )
} catch (err) {
  fatal = err
  console.error('[mbf] erro fatal:', err)
  await page.screenshot({ path: join(SHOTS, 'zz-fatal.png') }).catch(() => {})
} finally {
  const proc = app.process()
  logs.stop()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
}

check(
  consoleErrors.length === 0,
  `zero erros de console (${consoleErrors.slice(0, 3).join(' | ')})`,
)
await new Promise((r) => setTimeout(r, 500))
const logText = readFileSync(logs.logFile, 'utf8') + mainOutput()
check(
  /\[feature-resolver\] session .* \(branch\)/.test(logText),
  'log do resolvedor: vínculo por branch',
)
check(
  /\[feature-resolver\] session .* \(worktree\)/.test(logText),
  'log do resolvedor: vínculo por worktree',
)
fake.cleanup()

const failed = results.filter((r) => !r.ok)
console.log('\n[mbf] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(
  `[mbf] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS} · log ${logs.logFile}`,
)
if (fatal || failed.length) process.exit(1)
