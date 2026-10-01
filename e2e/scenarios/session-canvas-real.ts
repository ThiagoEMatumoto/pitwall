import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { createFakeHome } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// Mapa com cartões vivos sobre a CÓPIA do perfil real (projetos, repos, lanes e
// prefs reais). A cópia nasce sem PTYs, então 3 sessões do stub `claude` sobem
// em repos reais: o stub só escreve no HOME fake e nunca toca o repo; o
// CM_DRIVE_SAFE do launchApp barra auto-pull/clone. Nenhuma API é chamada.
// Rodar: REAL_SHOTS=<dir> npx tsx e2e/scenarios/session-canvas-real.ts

const SHOTS = process.env.REAL_SHOTS ?? mkdtempSync(join(tmpdir(), 'canvas-real-'))
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: SHOTS })

const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
writeCopyPrefs(userData, { claude_command: fake.fakeCliPath('claude') })
const repos = (
  (await queryDb(userData, 'SELECT id, label, path FROM repos ORDER BY position, label')) as Array<{
    id: string
    label: string
    path: string
  }>
)
  .filter((r) => r.path.startsWith('/') && existsSync(r.path))
  .slice(0, 3)
console.log('[real] repos:', repos.map((r) => r.label).join(', '))

const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const shot = (n: string) => page.screenshot({ path: join(SHOTS, `${n}.png`) })
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)

type Api = { sessions: { spawn(i: unknown): Promise<{ id: string; ccSessionId: string }> } }

try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  const ids: string[] = []
  for (const [i, r] of repos.entries()) {
    const s = await page.evaluate(
      (input) => (window as unknown as { api: Api }).api.sessions.spawn(input),
      { repoId: r.id, name: `mapa-real-${i + 1}` },
    )
    ids.push(s.id)
  }
  // Spawn por IPC cru não passa pelo store: um exit (fix do pty:exit) refaz o
  // snapshot de sessões vivas, como faria qualquer sessão saindo sozinha.
  const tmp = await page.evaluate(
    (input) => (window as unknown as { api: Api }).api.sessions.spawn(input),
    { repoId: repos[0]!.id, name: 'mapa-real-descartavel' },
  )
  await page.waitForTimeout(1500)
  await page.evaluate(
    (id) => (window as unknown as { api: { sessions: { kill(i: string): Promise<unknown> } } }).api.sessions.kill(id),
    tmp.id,
  )
  await page.waitForTimeout(1000)
  await goToArea(page, 'projects')
  await page.getByTestId('projects-view-map').click()
  for (let i = 0; i < 40 && (await page.getByTestId('session-card').count()) < ids.length; i++)
    await page.waitForTimeout(500)
  // Um sessão terminou (pronto), outra segue trabalhando.
  const first = fake.readSessionFiles().find((f) => f.data.name === 'mapa-real-1')
  if (first) fake.setStatus(first.data.pid, 'idle')
  await page.waitForTimeout(1500)
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForTimeout(800)
  await shot('01-real-fit')
  await page.getByTestId('map-zoom-100').click()
  await page.waitForTimeout(800)
  await shot('02-real-100')
  // Terminal no 2º cartão; o 1º fica aberto (saída ao vivo + prompt).
  if (ids[1]) {
    await card(ids[1]).getByTestId('card-interact').click()
    await page.waitForTimeout(1500)
    const lift = page.locator('[role="dialog"][data-peek-lift][data-peek-mode="terminal"]')
    await lift
      .locator('.xterm')
      .click()
      .catch(() => {})
    await page.keyboard.type('ola do mapa')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    await shot('03-real-terminal')
    await page.keyboard.press('Shift+Escape')
  }
  const views = await page
    .getByTestId('session-card')
    .evaluateAll((els) =>
      els.map((e) => `${e.getAttribute('data-view')}/${e.getAttribute('data-tone')}`),
    )
  console.log('[real] cartões (view/tom):', views.join(' '))
  console.log('[real] stdin no stub:', fake.readCliLog('claude').includes('stdin: ola do mapa'))
  console.log('[real] erros de console:', errors.length ? errors.join(' | ') : 'nenhum')
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
