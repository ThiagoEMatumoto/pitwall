import { copyRealUserData, launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs, screenshot } from '../driver/capture'
import { createFakeHome } from '../driver/fake-home'
import { openSettings, waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// A cópia nasce sem abas restauradas (launchApp default) e o HOME é falso: nenhum
// `claude` sobe no boot e a fila de atenção não depende do perfil real.
const PALETTE_INPUT = 'Buscar ações, projetos, repos…'
// Livre entre os defaults de src/lib/keybindings.ts. Ctrl+J NÃO serve: é o
// default de 'Focar a equipe' (crew.focus) e a aba Atalhos recusa o conflito.
const NEW_PALETTE_COMBO = 'Control+Shift+y'
const NEW_PALETTE_LABEL = 'Ctrl+Shift+Y'

const fake = createFakeHome()
// Atalhos remapeados no perfil real mudariam o que Ctrl+K faz aqui: o cenário
// aperta os DEFAULTS, então a cópia nasce sem overrides.
const copy = copyRealUserData()
writeCopyPrefs(copy, { keybindings: null })
const { app, page, userDataCopy } = await launchApp({ userDataDir: copy, env: fake.env })
const { logFile, stop } = captureLogs(app, page)
const palette = page.getByPlaceholder(PALETTE_INPUT)

async function paletteOpensWith(combo: string): Promise<boolean> {
  await page.keyboard.press(combo)
  const opened = await palette
    .waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true)
    .catch(() => false)
  if (opened) {
    await page.keyboard.press('Escape')
    await palette.waitFor({ state: 'hidden', timeout: 2000 })
  }
  return opened
}

try {
  await waitReady(page)

  // (a) Ctrl+K abre a paleta de comandos.
  if (!(await paletteOpensWith('Control+k'))) throw new Error('Ctrl+K não abriu a paleta')
  await screenshot(page, '01-palette-default')

  // (a2) Alt+A cicla a fila de atenção: o HUD aparece ("Nada esperando" sem
  // ninguém esperando). O e2e/scenarios/attention-cycle.ts cobre o ciclo completo
  // e o não-vazamento pro PTY.
  await page.keyboard.press('Alt+a')
  const hud = page.locator('[data-testid="attention-hud"]')
  await hud.waitFor({ state: 'attached', timeout: 5000 })
  console.log('ATTENTION HUD:', (await hud.innerText()).trim())
  await screenshot(page, '01b-attention-hud')

  // (b) Configurações → aba Atalhos renderiza a lista de combos.
  await openSettings(page)
  await page.getByRole('button', { name: 'Atalhos', exact: false }).click()
  for (const label of [
    'Próxima sessão que precisa de você',
    'Sessão anterior na fila de atenção',
    'Voltar à sessão onde você estava',
    'Focar a equipe (sessões-filhas)',
  ]) {
    const listed = await page.getByText(label, { exact: true }).count()
    if (listed === 0) throw new Error(`atalho ausente na aba Atalhos: ${label}`)
  }
  console.log('SHORTCUTS listados: attention.next, attention.prev, session.back, crew.focus')
  await screenshot(page, '02-shortcuts-tab')

  // (c) Rebind de "Abrir paleta de comandos" pra um combo sem conflito.
  const row = page
    .locator('div.justify-between')
    .filter({ hasText: /^Abrir paleta de comandos/ })
    .first()
  await row.getByRole('button', { name: 'Editar', exact: true }).click()
  await page.keyboard.press(NEW_PALETTE_COMBO)
  await row.locator('kbd', { hasText: NEW_PALETTE_LABEL }).waitFor({ timeout: 3000 })
  const rowText = await row.innerText()
  if (rowText.includes('Conflito')) throw new Error(`rebind recusado: ${rowText}`)
  console.log('REBIND na UI:', rowText.replace(/\s+/g, ' ').trim())
  await screenshot(page, '03-after-rebind')

  // (d) O combo novo abre a paleta e o antigo deixa de abrir.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Atalhos', exact: false }).waitFor({ state: 'hidden' })
  if (!(await paletteOpensWith(NEW_PALETTE_COMBO))) {
    throw new Error(`${NEW_PALETTE_LABEL} não abriu a paleta após o rebind`)
  }
  if (await paletteOpensWith('Control+k')) throw new Error('Ctrl+K ainda abre a paleta')
  console.log(`PALETA: ${NEW_PALETTE_LABEL} abre, Ctrl+K não abre mais`)
} finally {
  stop()
  // Fecha o app ANTES de ler o DB: better-sqlite3 roda em WAL, então o write do
  // override só aparece no app.db após o checkpoint do close (sql.js não lê o -wal).
  await app.close()
  fake.cleanup()
  console.log('log:', logFile)
}

const rows = await queryDb<{ value: string }>(
  userDataCopy,
  "SELECT value FROM app_prefs WHERE key = 'keybindings'",
)
const overrides = rows[0]
  ? (JSON.parse(rows[0].value) as Record<string, { mod?: boolean; shift?: boolean; key?: string }>)
  : {}
const persisted = overrides['palette.toggle']
console.log('PERSISTED palette.toggle:', JSON.stringify(persisted))
if (!persisted?.mod || !persisted.shift || persisted.key?.toLowerCase() !== 'y') {
  throw new Error(`override de palette.toggle não persistiu como ${NEW_PALETTE_LABEL}`)
}
