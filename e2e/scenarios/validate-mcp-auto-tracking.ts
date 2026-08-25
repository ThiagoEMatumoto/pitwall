import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../driver/launch'
import { captureLogs, screenshot } from '../driver/capture'
import { queryDb } from '../driver/inspect'
import { waitReady } from '../driver/nav'

// Prova o fio do auto-tracking com uma sessão `claude` REAL de fora do app:
// 1. App aberto → mcp-client-config.json existe na CÓPIA do userData.
// 2. `claude -p` conecta no MCP server do app via --mcp-config, lê as
//    instructions do initialize e cria uma task seguindo elas.
// 3. UI reflete a task (screenshots) e o SQLite da cópia tem a linha.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Porta isolada: o electron.launch (sem env explícito) herda o process.env deste
// processo, então o app da CÓPIA sobe o MCP em 45123 — nunca colide com o app
// real na 41956 e o claude -p não tem como alcançar o app real.
const ISOLATED_PORT = 45123
process.env.CM_MCP_PORT = String(ISOLATED_PORT)

const { app, page, userDataCopy } = await launchApp()
const { stop, logFile } = captureLogs(app, page)
let claudeFailed = false
try {
  await waitReady(page)
  await sleep(2000)

  const configPath = join(userDataCopy, 'mcp-client-config.json')
  const configExists = existsSync(configPath)
  console.log(`[scenario] client config: ${configPath} existe? ${configExists ? 'sim' : 'não'}`)
  if (!configExists) throw new Error('mcp-client-config.json não foi escrito na cópia do userData')

  // Guard: a porta no config DA CÓPIA tem que ser a isolada antes de qualquer claude -p.
  const clientConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  const configUrl: string = clientConfig?.mcpServers?.['pitwall']?.url ?? ''
  console.log(`[scenario] client config url: ${configUrl}`)
  if (!configUrl.includes(`:${ISOLATED_PORT}/`) && !configUrl.endsWith(`:${ISOLATED_PORT}`)) {
    throw new Error(`config da cópia não aponta pra porta ${ISOLATED_PORT}: ${configUrl}`)
  }

  // Sessão claude REAL, de fora do app, com o app ABERTO.
  const prompt =
    "First, summarize in ONE line what the pitwall MCP server instructions tell you to do. " +
    "Then, following those instructions, create a task titled 'Smoke auto-tracking E2E v2' with priority high."
  try {
    const out = execSync(
      `claude -p ${JSON.stringify(prompt)} --mcp-config ${JSON.stringify(configPath)} ` +
        `--allowedTools "mcp__pitwall__*" --output-format text`,
      { timeout: 120_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    for (const line of out.trim().split('\n')) console.log(`[claude] ${line}`)
  } catch (err: any) {
    claudeFailed = true
    console.log(`[claude] FALHOU: ${err.message}`)
    if (err.stdout) console.log(`[claude] stdout: ${String(err.stdout).slice(0, 2000)}`)
    if (err.stderr) console.log(`[claude] stderr: ${String(err.stderr).slice(0, 2000)}`)
    throw err
  }

  await sleep(2000)
  console.log('[scenario] screenshot:', await screenshot(page, 't3-home-auto-task'))

  await page.getByTitle('Tarefas', { exact: true }).click()
  await sleep(500)
  console.log('[scenario] screenshot:', await screenshot(page, 't2-tasks-area'))
} finally {
  stop()
  console.log('[scenario] log file:', logFile)
  await app.close()
}

if (!claudeFailed) {
  const rows = await queryDb(
    userDataCopy,
    "SELECT title, priority, status, tags FROM tasks WHERE title LIKE '%Smoke auto-tracking E2E v2%'",
  )
  console.log('[scenario] queryDb tasks:', JSON.stringify(rows, null, 2))
}
