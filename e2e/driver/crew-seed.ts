import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Page } from 'playwright'
import initSqlJs from 'sql.js'
import { connectMcp } from './mcp'

// Semeadura de crew nos cenários drive-app: sessões pela UI, handoffs pelo MCP do
// próprio processo e leituras da projeção pelo IPC do renderer.
const nodeRequire = createRequire(import.meta.url)

export async function waitFor(
  page: Page,
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs = 30_000,
  notes?: string[],
) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      notes?.push(`timeout: ${label}`)
      console.log(`[e2e] timeout esperando: ${label}`)
      return false
    }
    await page.waitForTimeout(300)
  }
}

// O length da projeção na unidade de toda superfície (attentionSubjectKey).
export async function projectionOf(
  page: Page,
): Promise<{ n: number; crew: number; kinds: string[] }> {
  return page.evaluate(async () => {
    const items = (await (window as any).api.attention.list()) as Array<{
      kind: string
      severity: string
      sessionId: string | null
      handoffId: string | null
      dedupKey: string
    }>
    const human = items.filter((i) => i.severity !== 'info')
    const keys = new Set(
      human.map((i) => (i.sessionId ? `s:${i.sessionId}` : `h:${i.handoffId ?? i.dedupKey}`)),
    )
    // O dock só mostra as filhas que a mãe lidera (isLedByMother): failed fica de fora.
    const hs = (await (window as any).api.handoffs.list()) as Array<{
      id: string
      status: string
      dismissedAt: number | null
      resumable: boolean
    }>
    const active = new Set(['pending', 'approved', 'running', 'needs_input'])
    const led = new Set(
      hs
        .filter(
          (h) =>
            h.dismissedAt == null &&
            (active.has(h.status) || (h.status === 'interrupted' && h.resumable)),
        )
        .map((h) => h.id),
    )
    const crew = new Set(
      human.flatMap((i) => (i.handoffId && led.has(i.handoffId) ? [i.handoffId] : [])),
    )
    return { n: keys.size, crew: crew.size, kinds: items.map((i) => `${i.kind}/${i.severity}`) }
  })
}

// Quick look / diálogos abertos (filha nova, Alt+A na crew) cobrem a tela.
export async function closeOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const open =
      (await page.getByTestId('peek-backdrop').count()) +
      (await page.locator('[data-modal-overlay]').count())
    if (!open) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
}

// Banco da cópia: sem handoffs vivos do perfil real e sem abas restauradas (as
// abas dariam --resume em sessões reais).
export async function cleanCopy(userData: string, extra?: (db: any) => void): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: () => nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'),
  })
  const path = join(userData, 'app.db')
  const db = new SQL.Database(readFileSync(path))
  const now = Date.now()
  db.run(
    `UPDATE handoffs SET status = CASE WHEN status IN ('pending','approved','running','needs_input')
       THEN 'done' ELSE status END, consumed_at = COALESCE(consumed_at, ?), dismissed_at = COALESCE(dismissed_at, ?)`,
    [now, now],
  )
  db.run("UPDATE workspace_state SET open_panes = '[]', dock_layout = NULL WHERE id = 1")
  extra?.(db)
  writeFileSync(path, Buffer.from(db.export()))
  db.close()
}

export function mcpAs(userData: string, scratch: string, sessionId: string) {
  const cfg = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8'))
  const url = new URL(cfg.url)
  url.searchParams.set('s', sessionId)
  const dir = join(scratch, `mcp-as-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ ...cfg, url: url.toString() }))
  return connectMcp(dir)
}

export async function spawnSession(page: Page, label: string, permission?: string): Promise<void> {
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(label)
  await search.press('Enter')
  const dialog = page.locator('div.fixed.inset-0', { hasText: `Nova sessão · ${label}` })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  const standard = dialog.getByRole('button', { name: 'Padrão', exact: true })
  if (await standard.count()) await standard.first().click()
  // O 1º "Padrão" é o preset de trabalho: ele volta pro defaultPermission do
  // perfil copiado (que pode ser plan). O modo de permissão tem grupo próprio.
  if (permission)
    await dialog
      .locator('div:has(> label:text-is("Permissão"))')
      .getByRole('button', { name: permission, exact: true })
      .click()
  await dialog.getByRole('button', { name: 'Abrir', exact: true }).click()
}

export type LiveRow = { id: string; ccSessionId: string | null; repo: { id: string } | null }
export const liveGlobal = (page: Page) =>
  page.evaluate(() => (window as any).api.sessions.listLiveGlobal()) as Promise<LiveRow[]>
