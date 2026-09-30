import { launchApp } from '../driver/launch'
import { captureLogs, screenshot } from '../driver/capture'
import { openSettings, waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

const { app, page, userDataCopy } = await launchApp()
const { logFile, stop } = captureLogs(app, page)

try {
  await waitReady(page)

  // (a) Ctrl+K abre a paleta de comandos.
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(400)
  await screenshot(page, '01-palette-open')
  // Fecha a paleta antes de seguir.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // (a2) Alt+A cicla a fila de atenção: o HUD aparece (com a fila do perfil
  // copiado, ou "Nada esperando" sem ninguém esperando). O e2e/scenarios/
  // attention-cycle.ts cobre o ciclo completo e o não-vazamento pro PTY.
  await page.keyboard.press('Alt+a')
  const hud = page.locator('[data-testid="attention-hud"]')
  await hud.waitFor({ state: 'attached', timeout: 5000 })
  console.log('ATTENTION HUD:', (await hud.innerText()).trim())
  await screenshot(page, '01b-attention-hud')

  // (b) Configurações → aba Atalhos renderiza a lista de combos.
  await openSettings(page)
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Atalhos', exact: false }).click()
  await page.waitForTimeout(300)
  await screenshot(page, '02-shortcuts-tab')
  for (const label of [
    'Próxima sessão que precisa de você',
    'Sessão anterior na fila de atenção',
    'Voltar à sessão onde você estava',
  ]) {
    const listed = await page.getByText(label, { exact: true }).count()
    if (listed === 0) throw new Error(`atalho ausente na aba Atalhos: ${label}`)
  }
  console.log('ATTENTION SHORTCUTS listados: attention.next, attention.prev, session.back')

  // (c) Round-trip de rebind: editar "Abrir paleta de comandos" (palette.toggle)
  // pra Ctrl+J e provar persistência no app_prefs.
  const row = page.locator('div', { hasText: 'Abrir paleta de comandos' })
  await row.getByRole('button', { name: 'Editar', exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+j')
  // Espera o write assíncrono (IPC → SQLite) liquidar antes de ler o DB.
  await page.waitForTimeout(1500)
  await screenshot(page, '03-after-rebind')
} finally {
  stop()
  // Fecha o app ANTES de ler o DB: better-sqlite3 roda em WAL, então o write do
  // override só aparece no app.db após o checkpoint do close (sql.js não lê o -wal).
  await app.close()
  const rows = await queryDb<{ value: string }>(
    userDataCopy,
    "SELECT value FROM app_prefs WHERE key = 'keybindings'",
  )
  console.log('PERSISTED keybindings:', JSON.stringify(rows))
  console.log('log:', logFile)
}
