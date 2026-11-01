// Regressão: "Desfazer" fora da tela depois de maximizar fora do Mapa.
//
// A altura/largura da viewport usadas pela pilha de toasts só eram medidas com o
// minimapa ou o peek à vista. Em Terminais, maximizar deixava a altura velha e,
// com o composer na coluna da pilha, bottom = alturaVelha − (composerTop − 16)
// ficava negativo: o toast do endSession nascia abaixo da janela, inclicável.
//
// App buildado, cópia do perfil (CM_DRIVE_SAFE=1), HOME fake + stub do claude e um
// repo descartável no tmp: a única sessão é sintética.
//
// Rodar: npx tsx e2e/scenarios/toast-placement-viewport.ts  (TPV_SHOTS=<dir> opcional)
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { cleanCopy, liveGlobal, waitFor } from '../driver/crew-seed'
import { createFakeHome } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { goToArea, toggleProject, waitReady } from '../driver/nav'

const RUN_ID = Date.now()
const SANDBOX = join(tmpdir(), `tpv-sandbox-${RUN_ID}`)
const SHOTS = process.env.TPV_SHOTS ?? join(SANDBOX, 'shots')
const REPO_DIR = join(SANDBOX, 'tpv-repo')
const REPO_ID = 'tpv-repo'
// Altura de boot bem menor que a maximizada: o salto tem de passar da altura do
// composer para a altura velha empurrar a pilha para fora.
const SMALL = { width: 1100, height: 640 }

mkdirSync(SHOTS, { recursive: true })
mkdirSync(REPO_DIR, { recursive: true })
const git = (...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
    cwd: REPO_DIR,
    stdio: 'pipe',
  })
git('init', '-q')
writeFileSync(join(REPO_DIR, 'README.md'), 'x\n')
git('add', '.')
git('commit', '-qm', 'init')

const failures: string[] = []
function check(ok: boolean, label: string, detail = ''): boolean {
  console.log(`[tpv] ${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
  return ok
}

const fake = createFakeHome({ parentDir: SANDBOX })
// 1ª subida só para as migrations rodarem na cópia.
const first = await launchApp({ extraArgs: ['--ozone-platform=x11'] })
await first.app.close()
const userData = first.userDataCopy
const proj = (await queryDb(
  userData,
  'SELECT id, name FROM projects ORDER BY position LIMIT 1',
)) as Array<{
  id: string
  name: string
}>
if (!proj[0]) throw new Error('a cópia não tem projeto nenhum')
await cleanCopy(userData, (db: any) => {
  db.run(
    'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 990, ?)',
    [REPO_ID, proj[0].id, REPO_ID, REPO_DIR, Date.now()],
  )
})
writeCopyPrefs(userData, {
  claude_command: fake.fakeCliPath('claude'),
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
})

const { app, page } = await launchApp({
  userDataDir: userData,
  env: fake.env,
  extraArgs: ['--ozone-platform=x11'],
})
const logs = captureLogs(app, page)
const shot = (n: string) => page.screenshot({ path: join(SHOTS, `${n}.png`) }).catch(() => {})
async function openRepoSession(): Promise<void> {
  // Pela linha do repo na sidebar: sob --ozone-platform=x11 a busca do Ctrl+N
  // (spawnSession do crew-seed) terminou em "Nenhum resultado".
  await page.getByText(REPO_ID, { exact: true }).first().click()
  const dialog = page.locator('div.fixed.inset-0', { hasText: `Nova sessão · ${REPO_ID}` })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  const standard = dialog.getByRole('button', { name: 'Padrão', exact: true })
  if (await standard.count()) await standard.first().click()
  await dialog.getByRole('button', { name: 'Abrir', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
}
const viewport = () => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))

try {
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})

  // Janela pequena e renderer remontado nela: é a altura que ficaria velha.
  await app.evaluate(({ BrowserWindow }, size) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setContentSize(size.width, size.height)
  }, SMALL)
  await page.waitForTimeout(500)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})

  await goToArea(page, 'projects')
  await page.getByTestId('projects-view-terminals').click()

  // Duas panes: ao encerrar uma, o composer da outra continua na coluna da pilha.
  // Com uma só, o composer some junto e a pilha cai em bottom=16 com qualquer
  // altura — o cenário passava sem a correção.
  await toggleProject(page, proj[0].name)
  const sessionIds: string[] = []
  for (const n of [1, 2]) {
    const before = new Set((await liveGlobal(page)).map((s) => s.id))
    await openRepoSession()
    let id = ''
    const spawned = await waitFor(page, `sessão ${n} viva`, async () => {
      id =
        (await liveGlobal(page)).find((s) => s.repo?.id === REPO_ID && !before.has(s.id))?.id ?? ''
      return !!id
    })
    if (!check(spawned, `sessão sintética ${n} viva`)) throw new Error('sem sessão')
    sessionIds.push(id)
  }
  const endButtons = page.getByRole('button', { name: 'Encerrar', exact: true })
  const composers = page.locator('[data-composer-dock]')
  await waitFor(page, 'duas panes', async () => (await endButtons.count()) === 2, 15_000)
  await composers.first().waitFor({ state: 'visible', timeout: 15_000 })
  const small = await viewport()
  console.log('[tpv] viewport antes de maximizar:', JSON.stringify(small))

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
  await waitFor(page, 'resize da maximização', async () => (await viewport()).h > small.h + 200)
  await page.waitForTimeout(1500) // o composer é relido por poll de 1s
  const big = await viewport()
  console.log('[tpv] viewport maximizada:', JSON.stringify(big))
  check(big.h > small.h + 200, 'a maximização aumentou a altura', `${small.h} → ${big.h}`)
  await shot('01-maximized')

  // Caminho real: botão de encerrar do header da pane → endSession com undo.
  await endButtons.first().click()
  const undo = page.getByRole('button', { name: 'Desfazer', exact: true }).first()
  await undo.waitFor({ state: 'attached', timeout: 5000 })
  await page.waitForTimeout(1200) // a pane restante se reacomoda; o poll relê o composer
  await shot('02-toast')

  // Pré-condição do bug: um composer visível encostando na coluna da pilha (direita).
  const composerBoxes = await composers.evaluateAll((els) =>
    els
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
  )
  console.log('[tpv] composers com o toast à vista:', JSON.stringify(composerBoxes))
  check(
    composerBoxes.some((b) => b.right >= big.w - 320 - 16),
    'há composer na coluna da pilha durante o toast',
  )

  const probe = await undo.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const hit = document.elementFromPoint(cx, cy)
    return {
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      center: { x: cx, y: cy },
      inner: { w: window.innerWidth, h: window.innerHeight },
      hit: hit
        ? `${hit.tagName.toLowerCase()} "${(hit.textContent ?? '').trim().slice(0, 30)}"`
        : null,
      hitIsButton: !!hit && (hit === el || el.contains(hit)),
    }
  })
  console.log('[tpv] Desfazer:', JSON.stringify(probe))
  const { rect, inner } = probe
  check(
    rect.left >= 0 && rect.top >= 0 && rect.right <= inner.w && rect.bottom <= inner.h,
    'botão "Desfazer" dentro da viewport',
    `rect=${JSON.stringify(rect)} inner=${inner.w}x${inner.h}`,
  )
  check(probe.hitIsButton, 'elementFromPoint no centro é o "Desfazer"', `hit=${probe.hit}`)

  if (probe.hitIsButton) {
    // Clique de mouse no ponto, não o click() do Playwright: prova o hit-test real.
    await page.mouse.click(probe.center.x, probe.center.y)
    const back = await waitFor(
      page,
      'pane de volta',
      async () => (await endButtons.count()) === 2,
      4000,
    )
    check(back, 'o "Desfazer" trouxe a pane de volta')
    await shot('03-undone')
  }
} catch (e) {
  check(false, 'cenário rodou até o fim', (e as Error).message)
  await shot('99-error')
} finally {
  logs.stop()
  await app.close().catch(() => {})
  fake.cleanup()
  rmSync(REPO_DIR, { recursive: true, force: true })
  console.log(`[tpv] log: ${logs.logFile} | shots: ${SHOTS}`)
}

if (failures.length) {
  console.log(`[tpv] FALHOU: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('[tpv] OK')
