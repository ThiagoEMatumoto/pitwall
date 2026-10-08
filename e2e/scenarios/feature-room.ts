import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import {
  cleanCopy,
  closeOverlays,
  liveGlobal,
  mcpAs,
  spawnSession,
  waitFor as seedWaitFor,
} from '../driver/crew-seed'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// Room da feature (feat/feature-room-page) no app buildado, HOME fake + stub do
// claude, cópia do perfil (CM_DRIVE_SAFE=1). Estados criados DEPOIS do boot pelos
// caminhos de produção (UI, MCP do próprio processo, IPC do renderer):
//   2 → 1 → (mãe de novo) → 3 → 4 → 5 → 6 → 7
//   2 "1 sessão só"  · 1 vazio (kill da mãe com a Room aberta) · 3 tudo verde ·
//   4 normal (pergunta, falha, interrompida) · 5 Ctrl+` de Home · 6 regressões ·
//   7 protótipo C (toggle Room v1) lado a lado, se ROOM_PROTO apontar o HTML.
// Rodar: npm run rebuild:native && npm run build, então
//   ROOM_SHOTS=<dir> ROOM_PROTO=<prototype.html> npx tsx e2e/scenarios/feature-room.ts

const SHOTS = process.env.ROOM_SHOTS ?? join(tmpdir(), `feature-room-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const PROTO = process.env.ROOM_PROTO
const W = 1440
const H = 900
const STATES = ['empty', 'solo', 'green', 'normal'] as const

const out = {
  checks: [] as Array<{ ok: boolean; label: string }>,
  notes: [] as string[],
  shots: [] as string[],
  pageerrors: [] as string[],
}

function check(ok: boolean, label: string): boolean {
  out.checks.push({ ok, label })
  console.log(`[room] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

const waitFor = (page: Page, label: string, fn: () => Promise<boolean>, timeoutMs?: number) =>
  seedWaitFor(page, label, fn, timeoutMs, out.notes)

async function shot(page: Page, name: string): Promise<void> {
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path }).catch(() => {})
  out.shots.push(path)
}

const numberIn = (text: string | null | undefined) => Number.parseInt(text ?? '', 10) || 0
const room = (page: Page) => page.getByTestId('feature-room')
const roomState = (page: Page) => room(page).getAttribute('data-state')
const roomCount = async (page: Page) =>
  numberIn(await page.getByTestId('room-needs-count').innerText())

// Igual ao wakesText da RoomHealth: o chip tem de dizer o que room:get devolve.
function wakesText(w: { attempted: number; delivered: number; missing: number }): string {
  if (w.attempted === 0) return 'sem avisos à mãe em 24h'
  const pct = Math.round((100 * w.delivered) / w.attempted)
  const missing = w.missing > 0 ? ` · ${w.missing} sem tentativa` : ''
  return `wakes entregues 24h · ${w.delivered}/${w.attempted} (${pct}%)${missing}`
}

// countForLane da projeção para a feature, com o MESMO inUse do Ctrl+` (grafo vivo
// ∪ PTYs vivas): o número que a Room e o card têm de mostrar.
async function laneCount(page: Page, featureId: string): Promise<number> {
  return page.evaluate(async (f) => {
    const api = (window as any).api
    const [items, graph, live] = await Promise.all([
      api.attention.list(),
      api.sessionGraph.get(),
      api.sessions.listLiveGlobal(),
    ])
    const inUse = new Set<string>([
      ...graph.nodes.filter((n: any) => n.status !== 'ended').map((n: any) => n.sessionId),
      ...live.map((s: any) => s.id),
    ])
    const lane = graph.lanes.find((l: any) => l.kind === 'feature' && l.featureId === f)
    const laneIds = new Set<string>(
      (lane?.repos ?? []).flatMap((r: any) => r.sessionIds).filter((id: string) => inUse.has(id)),
    )
    const keys = new Set(
      items
        .filter((i: any) => i.severity !== 'info')
        .filter((i: any) =>
          i.sessionId && inUse.has(i.sessionId) ? laneIds.has(i.sessionId) : i.featureId === f,
        )
        .map((i: any) => (i.sessionId ? `s:${i.sessionId}` : `h:${i.handoffId ?? i.dedupKey}`)),
    )
    return keys.size
  }, featureId)
}

// Ctrl+` segurado, Tab até o card da feature, soltar confirma. Devolve o needsYou
// do card (lido antes de soltar) ou null se a feature não tem card.
async function switchByKeyboard(
  page: Page,
  key: string,
  shotName?: string,
): Promise<number | null> {
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  await page.waitForTimeout(600)
  const opt = page.locator(`[data-testid="feature-switcher"] [role="option"][data-key="${key}"]`)
  if (!(await opt.count())) {
    await page.keyboard.press('Escape')
    await page.keyboard.up('Control')
    return null
  }
  for (let i = 0; i < 20 && (await opt.getAttribute('aria-selected')) !== 'true'; i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(80)
  }
  const badge = opt.getByTestId('feature-switcher-attention')
  const needs = (await badge.count()) ? numberIn(await badge.innerText()) : 0
  if (shotName) await shot(page, shotName)
  await page.keyboard.up('Control')
  await page.waitForTimeout(600)
  return needs
}

async function handoffStatus(page: Page, id: string): Promise<string | undefined> {
  const hs = (await page.evaluate(() => (window as any).api.handoffs.list())) as Array<{
    id: string
    status: string
  }>
  return hs.find((h) => h.id === id)?.status
}

async function openMap(page: Page): Promise<void> {
  await goToArea(page, 'projects')
  await page
    .getByRole('button', { name: /Mapa/ })
    .first()
    .click()
    .catch(() => {})
  await page.getByTestId('session-map').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(800)
}

async function phaseStub(): Promise<void> {
  const fake = createFakeHome({ parentDir: tmpdir() })
  const first = await launchApp()
  await first.app.close()
  const userData = first.userDataCopy
  const repos = (
    await queryDb<{ id: string; label: string; path: string }>(
      userData,
      'SELECT id, label, path FROM repos ORDER BY label',
    )
  ).filter(
    (r, i, all) => r.path?.startsWith('/') && all.filter((x) => x.label === r.label).length === 1,
  )
  const features = await queryDb<{ id: string; title: string }>(
    userData,
    "SELECT id, title FROM features WHERE status NOT IN ('done','archived') AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1",
  )
  if (repos.length < 5 || features.length < 1) throw new Error('cópia sem 5 repos / 1 feature')
  const F = features[0].id
  out.notes.push(`feature: ${features[0].title} (${F})`)
  await cleanCopy(userData)
  writeCopyPrefs(userData, {
    claude_command: fake.fakeCliPath('claude'),
    keybindings: null,
    'app.showIntroOnBoot': JSON.stringify(false),
    'session.defaultPaneMode': JSON.stringify('terminal'),
    'handoffs.requireApproval': JSON.stringify(false),
  })

  const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
  const logs = captureLogs(app, page)
  out.notes.push(`log: ${logs.logFile}`)
  page.on('pageerror', (e) => out.pageerrors.push(e.message))
  try {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        win.unmaximize()
        win.setContentSize(size.w, size.h)
      },
      { w: W, h: H },
    )
    await waitReady(page)
    await page
      .locator('.spl-skip')
      .click({ timeout: 3000 })
      .catch(() => {})
    const files = (): FakeSessionEntry[] => fake.readSessionFiles()
    const [motherRepo, looseRepo, ...childRepos] = repos

    const spawnMother = async (): Promise<string> => {
      const before = new Set((await liveGlobal(page)).map((s) => s.id))
      await spawnSession(page, motherRepo.label)
      let id = ''
      await waitFor(page, 'mãe viva', async () => {
        id =
          (await liveGlobal(page)).find((s) => s.repo?.id === motherRepo.id && !before.has(s.id))
            ?.id ?? ''
        return !!id
      })
      await page.evaluate(([s, f]) => (window as any).api.sessions.setFeature(s, f), [id, F])
      await waitFor(page, 'mãe na lane da feature', async () =>
        page.evaluate(
          async ([s, f]) => {
            const g = await (window as any).api.sessionGraph.get()
            const lane = g.lanes.find((l: any) => l.kind === 'feature' && l.featureId === f)
            return !!lane?.repos.some((r: any) => r.sessionIds.includes(s))
          },
          [id, F],
        ),
      )
      return id
    }

    // ---- 2. 1 sessão só (Ctrl+` → card da feature → Room)
    let M = await spawnMother()
    await page.waitForTimeout(1500)
    const soloCard = await switchByKeyboard(page, F)
    check(soloCard !== null, '2: a feature com a mãe tem card no Ctrl+`')
    check(await room(page).isVisible(), '2: confirmar o card abre a Room')
    await waitFor(page, 'Room solo', async () => (await roomState(page)) === 'solo')
    check((await roomState(page)) === 'solo', '2: estado solo')
    check(await page.getByTestId('room-mother').isVisible(), '2: card da mãe visível')
    check((await page.getByTestId('room-child-row').count()) === 0, '2: nenhuma filha')
    await shot(page, 'app-solo')

    // ---- 1. vazio: a última sessão sai com a Room aberta
    await page.evaluate((id) => (window as any).api.sessions.kill(id), M)
    await waitFor(page, 'Room vazia', async () => (await roomState(page)) === 'empty', 20_000)
    check((await roomState(page)) === 'empty', '1: estado vazio depois do kill da mãe')
    check(
      await room(page).getByText('Nenhuma sessão nesta feature').isVisible(),
      '1: texto "Nenhuma sessão nesta feature"',
    )
    check(await page.getByTestId('room-new-child').isDisabled(), '1: "+ Filha" desabilitado')
    await shot(page, 'app-empty')

    // ---- 3. tudo verde: 3 filhas rodando, nenhuma pergunta
    M = await spawnMother()
    const asM = await mcpAs(userData, fake.root, M)
    const kids: Array<{ handoffId: string; sessionId: string; ccSessionId: string }> = []
    for (const [i, repo] of childRepos.slice(0, 3).entries()) {
      const before = new Set(files().map((f) => f.data.pid))
      const res = await asM.call<{ handoffId: string }>('session_handoff', {
        targetRepo: repo.label,
        task: `room ${i}`,
        mode: 'plan',
        featureId: F,
        force: true,
        forceReason: 'validação feature-room',
      })
      await waitFor(page, `filha ${i}`, async () => files().some((f) => !before.has(f.data.pid)))
      let sid = ''
      let cc = ''
      await waitFor(page, `sessão da filha ${i}`, async () => {
        const hs = (await page.evaluate(() => (window as any).api.handoffs.list())) as Array<{
          id: string
          childSessionId: string | null
        }>
        sid = hs.find((h) => h.id === res.handoffId)?.childSessionId ?? ''
        cc = (await liveGlobal(page)).find((s) => s.id === sid)?.ccSessionId ?? ''
        return !!cc
      })
      kids.push({ handoffId: res.handoffId, sessionId: sid, ccSessionId: cc })
    }
    await switchByKeyboard(page, F)
    await waitFor(page, 'Room verde', async () => (await roomState(page)) === 'green', 20_000)
    check((await roomState(page)) === 'green', '3: estado tudo verde')
    check(
      await room(page).getByText('Nada precisa de você').isVisible(),
      '3: texto "Nada precisa de você"',
    )
    check((await roomCount(page)) === 0, '3: room-needs-count = 0')
    check((await page.getByTestId('room-child-row').count()) === 3, '3: 3 linhas de filha')
    await shot(page, 'app-green')

    // ---- 4. normal: pergunta, falha, interrompida
    await (
      await mcpAs(userData, fake.root, kids[0].sessionId)
    ).call('handoff_ask', {
      handoffId: kids[0].handoffId,
      question: 'Posso apagar o índice antigo?',
    })
    await page.evaluate(
      (id) => (window as any).api.handoffs.fail({ id, error: 'validação: forçar falha' }),
      kids[1].handoffId,
    )
    const projDir = join(fake.home, '.claude', 'projects', 'room')
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, `${kids[2].ccSessionId}.jsonl`), '{"type":"summary"}\n')
    await page.evaluate((id) => (window as any).api.sessions.kill(id), kids[2].sessionId)
    await waitFor(page, 'Room com 3 na fila', async () => (await roomCount(page)) === 3, 30_000)
    await page.waitForTimeout(1500)
    check((await roomState(page)) === 'normal', '4: estado normal')
    const n = await roomCount(page)
    const lane = await laneCount(page, F)
    const card = await switchByKeyboard(page, F, 'ctrl-backquote-normal')
    await waitFor(page, 'Room de volta', async () => room(page).isVisible())
    check(
      n === card && card === lane,
      `4: Room ${n} == card do Ctrl+\` ${card} == countForLane da projeção ${lane}`,
    )
    check(
      numberIn(await page.getByTestId('room-features-badge').innerText()) === n,
      '4: badge do botão Features == contador da Room',
    )
    check((await page.getByTestId('room-queue-open').count()) === 1, '4: um item aberto')
    await shot(page, 'app-normal')

    const openText = () => page.getByTestId('room-queue-open').innerText()
    const firstText = await openText()
    await page.locator('#room-queue-h').click()
    await page.keyboard.press('j')
    await page.waitForTimeout(300)
    check((await openText()) !== firstText, '4: J abre o 2º item')
    await page.keyboard.press('k')
    await page.waitForTimeout(300)
    check((await openText()) === firstText, '4: K volta ao 1º')

    // Pergunta: abrir pela linha, Peek + Esc, depois responder pela Room.
    const qRow = page.locator('[data-testid="room-queue-row"][data-kind="child_question"]')
    const collapsed = qRow.locator('button[aria-expanded="false"]')
    if (await collapsed.count()) await collapsed.click()
    await page.waitForTimeout(300)
    await qRow.getByRole('button', { name: 'Peek', exact: true }).click()
    const peekOpen = await waitFor(
      page,
      'peek aberto',
      async () => (await page.locator('[data-peek-mode]').count()) > 0,
      10_000,
    )
    check(peekOpen, '4: Peek abre o CrewPeek')
    await shot(page, 'app-normal-peek')
    await page.keyboard.press('Escape')
    const peekClosed = await waitFor(
      page,
      'peek fechado',
      async () => (await page.locator('[data-peek-mode]').count()) === 0,
      5_000,
    )
    check(peekClosed, '4: Esc fecha o peek')
    await closeOverlays(page)

    await qRow.getByRole('textbox', { name: 'Resposta' }).fill('Pode, o índice novo já cobre.')
    await qRow.getByRole('button', { name: 'Responder e retomar' }).click()
    const answered = await waitFor(
      page,
      'filha 0 running',
      async () => (await handoffStatus(page, kids[0].handoffId)) === 'running',
      20_000,
    )
    const status = await qRow
      .getByRole('status')
      .innerText()
      .catch(() => '')
    if (status) out.notes.push(`resposta: ${status}`)
    check(answered, '4: responder pela Room retoma a filha 0 (running)')
    check(
      await waitFor(page, 'pergunta saiu', async () => (await qRow.count()) === 0, 10_000),
      '4: o item da pergunta sai da fila',
    )

    const iRow = page.locator('[data-testid="room-queue-row"][data-kind="child_interrupted"]')
    const iCollapsed = iRow.locator('button[aria-expanded="false"]')
    if (await iCollapsed.count()) await iCollapsed.click()
    await page.waitForTimeout(300)
    await iRow.getByRole('button', { name: 'Retomar' }).click()
    check(
      await waitFor(
        page,
        'filha 2 running',
        async () => (await handoffStatus(page, kids[2].handoffId)) === 'running',
        30_000,
      ),
      '4: "Retomar" na interrompida volta a running',
    )

    const t0 = Date.now()
    const snap = (await page.evaluate((f) => (window as any).api.room.get(f), F)) as {
      wakeHealth: { attempted: number; delivered: number; missing: number }
    }
    out.notes.push(`room:get ${Date.now() - t0}ms (inclui IPC)`)
    check(
      (await page.getByTestId('room-wakes').innerText()).trim() === wakesText(snap.wakeHealth),
      `4: room-wakes bate com wakeHealth (${wakesText(snap.wakeHealth)})`,
    )
    await shot(page, 'app-normal-after-actions')

    // ---- 5. Ctrl+` de Home
    await page
      .getByTitle(/^Home($| ·)/)
      .first()
      .click()
    await page.waitForTimeout(800)
    check(
      !(await room(page)
        .isVisible()
        .catch(() => false)),
      '5: em Home a Room não está na tela',
    )
    await switchByKeyboard(page, F, 'ctrl-backquote-home')
    check(await room(page).isVisible(), '5: Ctrl+` + soltar no card da feature abre a Room')
    await shot(page, 'ctrl-backquote')

    // ---- 6. regressões
    await page
      .getByTitle(/^Home($| ·)/)
      .first()
      .click()
    await page.waitForTimeout(800)
    const inBox = numberIn(
      await page
        .getByTestId('home-in-box')
        .innerText()
        .catch(() => ''),
    )
    const projection = await page.evaluate(async () => {
      const items = (await (window as any).api.attention.list()) as any[]
      return new Set(
        items
          .filter((i) => i.severity !== 'info')
          .map((i) => (i.sessionId ? `s:${i.sessionId}` : `h:${i.handoffId ?? i.dedupKey}`)),
      ).size
    })
    check(inBox === projection, `6: Home "No box" ${inBox} == projeção ${projection}`)
    await shot(page, 'reg-home')

    await openMap(page)
    check(
      await page.getByTestId('session-map').isVisible(),
      '6: IconRail Projetos → mapa renderiza',
    )
    await shot(page, 'reg-map')
    const header = page
      .locator(`[data-testid="lane-feature"][data-feature-id="${F}"]`)
      .getByTestId('feature-card-header')
    await header.click()
    check(
      await waitFor(
        page,
        'FeaturePanel',
        async () => page.getByTestId('feature-panel').isVisible(),
        10_000,
      ),
      '6: FeaturePanel abre pelo card do mapa',
    )
    await shot(page, 'reg-feature-panel')
    await page.keyboard.press('Escape')
    await closeOverlays(page)

    await switchByKeyboard(page, F)
    await page.getByTestId('room-see-map').click()
    await page.waitForTimeout(1500)
    check(
      (await page.getByTestId('session-map').isVisible()) &&
        !(await room(page)
          .isVisible()
          .catch(() => false)) &&
        (await page.locator(`[data-testid="lane-feature"][data-feature-id="${F}"]`).isVisible()),
      '6: "Ver no mapa" da Room leva ao mapa com a feature na tela',
    )
    await shot(page, 'reg-see-map')

    // "Sem feature": uma sessão avulsa num repo sem feature.
    await spawnSession(page, looseRepo.label)
    let loose = ''
    await waitFor(page, 'sessão avulsa', async () => {
      loose = (await liveGlobal(page)).find((s) => s.repo?.id === looseRepo.id)?.id ?? ''
      return !!loose
    })
    await page.evaluate((id) => (window as any).api.sessions.setFeature(id, null), loose)
    await page.waitForTimeout(2000)
    await page.keyboard.down('Control')
    await page.keyboard.press('Backquote')
    await page.waitForTimeout(600)
    const projectOpt = page.locator(
      '[data-testid="feature-switcher"] [role="option"][data-kind="project"]',
    )
    const hasProject = (await projectOpt.count()) > 0
    if (hasProject) await projectOpt.first().click()
    else await page.keyboard.press('Escape')
    await page.keyboard.up('Control')
    await page.waitForTimeout(1200)
    check(
      hasProject &&
        (await page.getByTestId('session-map').isVisible()) &&
        !(await room(page)
          .isVisible()
          .catch(() => false)),
      '6: card "Sem feature" no Ctrl+` ainda vai para o mapa',
    )
    await shot(page, 'reg-sem-feature')

    await openMap(page)
    await page.getByTestId('map-feature-switcher').click()
    await page.waitForTimeout(600)
    await page.locator(`[data-testid="feature-switcher"] [role="option"][data-key="${F}"]`).click()
    await page.waitForTimeout(1200)
    check(
      (await page.getByTestId('session-map').isVisible()) &&
        !(await room(page)
          .isVisible()
          .catch(() => false)),
      '6: botão "Trocar feature" do mapa + card da feature continua no mapa (OPEN-8)',
    )
    await shot(page, 'reg-map-button')
  } finally {
    logs.stop()
    await app.close()
  }
}

// ---- 7. protótipo C, toggle "Room v1", lado a lado
async function phasePrototype(): Promise<void> {
  if (!PROTO) {
    out.notes.push('ROOM_PROTO ausente: comparação com o protótipo pulada')
    return
  }
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } })
    await page.goto(`file://${PROTO}`)
    const toggle = page.locator('#v1Toggle')
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    check((await toggle.getAttribute('aria-pressed')) === 'true', '7: protótipo no toggle Room v1')
    for (const s of STATES) {
      await page.locator(`[data-sc="${s}"]`).click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(SHOTS, `proto-${s}.png`) })
    }
  } finally {
    await browser.close()
  }
  const rows = STATES.map(
    (s) =>
      `<h2>${s}</h2><div class="pair"><figure><img src="app-${s}.png"><figcaption>app</figcaption></figure><figure><img src="proto-${s}.png"><figcaption>protótipo C · Room v1</figcaption></figure></div>`,
  ).join('\n')
  writeFileSync(
    join(SHOTS, 'compare.html'),
    `<!doctype html><meta charset="utf-8"><title>Room × protótipo C</title>
<style>body{background:#111;color:#ddd;font:14px system-ui;margin:16px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}img{width:100%;border:1px solid #333}figure{margin:0}</style>
<p>Divergências de propósito: wakes no cabeçalho (OPEN-2: o v1 esconde o %, o requisito 6 mostra);
result_unconsumed fora da fila, vira pílula na linha da filha (OPEN-1); botões Sala/Mapa viram "Ver no mapa";
"Abrir sessão-mãe" do vazio omitido (OPEN-6); nota "Room v1" do protótipo é dele, não do produto.</p>
${rows}`,
  )
  out.shots.push(join(SHOTS, 'compare.html'))
  out.notes.push('OPEN-2 wakes e OPEN-1 result_unconsumed divergem do protótipo v1 de propósito')
}

try {
  await phaseStub()
  await phasePrototype()
} finally {
  check(out.pageerrors.length === 0, `0 pageerror (${out.pageerrors.length})`)
  const failed = out.checks.filter((c) => !c.ok)
  writeFileSync(
    join(SHOTS, 'report.json'),
    JSON.stringify({ ...out, pageerrorCount: out.pageerrors.length }, null, 2),
  )
  console.log(`[room] ${out.checks.length - failed.length}/${out.checks.length} PASS · ${SHOTS}`)
}
