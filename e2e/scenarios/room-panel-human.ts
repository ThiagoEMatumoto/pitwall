import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { captureLogs } from '../driver/capture'
import { cleanCopy, closeOverlays, liveGlobal, mcpAs } from '../driver/crew-seed'
import { createFakeHome } from '../driver/fake-home'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { goToArea, waitReady } from '../driver/nav'
import { roomStubLogs, writeRoomClaudeStub } from '../driver/room-stub'
import { PERMISSION_FIXTURE } from './attention-reason'

// Fluxo REAL do humano no painel da Room (feat/room-panel-in-projects):
//   a 3 sessões pelo Ctrl+N (2 sem feature, 1 com feature) → 3 mães no painel
//   b uma mãe cria filha via session_handoff → filha não vira tile, conta sob a mãe
//   c clicar no tile foca a pane; pane fechada reabre
//   d composer do tile envia e a resposta aparece
//   e permissão da mãe aprovada no tile
//   f recolher/expandir; relaunch preserva
//   g IconRail "Room" e Ctrl+` levam ao painel com foco
//   h contagem painel = TitleBar = HUD
// Rodar: SB=<dir> npx tsx e2e/scenarios/room-panel-human.ts

const SB = process.env.SB ?? '/tmp/room-panel-human'
mkdirSync(SB, { recursive: true })
const out = {
  checks: [] as Array<{ ok: boolean; label: string }>,
  notes: [] as string[],
  pageerrors: [] as string[],
  consoleErrors: [] as string[],
}
const check = (ok: boolean, label: string) => {
  out.checks.push({ ok, label })
  console.log(`[human] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}
const note = (s: string) => {
  out.notes.push(s)
  console.log(`[human] note — ${s}`)
}
function gitRepo(name: string): string {
  const dir = join(SB, `${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', 'commit', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}
const stamp = Date.now().toString(36)
const L = {
  A: `hp-um-${stamp}`,
  B: `hp-dois-${stamp}`,
  C: `hp-tres-${stamp}`,
  K: `hp-kid-${stamp}`,
}
const paths = { A: gitRepo(L.A), B: gitRepo(L.B), C: gitRepo(L.C), K: gitRepo(L.K) }

const fake = createFakeHome({ parentDir: SB })
const stubPath = writeRoomClaudeStub(fake, PERMISSION_FIXTURE)
const logOf = (cc: string) =>
  roomStubLogs(fake)
    .filter((l) => l.text.split('\n')[0].includes(cc))
    .map((l) => l.text)
    .join('\n')

const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
note(`userData copy: ${userData}`)
await cleanCopy(userData)
writeCopyPrefs(userData, {
  claude_command: stubPath,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

const waitFor = async (page: Page, label: string, fn: () => Promise<boolean>, ms = 20_000) => {
  const t = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - t > ms) {
      note(`timeout: ${label}`)
      await page
        .screenshot({ path: join(SB, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(200)
  }
}
const shot = (page: Page, n: string) =>
  page.screenshot({ path: join(SB, `${n}.png`) }).catch(() => {})

async function boot() {
  const r = await launchApp({
    userDataDir: userData,
    env: fake.env,
    viewport: { width: 1600, height: 950 },
  } as any)
  const logs = captureLogs(r.app, r.page)
  note(`log: ${logs.logFile}`)
  r.page.on('pageerror', (e) => out.pageerrors.push(e.message))
  r.page.on('console', (m) => {
    if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 400))
  })
  await waitReady(r.page)
  await r.page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})
  return { ...r, logs }
}

const panel = (page: Page) => page.getByTestId('room-panel')
const tileOf = (page: Page, id: string) =>
  page.locator(`[data-testid="room-panel"] [data-testid="mother-tile"][data-tile="${id}"]`)
const panelTileIds = (page: Page) =>
  page
    .locator('[data-testid="room-panel"] [data-testid="mother-tile"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tile ?? ''))
const activeTabText = (page: Page) =>
  page
    .locator('.dv-groupview.dv-active-group .dv-tab.dv-active-tab')
    .first()
    .innerText()
    .catch(() => '')
const tabCount = (page: Page) => page.locator('.dv-tab').count()
const persisted = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('cm:room-panel') ?? 'null')) as Promise<{
    open: boolean
    width: number
  } | null>
const num = async (page: Page, sel: string) =>
  Number(
    (
      (await page
        .locator(sel)
        .first()
        .innerText()
        .catch(() => '')) || ''
    ).match(/\d+/)?.[0] ?? 0,
  )
async function focusedOn(page: Page, id: string): Promise<boolean> {
  const title = (await tileOf(page, id).getByTestId('mother-tile-title').innerText()).trim()
  return waitFor(page, `pane de ${title} em foco`, async () =>
    (await activeTabText(page)).includes(title),
  )
}

// Caminho normal do humano: Ctrl+N → repo → diálogo "Nova sessão" → (feature) → Abrir.
async function humanSpawn(page: Page, label: string, featureId?: string): Promise<string> {
  const before = new Set((await liveGlobal(page)).map((s) => s.id))
  await closeOverlays(page)
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)
  await search.fill(label)
  const hit = await waitFor(page, `repo ${label} no seletor`, async () =>
    (await search.inputValue()) === label && !(await page.getByText('Nenhum resultado.').isVisible()),
    8000)
  if (!hit) {
    await page.screenshot({ path: join(SB, `picker-${label}.png`) }).catch(() => {})
    note(`seletor: valor="${await search.inputValue()}"`)
  }
  await search.press('Enter')
  const dialog = page.locator('div.fixed.inset-0', { hasText: `Nova sessão · ${label}` })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  const standard = dialog.getByRole('button', { name: 'Padrão', exact: true })
  if (await standard.count()) await standard.first().click()
  if (featureId) {
    await dialog.getByTestId('spawn-feature-select').click()
    await page.locator(`[role="option"][data-feature-id="${featureId}"]`).first().click()
    check(
      (await dialog.getByTestId('spawn-feature-select').getAttribute('data-feature-id')) ===
        featureId,
      `a: feature escolhida no diálogo de ${label}`,
    )
  }
  await dialog.getByRole('button', { name: 'Abrir', exact: true }).click()
  let id = ''
  await waitFor(page, `sessão nova em ${label}`, async () => {
    id = (await liveGlobal(page)).find((s) => !before.has(s.id) && !!s.ccSessionId)?.id ?? ''
    return !!id
  })
  return id
}

const ids = { P: '', A: '', B: '', C: '', K: '', F: '' }
const S = { A1: '', A2: '', M3: '', kid: '' }
const cc: Record<string, string> = {}
let run = await boot()
try {
  const { page, mainOutput } = run
  check(mainOutput().includes('[drive-safe]'), 'modo seguro ([drive-safe] no boot)')
  await page.evaluate(() => localStorage.removeItem('cm:room-panel'))

  // seed: projeto, 4 repos descartáveis, 1 feature ligada ao repo C
  Object.assign(
    ids,
    await page.evaluate(
      async ({ p, l }) => {
        const api = (window as any).api
        const project = await api.projects.create({ name: `e2e-human-${Date.now()}` })
        const o: Record<string, string> = { P: project.id }
        for (const k of ['A', 'B', 'C', 'K'] as const)
          o[k] = (
            await api.projects.createRepo({ projectId: project.id, label: l[k], path: p[k] })
          ).id
        o.F = (
          await api.features.create({
            projectId: project.id,
            title: 'Human F painel',
            objective: 'feature descartável do e2e humano',
            repos: [
              { repoId: o.C, branch: null, worktreePath: null },
              { repoId: o.K, branch: null, worktreePath: null },
            ],
          })
        ).id
        return o
      },
      { p: paths, l: L },
    ),
  )
  note(`feature F ${ids.F}`)
  await page.reload()
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})
  await goToArea(page, 'projects')

  // ---- (a) 3 sessões pelo caminho normal
  S.A1 = await humanSpawn(page, L.A)
  S.A2 = await humanSpawn(page, L.B)
  S.M3 = await humanSpawn(page, L.C, ids.F)
  check(!!S.A1 && !!S.A2 && !!S.M3, `a: 3 sessões abertas pelo Ctrl+N (${S.A1},${S.A2},${S.M3})`)
  for (const r of await liveGlobal(page)) if (r.ccSessionId) cc[r.id] = r.ccSessionId
  if (!(await panel(page).isVisible())) await page.getByTestId('room-panel-toggle').click()
  check(await waitFor(page, 'painel', () => panel(page).isVisible()), 'a: painel lateral visível')
  check(
    await waitFor(page, '3 tiles', async () => {
      const t = await panelTileIds(page)
      return [S.A1, S.A2, S.M3].every((id) => t.includes(id))
    }),
    'a: as 3 sessões aparecem como mães no painel',
  )
  const tA = await panelTileIds(page)
  check(tA.length === 3, `a: exatamente 3 tiles (${tA.length})`)
  check(
    /3 mães/.test(await page.getByTestId('room-panel-summary').innerText()),
    `a: resumo "3 mães" (${await page.getByTestId('room-panel-summary').innerText()})`,
  )
  await shot(page, 'a-three-mothers')

  // ---- (b) M3 cria filha via session_handoff
  const asM3 = await mcpAs(userData, fake.root, S.M3)
  const hres = await asM3.call<{ handoffId: string }>('session_handoff', {
    targetRepo: L.K,
    task: 'filha e2e humano da M3',
    mode: 'plan',
    featureId: ids.F,
    force: true,
    forceReason: 'validação painel',
  })
  await waitFor(
    page,
    'filha viva',
    async () => {
      const hs = (await page.evaluate(() => (window as any).api.handoffs.list())) as any[]
      S.kid = hs.find((h) => h.id === hres.handoffId)?.childSessionId ?? ''
      return !!S.kid && (await liveGlobal(page)).some((s) => s.id === S.kid && !!s.ccSessionId)
    },
    30_000,
  )
  check(!!S.kid, `b: filha subiu (${S.kid})`)
  await (
    await mcpAs(userData, fake.root, S.kid)
  ).call('handoff_ask', {
    handoffId: hres.handoffId,
    question: 'Posso seguir, M3?',
  })
  await page.waitForTimeout(2500)
  const tB = await panelTileIds(page)
  check(!tB.includes(S.kid) && tB.length === 3, `b: filha não vira tile (${tB.length} tiles)`)
  check(
    await waitFor(
      page,
      'coroa na M3',
      async () => (await tileOf(page, S.M3).locator('[aria-label="tem filhas"]').count()) > 0,
    ),
    'b: tile da M3 marcado "tem filhas"',
  )
  check(
    await waitFor(page, 'pedido da filha sob a M3', async () =>
      /1 pedido das filhas/.test(
        await tileOf(page, S.M3).getByTestId('mother-tile-kids').innerText(),
      ),
    ),
    'b: o pedido da filha aparece sob a M3 ("1 pedido das filhas")',
  )
  const graphKid = await page
    .evaluate(
      async ({ m, k }) => {
        const g = await (window as any).api.sessionGraph.get()
        if (!g) return 'sem api.sessions.graph'
        const n = g.nodes.find((x: any) => x.sessionId === k)
        const e = g.edges.some((x: any) => (x.from ?? x.source) === m && (x.to ?? x.target) === k)
        return JSON.stringify({ isRoot: n?.isRoot, edge: e })
      },
      { m: S.M3, k: S.kid },
    )
    .catch((e) => `erro ${e}`)
  note(`grafo filha: ${graphKid}`)
  await shot(page, 'b-kid-under-mother')

  // ---- (h) contagem painel = TitleBar = HUD (com 1 pedido da filha)
  const countsNow = async (label: string) => {
    await closeOverlays(page)
    await page.waitForTimeout(1200)
    const pnl = await num(page, '[data-testid="room-panel-badge"]')
    const tb = (await page.getByTestId('titlebar-attention-badge').count())
      ? await num(page, '[data-testid="titlebar-attention-badge"]')
      : 0
    await page.keyboard.press('Alt+a')
    await page.waitForTimeout(700)
    const hudText = await page
      .getByTestId('attention-hud')
      .innerText()
      .catch(() => '')
    const m = /(\d+)\s*\/\s*(\d+)/.exec(hudText)
    const hud = m ? Number(m[2]) : /nada esperando/i.test(hudText) ? 0 : -1
    await shot(page, `h-hud-${label}`)
    await page.keyboard.press('Escape')
    await closeOverlays(page)
    check(
      pnl === tb && tb === hud,
      `h(${label}): painel ${pnl} = TitleBar ${tb} = HUD ${hud} [hud="${hudText.replace(/\s+/g, ' ').slice(0, 80)}"]`,
    )
    return pnl
  }
  const n1 = await countsNow('kid-ask')
  check(n1 >= 1, `h: há ≥1 pedido contado (${n1})`)

  // ---- (c) clicar foca a pane; fechada reabre
  await goToArea(page, 'projects')
  await tileOf(page, S.A1).getByTestId('mother-tile-open').click()
  check(await focusedOn(page, S.A1), 'c: clicar no tile da A1 foca a pane real dela')
  await tileOf(page, S.A2).getByTestId('mother-tile-open').click()
  check(await focusedOn(page, S.A2), 'c: clicar no tile da A2 foca a pane real dela')
  const tabsBefore = await tabCount(page)
  await page.keyboard.press('Control+w')
  await waitFor(page, 'pane fechada', async () => (await tabCount(page)) < tabsBefore)
  check((await tabCount(page)) < tabsBefore, 'c: Ctrl+W fechou a pane da A2')
  check(await tileOf(page, S.A2).isVisible(), 'c: fechar a pane não tira a mãe do painel')
  await tileOf(page, S.A2).getByTestId('mother-tile-open').click()
  check(
    await waitFor(page, 'pane reaberta', async () => (await tabCount(page)) === tabsBefore),
    'c: pane fechada reabre ao clicar no tile',
  )
  check(await focusedOn(page, S.A2), 'c: a pane reaberta fica em foco')
  check(!(await page.getByTestId('feature-room').isVisible()), 'c: nenhuma página Room nasce')
  await shot(page, 'c-focused')

  // ---- (d) composer do tile
  const cA1 = tileOf(page, S.A1).getByTestId('card-prompt')
  await cA1.click()
  await cA1.fill('status painel?')
  await cA1.press('Enter')
  check(
    await waitFor(page, 'stub A1 recebe', async () =>
      logOf(cc[S.A1]).includes('line:status painel?'),
    ),
    'd: o texto do composer chega à sessão A1',
  )
  check(
    !logOf(cc[S.A2]).includes('line:status painel?') &&
      !logOf(cc[S.M3]).includes('line:status painel?'),
    'd: e não às outras',
  )
  check(
    await waitFor(page, 'resposta no tile', async () =>
      /RESPOSTA-MAE: status painel\?/.test(
        await tileOf(page, S.A1).getByTestId('mother-tile-tail').innerText(),
      ),
    ),
    'd: a resposta aparece no tile da A1',
  )
  await shot(page, 'd-composer')

  // ---- (e) permissão da A2 aprovada no tile
  // A captura do menu (fixture) tem 80 colunas: com 3 panes + painel a pane fica
  // estreita e o xterm quebra a captura. Fecha A1 e M3 (as PTYs seguem vivas).
  await page.keyboard.press('Escape')
  for (const id of [S.A1, S.M3]) {
    await tileOf(page, id).getByTestId('mother-tile-open').click()
    await focusedOn(page, id)
    const n = await tabCount(page)
    await page.keyboard.press('Control+w')
    await waitFor(page, 'fechar pane', async () => (await tabCount(page)) < n)
  }
  const cols = await page.evaluate(() => {
    const t = document.querySelector('.dv-groupview.dv-active-group .xterm-screen') as HTMLElement | null
    return t ? Math.round(t.getBoundingClientRect().width) : 0
  })
  note(`largura da pane A2: ${cols}px`)
  await page.waitForTimeout(800)
  const cA2 = tileOf(page, S.A2).getByTestId('card-prompt')
  await cA2.click()
  await cA2.fill('PEDE-PERMISSAO painel')
  await cA2.press('Enter')
  const approve = tileOf(page, S.A2)
    .getByTestId('mother-tile-menu')
    .getByTestId('attention-action-approve')
  check(
    await waitFor(page, 'menu no tile A2', () => approve.isVisible(), 25_000),
    'e: pedido de permissão aparece no tile da A2',
  )
  await page.keyboard.press('Escape')
  await shot(page, 'e-permission')
  const n2 = await countsNow('perm')
  check(n2 === n1 + 1, `h: permissão soma 1 no painel (${n1} → ${n2})`)
  await goToArea(page, 'projects')
  await approve.click()
  check(
    await waitFor(page, 'stub A2 aprovado', async () => logOf(cc[S.A2]).includes('menu-answer:1')),
    'e: Aprovar no tile responde o menu (stub recebe "1")',
  )
  check(
    await waitFor(page, 'menu some', async () => !(await approve.isVisible())),
    'e: o menu sai do tile',
  )
  check((logOf(cc[S.A2]).match(/menu-answer:/g) ?? []).length === 1, 'e: respondido uma vez só')
  await shot(page, 'e-approved')
  const n3 = await countsNow('approved')
  check(n3 === n1, `h: após aprovar volta a ${n1} (${n3})`)

  // ---- (g) IconRail "Room" e Ctrl+`
  await goToArea(page, 'overview')
  await page.getByTestId('rail-room').click()
  check(
    await waitFor(page, 'painel pelo rail', () => panel(page).isVisible()),
    'g: IconRail "Room" abre a visão de projeto com o painel',
  )
  check(!(await page.getByTestId('feature-room').isVisible()), 'g: sem página Room')
  check(await page.locator('.dv-tab').first().isVisible(), 'g: dockview ao lado')
  await shot(page, 'g-rail')
  await goToArea(page, 'overview')
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  await page.waitForTimeout(600)
  const opt = page.locator(`[data-testid="feature-switcher"] [role="option"][data-key="${ids.F}"]`)
  for (
    let i = 0;
    i < 25 && (await opt.getAttribute('aria-selected').catch(() => null)) !== 'true';
    i++
  ) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(80)
  }
  const optFound = (await opt.getAttribute('aria-selected').catch(() => null)) === 'true'
  await page.keyboard.up('Control')
  check(optFound, 'g: Ctrl+` lista a feature F')
  check(
    await waitFor(page, 'painel filtrado', () => page.getByTestId('room-panel-filter').isVisible()),
    'g: Ctrl+` abre o painel filtrado na feature (vindo de outra área)',
  )
  const tG = await panelTileIds(page)
  check(tG.length === 1 && tG[0] === S.M3, `g: só a M3 no filtro (${tG.join(',')})`)
  check(await focusedOn(page, S.M3), 'g: a pane da M3 fica em foco')
  await shot(page, 'g-ctrl-backquote')
  await page.getByTestId('room-panel-filter-clear').click()

  // ---- (f) recolher/expandir + relaunch
  const handle = page.getByTestId('room-panel-resize')
  const box = await handle.boundingBox()
  if (box) {
    await page.mouse.move(box.x + 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
  }
  const w0 = (await persisted(page))?.width ?? 0
  check(w0 > 360, `f: largura arrastada persistida (${w0})`)
  await page.getByTestId('room-panel-collapse').click()
  check(!(await panel(page).isVisible()), 'f: recolher esconde')
  await page.getByTestId('room-panel-toggle').click()
  check(await waitFor(page, 'expandir', () => panel(page).isVisible()), 'f: expandir mostra')
  check(
    Math.round((await panel(page).boundingBox())?.width ?? 0) === w0,
    'f: reabre na largura salva',
  )
  await page.getByTestId('room-panel-collapse').click()
  check((await persisted(page))?.open === false, 'f: recolhido persistido antes do relaunch')
  await shot(page, 'f-collapsed')

  run.logs.stop()
  await run.app.close()
  run = await boot()
  const p2 = run.page
  await goToArea(p2, 'projects')
  await p2.waitForTimeout(1500)
  check(!(await panel(p2).isVisible()), 'f: após relaunch continua recolhido')
  await p2.getByTestId('room-panel-toggle').click()
  check(
    await waitFor(p2, 'expandir pós-relaunch', () => panel(p2).isVisible()),
    'f: expande após relaunch',
  )
  check(
    Math.round((await panel(p2).boundingBox())?.width ?? 0) === w0,
    `f: largura preservada no relaunch (${Math.round((await panel(p2).boundingBox())?.width ?? 0)} vs ${w0})`,
  )
  await shot(p2, 'f-relaunch-open')
  run.logs.stop()
  await run.app.close()
  run = await boot()
  await goToArea(run.page, 'projects')
  check(
    await waitFor(run.page, 'aberto pós-relaunch', () => panel(run.page).isVisible()),
    'f: aberto também persiste no relaunch',
  )
  await shot(run.page, 'f-relaunch2')
} catch (e) {
  check(false, `exceção ${(e as Error).stack ?? e}`)
  await shot(run.page, 'exception')
} finally {
  for (const id of Object.values(S).filter(Boolean))
    await run.page.evaluate((s) => (window as any).api.sessions.kill(s), id).catch(() => {})
  await run.page.waitForTimeout(800).catch(() => {})
  run.logs.stop()
  await run.app.close().catch(() => {})
}

check(out.pageerrors.length === 0, `0 pageerror (${out.pageerrors.length})`)
check(out.consoleErrors.length === 0, `0 console error (${out.consoleErrors.length})`)
for (const e of [...out.pageerrors, ...out.consoleErrors]) note(e)
const failed = out.checks.filter((c) => !c.ok)
console.log(
  `\n[human] RESULT ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${out.checks.length - failed.length}/${out.checks.length} · ${SB}`,
)
writeFileSync(join(SB, 'result.json'), JSON.stringify(out, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
