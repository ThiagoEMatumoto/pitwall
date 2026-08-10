import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { launchApp } from '../driver/launch'
import { captureLogs, screenshot } from '../driver/capture'
import { waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

const require = createRequire(import.meta.url)

// 1ª subida: roda migrations na cópia (cria a tabela `handoffs`).
const first = await launchApp()
await first.app.close()
const migrated = first.userDataCopy

// Escolhe um repo-alvo real da cópia migrada (label visível no inbox via JOIN).
const repos = (await queryDb(
  migrated,
  'SELECT id, label FROM repos ORDER BY label LIMIT 1',
)) as Array<{ id: string; label: string }>
if (repos.length === 0) throw new Error('sem repos na cópia')
const target = repos[0]
console.log('[inbox] target repo:', JSON.stringify(target))

// Seeda handoffs de status variados direto na cópia migrada.
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(migrated, 'app.db')))
const now = Date.now()
const seeds: Array<{ id: string; task: string; status: string; summary: string | null; error: string | null }> = [
  { id: 'inbox-pending', task: 'Investigar tratamento de status unsupported', status: 'pending', summary: null, error: null },
  { id: 'inbox-running', task: 'Migrar endpoint para Cloud SQL', status: 'running', summary: null, error: null },
  { id: 'inbox-done', task: 'Adicionar índice de paginação', status: 'done', summary: 'Índice (ativo, data_criacao DESC) criado; lista 31s → 0.5s.', error: null },
  { id: 'inbox-failed', task: 'Spawn da sessão-filha', status: 'failed', summary: null, error: 'Falha ao abrir sessão: repo-alvo sem worktree configurada.' },
  { id: 'inbox-rejected', task: 'Refatorar auth middleware', status: 'rejected', summary: null, error: null },
]
for (const [i, s] of seeds.entries()) {
  db.run(
    `INSERT INTO handoffs (id, mother_session_id, target_repo_id, child_session_id, feature_id, task, context_json, composed_prompt, status, summary, error, created_at, updated_at)
     VALUES (?, NULL, ?, NULL, NULL, ?, NULL, '## Tarefa\n' || ?, ?, ?, ?, ?, ?)`,
    [s.id, target.id, s.task, s.task, s.status, s.summary, s.error, now - i * 1000, now - i * 1000],
  )
}
writeFileSync(join(migrated, 'app.db'), Buffer.from(db.export()))
db.close()
console.log('[inbox]', seeds.length, 'handoffs seedados em', migrated)

// 2ª subida: aponta pra cópia migrada+seedada.
process.env.CM_REAL_USERDATA = migrated
const { app, page } = await launchApp()
const { stop } = captureLogs(app, page)
try {
  await waitReady(page)
  // O gate humano é opt-in (pref handoffs.requireApproval, default off), então
  // normalmente NÃO há modal — o pendente seedado é despachado sozinho. Se a pref
  // estiver ligada no userData copiado, o modal aparece: rejeita pra liberar a
  // navegação (o inbox mostra o pending virando rejected).
  const gateReject = page.getByRole('button', { name: /rejeitar/i }).first()
  if (await gateReject.count()) {
    await gateReject.click()
    await page.waitForTimeout(800)
  }
  // Abre a área Handoffs pelo title do botão da IconRail.
  await page.getByTitle('Handoffs', { exact: true }).click()
  await page.waitForTimeout(1200)
  await screenshot(page, 'inbox-01-all-statuses')

  const sawRepo = await page.getByText(target.label, { exact: false }).count()
  const sawDone = await page.getByText('Concluído', { exact: false }).count()
  const sawFailed = await page.getByText('Falhou', { exact: false }).count()
  console.log('[inbox] label visível?', sawRepo > 0, '| Concluído?', sawDone > 0, '| Falhou?', sawFailed > 0)

  // Expande o resumo do done.
  const verResumo = page.getByRole('button', { name: /ver resumo/i }).first()
  if (await verResumo.count()) {
    await verResumo.click()
    await page.waitForTimeout(500)
    await screenshot(page, 'inbox-02-summary-expanded')
  }
} finally {
  stop()
  await app.close()
}
