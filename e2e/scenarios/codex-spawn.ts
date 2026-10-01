import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { launchApp } from '../driver/launch'
import { FAKE_CODEX_DONE, createFakeHome } from '../driver/fake-home'
import { goToArea, waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'
import type { LiveSessionInfo } from '../../shared/types/ipc'

// Provider Codex (experimental) de ponta a ponta com o stub fake-codex:
//   1. Ctrl+N → repo → "Codex (experimental)" → Abrir: a PTY sobe com as flags
//      do Codex (sandbox, aprovação, inline, MCP do Pitwall por -c) e o bearer
//      SÓ no env; sessions.provider='codex' sem cc_session_id.
//   2. A sessão aparece no SessionStrip e no mapa com o badge "Codex" e status
//      vivo — vindo da tela da PTY, já que o Codex não grava ~/.claude/sessions.
//   3. Um turno (o stub imprime ~3s) deixa a sessão 'working'; quando a tela
//      para, 'idle'. Sem espelho da tela não há prova de input livre (o overlay
//      de aprovação do Codex também é tela parada): "quando terminar" é recusado
//      sem escrever nada, e só o "Enviar agora" explícito chega ao stdin.
// HOME fake + codex stub: nem o ~/.codex real nem a API são tocados.

const require = createRequire(import.meta.url)
const SCRATCH = process.env.CODEX_SCRATCH ?? join(tmpdir(), `codex-spawn-${Date.now()}`)
mkdirSync(SCRATCH, { recursive: true })
const fake = createFakeHome({ parentDir: SCRATCH })
const SESSION_NAME = 'codex-e2e'
// Janela de estabilidade do pty-status (2s) + folga do tick (500ms).
const IDLE_SETTLE_MS = 2_000

const failures: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[codex] ${ok ? 'OK ' : 'FALHOU'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const repos = (await queryDb(
  userData,
  'SELECT id, label, path FROM repos ORDER BY label',
)) as Array<{
  id: string
  label: string
  path: string
}>
const target = repos.find((r) => r.path && existsSync(r.path))
if (!target) throw new Error('nenhum repo da cópia existe no disco')
console.log('[codex] repo:', target.label)

const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('codex_command', ?)", [
  fake.fakeCliPath('codex'),
])
db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()

// ---------- 2ª subida: app real, HOME fake ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: join(SCRATCH, 'codex-timeout.png') }).catch(() => {})
      throw new Error(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(250)
  }
}

async function dismissIntro(): Promise<void> {
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 30; i++) {
    if (await skip.count()) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await skip.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
      return
    }
    await page.waitForTimeout(500)
  }
}

// Um processo de stub por sessão: o cenário só cria uma.
function codexLog(): string {
  const files = readdirSync(fake.logDir).filter((f) => f.startsWith('codex-'))
  return files.map((f) => readFileSync(join(fake.logDir, f), 'utf8')).join('')
}
const live = () =>
  page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<LiveSessionInfo[]>
const codexLive = async () => (await live()).find((s) => s.provider === 'codex') ?? null

let sessionIdSeen = ''
try {
  await waitReady(page)
  await dismissIntro()

  // ---------- 1. criar pela UI ----------
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(target.label)
  await search.press('Enter')
  const providerSeg = page.getByTestId('spawn-provider')
  await providerSeg.waitFor({ state: 'visible', timeout: 10_000 })
  await providerSeg.locator('[data-provider="codex"]').click()
  await page.getByPlaceholder('opcional').first().fill(SESSION_NAME)
  // O default de permissão vem do repo da cópia real (pode ser 'plan'): fixa o modo.
  await page.getByRole('button', { name: 'Edita o workspace', exact: true }).click()
  check(
    'Codex esconde os controles do claude (modelo/advisor)',
    (await page.getByText('Advisor', { exact: true }).count()) === 0,
  )
  await page.screenshot({ path: join(SCRATCH, 'codex-1-dialog.png') })
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()

  await waitFor('argv do stub', async () => codexLog().includes('argv:'))
  const argv =
    codexLog()
      .split('\n')
      .find((l) => l.startsWith('argv:')) ?? ''
  console.log('[codex]', argv)
  check('--no-alt-screen', argv.includes('--no-alt-screen'))
  check('-s workspace-write', /-s workspace-write/.test(argv))
  check('-a on-request', /-a on-request/.test(argv))
  check(
    'MCP do Pitwall por -c com o carimbo da sessão',
    /mcp_servers\.pitwall\.url=\\?"http:\/\/127\.0\.0\.1:\d+\/mcp\\?\?s=[0-9a-f-]{36}\\?"/.test(
      argv,
    ),
  )
  check(
    'bearer por env, não na linha de comando',
    /bearer_token_env_var=\\?"PITWALL_MCP_TOKEN\\?"/.test(argv) &&
      codexLog().includes('env-token: set'),
  )
  check('nada do claude no argv', !argv.includes('--session-id') && !argv.includes('--mcp-config'))

  // O app grava em WAL: com ele vivo, o id sai da lista viva; o banco é
  // conferido depois do close.
  await waitFor('sessão Codex na lista viva', async () => (await codexLive()) !== null)
  const sessionId = (await codexLive())?.id ?? ''
  sessionIdSeen = sessionId

  // ---------- 2. strip + status vivo ----------
  await waitFor(
    'sessão Codex ociosa depois do banner',
    async () => (await codexLive())?.status === 'idle',
  )
  const entry = await codexLive()
  check(
    'lista viva chaveada pelo sessions.id',
    !!sessionId && entry?.ccSessionId === sessionId,
    JSON.stringify(entry),
  )
  // Ctrl+N a partir da Home não troca de área: a pane vive em Projetos.
  await goToArea(page, 'projects')
  const hud = (label: string) => page.locator('[role="status"]', { hasText: label })
  await waitFor('HUD da pane ocioso', async () => (await hud('Ocioso').count()) >= 1, 10_000)
  check('HUD da pane mostra Ocioso (status da PTY, não "Iniciando")', true)
  const badge = page.locator('[data-testid="provider-badge"][data-provider="codex"]')
  check('badge Codex no SessionStrip/aba', (await badge.count()) >= 1, String(await badge.count()))
  // A pane nasceu com a área oculta: o header só sai do tier 'narrow' depois de medir.
  await waitFor(
    'Chat View desligado com o motivo',
    async () => (await page.getByTestId('chat-toggle-disabled').count()) >= 1,
    5000,
  )
  check('Chat View desligado com o motivo', true)
  await page.screenshot({ path: join(SCRATCH, 'codex-2-strip-idle.png') })

  // ---------- 3. working enquanto imprime, idle quando para ----------
  await page.evaluate((id) => window.api.sessions.write(id, 'primeiro turno\r'), sessionId)
  await waitFor(
    'working durante o turno',
    async () => (await codexLive())?.status === 'working',
    5000,
  )
  check('working enquanto o stub imprime', true)

  // "quando terminar" no meio do turno: recusado — não enfileira nem escreve.
  await page.keyboard.press('Control+Shift+Enter')
  await page.getByTestId('quick-composer').waitFor({ state: 'visible', timeout: 10_000 })
  const input = page.getByTestId('quick-input')
  await input.fill(`@${SESSION_NAME} segunda mensagem`)
  await page.getByTestId('when-on-idle').click()
  await input.press('End')
  await input.press('Enter')
  await page.waitForTimeout(600)
  const notice = await page
    .getByTestId('quick-notice')
    .innerText()
    .catch(() => '')
  check(
    'quando terminar no Codex: recusado por falta de espelho',
    /espelho da tela/.test(notice),
    notice,
  )
  await page.screenshot({ path: join(SCRATCH, 'codex-3-refused.png') })
  await waitFor('fim do turno', async () => (await codexLive())?.status === 'idle', 15_000)
  await page.waitForTimeout(IDLE_SETTLE_MS)
  check('nada da fila chegou ao stdin', !codexLog().includes('stdin: segunda mensagem'))

  // "Enviar agora" é a decisão explícita do usuário: escreve.
  await input.fill(`@${SESSION_NAME} terceira mensagem`)
  await page.getByTestId('when-now').click()
  await input.press('End')
  await input.press('Enter')
  await page.keyboard.press('Escape')
  await waitFor(
    'stdin recebe o envio agora',
    async () => codexLog().includes('stdin: terceira mensagem'),
    10_000,
  )
  const hudStarted = Date.now()
  await waitFor('HUD trabalhando', async () => (await hud('Trabalhando').count()) >= 1, 5000)
  check('HUD da pane acompanha o turno (Trabalhando)', true, `${Date.now() - hudStarted}ms`)
  check(
    'o stub viu o turno terminar',
    codexLog().includes(FAKE_CODEX_DONE) || codexLog().includes('turn-end'),
  )

  // ---------- 4. mapa ----------
  await page.getByTestId('projects-view-map').click()
  const card = page.locator(`[data-testid="session-card"][data-session-id="${sessionId}"]`)
  await card.waitFor({ state: 'visible', timeout: 15_000 })
  check(
    'badge Codex no cartão do mapa',
    (await card.locator('[data-testid="provider-badge"][data-provider="codex"]').count()) === 1,
  )
  const cardStatus = (
    await card
      .getByTestId('card-status')
      .first()
      .innerText()
      .catch(() => '')
  ).trim()
  check(
    'status do cartão ≠ encerrada',
    cardStatus !== '' && !/encerrad/i.test(cardStatus),
    cardStatus,
  )
  await page.screenshot({ path: join(SCRATCH, 'codex-5-map.png') })

  console.log('[codex] page errors:', pageErrors.length ? pageErrors.join('\n') : 'nenhum')
  check('sem erros no renderer', pageErrors.length === 0)
  console.log('[codex] screenshots em', SCRATCH)
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

const rows = (await queryDb(
  userData,
  `SELECT id, provider, cc_session_id, title FROM sessions WHERE title = '${SESSION_NAME}'`,
)) as Array<{ id: string; provider: string; cc_session_id: string | null; title: string }>
check(
  "sessions.provider='codex' sem cc_session_id, mesmo id da lista viva",
  rows.length === 1 &&
    rows[0].provider === 'codex' &&
    rows[0].cc_session_id === null &&
    rows[0].id === sessionIdSeen,
  JSON.stringify(rows),
)

if (failures.length > 0) {
  console.error(`[codex] ${failures.length} falha(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('[codex] PASS')
