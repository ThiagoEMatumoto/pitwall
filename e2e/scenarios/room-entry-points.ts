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

// Os 3 caminhos até a Room (feat/room-entry-points) no app buildado, HOME fake +
// stub do claude, cópia do perfil (CM_DRIVE_SAFE=1):
//   1 Ctrl+` (com a dica única na 1ª abertura) → visão de projeto com o painel da
//     Room filtrado na feature e a pane da mãe em foco · 2 "Abrir Room" no card da
//     Home → sala da feature · 3 item "Room" da barra → painel (+ badge igual ao
//     "N no box" da TitleBar); "Todas as mães" pelo ⤢ do painel, Enter no tile → sala.
// Rodar: npm run rebuild:native && npm run build, então
//   ROOM_SHOTS=<dir> npx tsx e2e/scenarios/room-entry-points.ts

const SHOTS = process.env.ROOM_SHOTS ?? join(tmpdir(), `room-entry-points-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })

const out = {
  checks: [] as Array<{ ok: boolean; label: string }>,
  notes: [] as string[],
  shots: [] as string[],
  pageerrors: [] as string[],
}

function check(ok: boolean, label: string): boolean {
  out.checks.push({ ok, label })
  console.log(`[room-entry] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

const waitFor = (page: Page, label: string, fn: () => Promise<boolean>, timeoutMs?: number) =>
  seedWaitFor(page, label, fn, timeoutMs, out.notes)

async function shot(page: Page, name: string): Promise<void> {
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path }).catch(() => {})
  out.shots.push(path)
}

const room = (page: Page) => page.getByTestId('feature-room')
const roomTitle = async (page: Page) =>
  (
    await page
      .getByTestId('room-title')
      .innerText()
      .catch(() => '')
  ).trim()
const panel = (page: Page) => page.getByTestId('room-panel')
const panelTile = (page: Page, id: string) =>
  page.locator(`[data-testid="room-panel"] [data-testid="mother-tile"][data-tile="${id}"]`)
const activeTabText = (page: Page) =>
  page
    .locator('.dv-groupview.dv-active-group .dv-tab.dv-active-tab')
    .first()
    .innerText()
    .catch(() => '')
const numberIn = (text: string | null | undefined) => Number.parseInt(text ?? '', 10) || 0

async function leaveRoom(page: Page): Promise<void> {
  await closeOverlays(page)
  await goToArea(page, 'overview')
  await waitFor(page, 'fora da Room', async () => !(await room(page).isVisible()))
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
  if (repos.length < 1 || features.length < 1) throw new Error('cópia sem repo / feature')
  const F = features[0].id
  const title = features[0].title
  out.notes.push(`feature: ${title} (${F})`)
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
    // Perfil copiado = "depois do update": a dica ainda não foi vista nele.
    await page.evaluate(() => localStorage.removeItem('cm:room-panel-hint-seen'))

    // Mãe na feature: sem card no mapa, o Ctrl+` não lista a feature.
    const before = new Set((await liveGlobal(page)).map((s) => s.id))
    await spawnSession(page, repos[0].label)
    let M = ''
    await waitFor(page, 'mãe viva', async () => {
      M = (await liveGlobal(page)).find((s) => !before.has(s.id))?.id ?? ''
      return !!M
    })
    await page.evaluate(([s, f]) => (window as any).api.sessions.setFeature(s, f), [M, F])
    await waitFor(page, 'mãe na lane da feature', async () =>
      page.evaluate(
        async ([s, f]) => {
          const g = await (window as any).api.sessionGraph.get()
          const lane = g.lanes.find((l: any) => l.kind === 'feature' && l.featureId === f)
          return !!lane?.repos.some((r: any) => r.sessionIds.includes(s))
        },
        [M, F],
      ),
    )
    await page.waitForTimeout(1200)

    // ---- 1. Ctrl+`: a dica aparece uma vez, confirmar leva ao painel da Room
    await goToArea(page, 'overview')
    await page.keyboard.down('Control')
    await page.keyboard.press('Backquote')
    await page.waitForTimeout(600)
    const hint = page.getByTestId('feature-switcher-room-hint')
    check(await hint.isVisible(), '1: dica na 1ª abertura do Ctrl+`')
    check(
      /agora foca a mãe da feature, com o painel da Room ao lado/.test(
        await hint.innerText().catch(() => ''),
      ),
      '1: texto da dica',
    )
    await shot(page, '1-switcher-hint')
    const opt = page.locator(`[data-testid="feature-switcher"] [role="option"][data-key="${F}"]`)
    for (let i = 0; i < 20 && (await opt.getAttribute('aria-selected')) !== 'true'; i++) {
      await page.keyboard.press('Tab')
      await page.waitForTimeout(80)
    }
    await page.keyboard.up('Control')
    check(
      await waitFor(page, 'painel pelo Ctrl+`', () => panelTile(page, M).isVisible()),
      '1: Ctrl+` abre o painel da Room com a mãe da feature',
    )
    check(
      await page.getByTestId('room-panel-filter').isVisible(),
      '1: Ctrl+` filtra o painel na feature',
    )
    check(!(await room(page).isVisible()), '1: Ctrl+` não abre a página Room')
    const mTitle = (await panelTile(page, M).getByTestId('mother-tile-title').innerText()).trim()
    check(
      await waitFor(page, 'pane da mãe em foco', async () =>
        (await activeTabText(page)).includes(mTitle),
      ),
      '1: Ctrl+` foca a pane da mãe no dockview',
    )
    await shot(page, '1-panel')
    await leaveRoom(page)
    await page.keyboard.down('Control')
    await page.keyboard.press('Backquote')
    await page.waitForTimeout(600)
    check(
      (await page.getByTestId('feature-switcher').isVisible()) && !(await hint.isVisible()),
      '1: 2ª abertura sem dica',
    )
    await page.keyboard.press('Escape')
    await page.keyboard.up('Control')

    // ---- 2. "Abrir Room" no card da Home (ação secundária)
    await leaveRoom(page)
    // A Home lista as features em foco (ou com atividade), não necessariamente F:
    // vale o primeiro card que tiver, conferido pelo id dele.
    const homeBtn = page.getByTestId('home-feature-open-room').first()
    await waitFor(page, 'botão da Home', async () => (await homeBtn.count()) > 0, 10_000)
    if (check((await homeBtn.count()) > 0, '2: card de feature na Home tem "Abrir Room"')) {
      const id = (await homeBtn.getAttribute('data-feature-id')) ?? ''
      const homeTitle = await page.evaluate(
        async (f) =>
          (
            (await (window as any).api.features.list()) as Array<{ id: string; title: string }>
          ).find((x) => x.id === f)?.title ?? '',
        id,
      )
      await homeBtn.scrollIntoViewIfNeeded()
      await shot(page, '2-home-button')
      await homeBtn.click()
      await waitFor(page, 'Room pela Home', async () => room(page).isVisible())
      check(
        !!homeTitle && (await roomTitle(page)) === homeTitle,
        `2: botão da Home abre a Room daquela feature (${homeTitle})`,
      )
    }

    // ---- 3. Item "Room" da barra lateral: painel na visão de projeto, badge = TitleBar
    await leaveRoom(page)
    const railBadge = page.getByTestId('rail-room-badge')
    const titleBadge = page.getByTestId('titlebar-attention-badge')
    const rail = (await railBadge.count()) ? numberIn(await railBadge.innerText()) : 0
    const bar = (await titleBadge.count()) ? numberIn(await titleBadge.innerText()) : 0
    check(rail === bar, `3: badge da Room (${rail}) = "N no box" da TitleBar (${bar})`)
    await shot(page, '3-rail')
    // Contrato v0.78: a barra leva ao painel; "Todas as mães" fica no ⤢ do painel,
    // e o tile da mãe ali (Enter) leva à sala de F.
    await page.getByTestId('rail-room').click()
    check(
      await waitFor(page, 'painel pela barra', () => panel(page).isVisible()),
      '3: item "Room" abre o painel da Room na visão de projeto',
    )
    check(!(await room(page).isVisible()), '3: a barra não abre a página Room')
    check(await panelTile(page, M).isVisible(), '3: o painel tem o tile da mãe')
    await shot(page, '3-panel')
    await page.getByTestId('room-panel-fullscreen').click()
    const tile = page.locator(
      `[data-testid="feature-room"] [data-testid="mother-tile"][data-tile="${M}"]`,
    )
    check(
      await waitFor(page, 'Todas as mães pelo ⤢', () => tile.isVisible()),
      '3: ⤢ do painel abre Todas as mães, com o tile da mãe',
    )
    await shot(page, '3-all-mothers')
    await tile.focus()
    await page.keyboard.press('Enter')
    await waitFor(page, 'Room pelo tile', async () => room(page).isVisible())
    check((await roomTitle(page)) === title, '3: Enter no tile abre a sala da feature')
    await shot(page, '3-room')
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
    `[room-entry] ${out.checks.length - failed.length}/${out.checks.length} PASS · ${SHOTS}`,
  )
  if (failed.length > 0) process.exitCode = 1
}
