import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { launchApp } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome } from '../driver/fake-home'
import { goToArea, waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// Smoke do seam AgentProvider (P5): abre uma sessão nova pela UI (Ctrl+N → repo →
// Abrir) com o `claude` trocado pelo stub do fake-home e confere que
//   1. o argv que a CLI recebeu tem o MESMO formato de antes do seam (lista de
//      tokens escrita à mão aqui, não derivada do provider);
//   2. a linha em `sessions` nasceu com provider = 'claude' (migration 050).
// Defaults de sessão são fixados no seed (sonnet/high/acceptEdits) para o argv
// ser determinístico e exercitar --model/--effort/--permission-mode/denylist.
//
// Rodar: npm run build (Electron ABI) e então
//   SMOKE_SCRATCH=<dir> npx tsx e2e/scenarios/provider-seam-smoke.ts

const require = createRequire(import.meta.url)
const SCRATCH = process.env.SMOKE_SCRATCH ?? mkdtempSync(join(tmpdir(), 'provider-seam-'))
mkdirSync(SCRATCH, { recursive: true })
const fake = createFakeHome({ parentDir: SCRATCH })

// Denylist destrutivo canônico (spawn-flags.ts) em modo autônomo — literal de
// propósito: é o formato de ANTES que está sob teste.
const DENYLIST = [
  'Bash(rm:*)',
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git clean:*)',
]

// Mesma serialização do stub (`printf ' %q'` do bash), para comparar texto com texto.
function bashQuoted(tokens: string[]): string {
  return execFileSync('bash', ['-c', 'for a in "$@"; do printf " %q" "$a"; done', '_', ...tokens], {
    encoding: 'utf8',
  })
}

function fail(msg: string): never {
  throw new Error(`[provider-seam] FALHOU: ${msg}`)
}

// ---------- 1ª subida: migrations (inclui 050) na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const repos = await queryDb<{ id: string; label: string; path: string }>(
  userData,
  'SELECT id, label, path FROM repos ORDER BY label',
)
const target = repos.find((r) => r.path && existsSync(r.path))
if (!target) fail('nenhum repo da cópia existe no disco')
console.log('[provider-seam] repo-alvo:', target.label, target.path)

// ---------- seed: stub do claude + defaults determinísticos ----------
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
const setPref = (key: string, value: string) =>
  db.run('INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)', [key, value])
setPref('claude_command', fake.fakeCliPath('claude'))
setPref('session.defaultModel', JSON.stringify('sonnet'))
setPref('session.defaultEffort', JSON.stringify('high'))
setPref('session.defaultPermission', JSON.stringify('acceptEdits'))
setPref('session.defaultAdvisor', JSON.stringify(''))
setPref('session.defaultPaneMode', JSON.stringify('terminal'))
setPref('app.showIntroOnBoot', JSON.stringify(false))
// Override por repo venceria os defaults globais acima.
db.run("DELETE FROM app_prefs WHERE key LIKE 'session.defaults.%'")
// Sem restaurar o workspace real: o restore re-spawnaria as sessões do usuário.
db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()

// ---------- 2ª subida: app real, HOME fake, claude stub ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const logs = captureLogs(app, page)
console.log('[provider-seam] log:', logs.logFile)
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))

async function waitFor(label: string, fn: () => boolean | Promise<boolean>, timeoutMs = 60_000) {
  const started = Date.now()
  while (!(await fn())) {
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: join(SCRATCH, 'provider-seam-timeout.png') }).catch(() => {})
      fail(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(500)
  }
}

let argvLine = ''
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})

  // Fluxo global de nova sessão: Ctrl+N → busca o repo → Enter → Abrir.
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(target.label)
  await search.press('Enter')
  const dialog = page.getByText(`Nova sessão · ${target.label}`)
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()

  await waitFor('argv no log do fake claude', () => {
    argvLine =
      fake
        .readCliLog('claude')
        .split('\n')
        .find((l) => l.startsWith('argv:')) ?? ''
    return argvLine !== ''
  })
  // Ctrl+N não troca de área (openSession só cria a pane): sai da Home para o dock.
  await goToArea(page, 'projects')
  // xterm desenha em WebGL: o banner do stub não vira texto no DOM, só o canvas.
  await page.locator('.xterm:visible').first().waitFor({ timeout: 15_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(SCRATCH, 'provider-seam-session.png') })
} finally {
  const proc = app.process()
  logs.stop()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
}

// ---------- asserts (depois do close: o WAL já foi checkpointado) ----------
try {
  const rows = await queryDb<{ id: string; cc_session_id: string; provider: string }>(
    userData,
    `SELECT id, cc_session_id, provider FROM sessions WHERE repo_id = '${target.id}'
      ORDER BY started_at DESC LIMIT 1`,
  )
  const row = rows[0] ?? fail('nenhuma linha em sessions para o repo-alvo')
  if (row.provider !== 'claude') fail(`sessions.provider = ${row.provider}, esperado 'claude'`)

  // launchApp liga CM_MCP_EPHEMERAL_PORT: o MCP server sempre sobe (porta efêmera
  // se a padrão está ocupada), então o argv TEM de trazer a config por sessão —
  // aceitar argv sem ela deixaria passar um mcpInject que parou de injetar.
  const perSession = join(userData, 'mcp-sessions', `${row.id}.json`)
  const tail = [
    '--model',
    'sonnet',
    '--effort',
    'high',
    '--permission-mode',
    'acceptEdits',
    '--disallowedTools',
    ...DENYLIST,
  ]
  const argv = argvLine.slice('argv:'.length)
  const prefix = bashQuoted([
    '--session-id',
    row.cc_session_id,
    '-n',
    target.label,
    '--mcp-config',
    perSession,
    ...tail,
  ])
  // O system-prompt-file (path com timestamp) é opcional: sem arquitetura/feature
  // o main não escreve o arquivo.
  const matched =
    argv.startsWith(prefix) &&
    /^( --append-system-prompt-file \S+)?$/.test(argv.slice(prefix.length))
  if (!matched) fail(`argv fora do formato esperado:\n${argvLine}`)

  console.log('[provider-seam] argv:', argvLine)
  console.log('[provider-seam] mcp-config por sessão:', perSession)
  console.log('[provider-seam] sessions.provider:', row.provider)
  console.log('[provider-seam] page errors:', pageErrors.length ? pageErrors.join('\n') : 'nenhum')
  console.log('[provider-seam] screenshot:', join(SCRATCH, 'provider-seam-session.png'))
  console.log('[provider-seam] PASS')
} finally {
  fake.cleanup()
}
