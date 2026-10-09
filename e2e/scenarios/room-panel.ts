import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import {
  cleanCopy,
  closeOverlays,
  liveGlobal,
  spawnSession,
  waitFor as seedWaitFor,
} from '../driver/crew-seed'
import { createFakeHome } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// A Room como painel lateral da visão de projeto (feat/room-panel-in-projects), no
// app buildado com HOME fake + stub do claude e cópia do perfil (CM_DRIVE_SAFE=1):
//   1 item "Room" da barra → área Projetos com o painel aberto (não a página Room)
//   2 sessão aberta pelo humano SEM feature e sem filhas é mãe (tile no painel)
//   3 clicar no tile foca a pane real; com a pane fechada, reabre como pane
//   4 Ctrl+` numa feature → painel filtrado + pane da mãe dela em foco
//   5 recolher (botão e Ctrl+Shift+L) persiste; largura persiste
// Rodar: npm run rebuild:native && npm run build, então
//   ROOM_SHOTS=<dir> npx tsx e2e/scenarios/room-panel.ts

const SHOTS = process.env.ROOM_SHOTS ?? join(tmpdir(), `room-panel-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })

const out = {
  checks: [] as Array<{ ok: boolean; label: string }>,
  notes: [] as string[],
  shots: [] as string[],
  pageerrors: [] as string[],
}

function check(ok: boolean, label: string): boolean {
  out.checks.push({ ok, label })
  console.log(`[room-panel] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

const waitFor = (page: Page, label: string, fn: () => Promise<boolean>, timeoutMs?: number) =>
  seedWaitFor(page, label, fn, timeoutMs, out.notes)

async function shot(page: Page, name: string): Promise<void> {
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path }).catch(() => {})
  out.shots.push(path)
}

const panel = (page: Page) => page.getByTestId('room-panel')
const tileOf = (page: Page, id: string) =>
  page.locator(`[data-testid="room-panel"] [data-testid="mother-tile"][data-tile="${id}"]`)
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

// Nem todo repo do banco aparece no seletor do Ctrl+N (a busca pode não achar o
// label): tenta os candidatos em ordem até um abrir.
async function spawnNew(page: Page, labels: string[], used: Set<string>): Promise<string> {
  for (const label of labels.filter((l) => !used.has(l))) {
    used.add(label)
    const before = new Set((await liveGlobal(page)).map((s) => s.id))
    await closeOverlays(page)
    const ok = await spawnSession(page, label).then(
      () => true,
      async () => {
        await page.keyboard.press('Escape')
        out.notes.push(`seletor não abriu ${label}`)
        return false
      },
    )
    if (!ok) continue
    let id = ''
    await waitFor(page, `sessão nova em ${label}`, async () => {
      id = (await liveGlobal(page)).find((s) => !before.has(s.id))?.id ?? ''
      return !!id
    })
    if (id) return id
  }
  throw new Error('nenhum repo abriu pelo Ctrl+N')
}

async function focusedOn(page: Page, id: string): Promise<boolean> {
  const title = (await tileOf(page, id).getByTestId('mother-tile-title').innerText()).trim()
  return waitFor(page, `pane de ${title} em foco`, async () =>
    (await activeTabText(page)).includes(title),
  )
}

async function run(): Promise<void> {
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
  if (repos.length < 2 || features.length < 1) throw new Error('cópia sem 2 repos / feature')
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
    await waitReady(page)
    await page
      .locator('.spl-skip')
      .click({ timeout: 3000 })
      .catch(() => {})
    await page.evaluate(() => localStorage.removeItem('cm:room-panel'))

    // Avulsa: sem feature, sem filhas. Mãe: na feature F.
    const labels = repos.map((r) => r.label)
    const used = new Set<string>()
    const A = await spawnNew(page, labels, used)
    const M = await spawnNew(page, labels, used)
    await page.evaluate(([s, f]) => (window as any).api.sessions.setFeature(s, f), [M, F])
    await page.waitForTimeout(1200)

    // ---- 1. Item "Room" da barra: visão de projeto com o painel, não a página
    await goToArea(page, 'overview')
    await page.getByTestId('rail-room').click()
    check(
      await waitFor(page, 'painel pela barra', () => panel(page).isVisible()),
      '1: item "Room" abre o painel lateral',
    )
    check(!(await page.getByTestId('feature-room').isVisible()), '1: a página Room não abre')
    check(await page.locator('.dv-tab').first().isVisible(), '1: dockview visível ao lado')
    await shot(page, '1-panel')

    // ---- 2. A sessão avulsa (sem feature, sem filhas) é mãe
    check(
      await waitFor(page, 'tile da avulsa', () => tileOf(page, A).isVisible()),
      '2: sessão sem feature e sem filhas tem tile no painel',
    )
    check(await tileOf(page, M).isVisible(), '2: a mãe da feature também')

    // ---- 3. Clicar foca a pane real; pane fechada reabre como pane
    await tileOf(page, A).getByTestId('mother-tile-open').click()
    check(await focusedOn(page, A), '3: clicar no tile foca a pane da avulsa')
    const tabsBefore = await tabCount(page)
    await page.keyboard.press('Control+w')
    await waitFor(page, 'pane fechada', async () => (await tabCount(page)) < tabsBefore)
    check(await tileOf(page, A).isVisible(), '3: fechar a pane não tira a mãe do painel')
    await tileOf(page, A).getByTestId('mother-tile-open').click()
    check(
      await waitFor(page, 'pane reaberta', async () => (await tabCount(page)) === tabsBefore),
      '3: sem pane aberta, o clique reabre como pane',
    )
    check(await focusedOn(page, A), '3: a pane reaberta fica em foco')
    check(!(await page.getByTestId('feature-room').isVisible()), '3: nenhuma página nasce')
    await shot(page, '3-focused')

    // ---- 4. Ctrl+` numa feature: painel filtrado e a pane da mãe dela em foco
    await page.keyboard.down('Control')
    await page.keyboard.press('Backquote')
    await page.waitForTimeout(600)
    const opt = page.locator(`[data-testid="feature-switcher"] [role="option"][data-key="${F}"]`)
    for (let i = 0; i < 20 && (await opt.getAttribute('aria-selected')) !== 'true'; i++) {
      await page.keyboard.press('Tab')
      await page.waitForTimeout(80)
    }
    await page.keyboard.up('Control')
    check(
      await waitFor(page, 'filtro da feature', () =>
        page.getByTestId('room-panel-filter').isVisible(),
      ),
      '4: Ctrl+` filtra o painel na feature',
    )
    check(!(await tileOf(page, A).isVisible()), '4: a avulsa sai do filtro')
    check(await focusedOn(page, M), '4: a pane da mãe da feature fica em foco')
    await shot(page, '4-feature')
    await page.getByTestId('room-panel-filter-clear').click()

    // ---- 5. Recolher e largura persistem
    const handle = page.getByTestId('room-panel-resize')
    const box = await handle.boundingBox()
    if (box) {
      await page.mouse.move(box.x + 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x - 98, box.y + box.height / 2, { steps: 5 })
      await page.mouse.up()
    }
    const afterDrag = await persisted(page)
    check(!!afterDrag && afterDrag.width > 300, `5: largura persistida (${afterDrag?.width})`)
    await page.getByTestId('room-panel-collapse').click()
    check(!(await panel(page).isVisible()), '5: recolher esconde o painel')
    check((await persisted(page))?.open === false, '5: recolhido persiste')
    await page.keyboard.press('Control+Shift+L')
    check(
      await waitFor(page, 'painel pelo atalho', () => panel(page).isVisible()),
      '5: Ctrl+Shift+L mostra de novo',
    )
    check((await persisted(page))?.width === afterDrag?.width, '5: reabre na largura salva')
    await shot(page, '5-reopened')
  } finally {
    await app.close()
  }
}

try {
  await run()
} finally {
  check(out.pageerrors.length === 0, `0 pageerror (${out.pageerrors.length})`)
  const failed = out.checks.filter((c) => !c.ok)
  writeFileSync(join(SHOTS, 'report.json'), JSON.stringify(out, null, 2))
  console.log(
    `[room-panel] ${out.checks.length - failed.length}/${out.checks.length} PASS · ${SHOTS}`,
  )
  if (failed.length > 0) process.exitCode = 1
}
