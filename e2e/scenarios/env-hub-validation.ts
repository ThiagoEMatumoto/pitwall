import { createServer } from 'node:http'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { captureLogs, screenshot } from '../driver/capture'
import { launchApp, resolveRealUserData } from '../driver/launch'
import { openSettings, waitReady } from '../driver/nav'

// Valida o env hub de ponta a ponta sem tocar credencial real nem o home real:
// 1. árvore fixture de .env fake (CM_ENV_IMPORT_ROOT redireciona o scanner);
// 2. aba Integrações: cards, scan, tabela de revisão (fingerprint, nunca o
//    valor), import de 1 chave e card do serviço "configurado";
// 3. MCP real do app (CM_MCP_PORT=0 + mcp.json da cópia): service_list via
//    client SDK, sem nenhum valor de credencial na resposta;
// 4. fake litellm local respondendo GET /v1/models — o registry compila as base
//    URLs, então o health DO APP não é apontável pro fake; o cenário valida o
//    contrato de health contra o fake diretamente (deviation registrada).
//
// Perfil-base PODADO (padrão validate-voice): só o app.db real com layout
// zerado e autoPullEnabled=false — sem panes de PTY ressuscitando nem git pull
// nos repos reais. CM_SCRUB_SECRETS fica no default (1): nenhum segredo real
// utilizável vive na cópia.

const require = createRequire(import.meta.url)

async function prunedBaseProfile(): Promise<string> {
  const real = resolveRealUserData()
  const dir = mkdtempSync(join(tmpdir(), 'cm-envhub-base-'))
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })
  cpSync(join(real, 'app.db'), join(dir, 'app.db'))
  const SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
  })
  const db = new SQL.Database(readFileSync(join(dir, 'app.db')))
  db.run('UPDATE workspace_state SET dock_layout = NULL, open_panes = NULL WHERE id = 1')
  db.run('INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)', [
    'autoPullEnabled',
    JSON.stringify(false),
  ])
  writeFileSync(join(dir, 'app.db'), Buffer.from(db.export()))
  db.close()
  return dir
}

process.env.CM_REAL_USERDATA = await prunedBaseProfile()
console.log('[perfil] base podada em', process.env.CM_REAL_USERDATA)

// --- fixture: árvore de .env fake (valores obviamente falsos) ---------------
const TAVILY_FAKE = 'test-key-1234'
const GEMINI_FAKE_A = 'test-gemini-key-0001'
const GEMINI_FAKE_B = 'test-gemini-key-0002'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'cm-envhub-fixture-'))
process.once('exit', () => {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})
mkdirSync(join(fixtureRoot, 'projetos', 'proj-a'), { recursive: true })
mkdirSync(join(fixtureRoot, 'projetos', 'proj-b'), { recursive: true })
writeFileSync(
  join(fixtureRoot, 'projetos', 'proj-a', '.env'),
  `TAVILY_API_KEY=${TAVILY_FAKE}\nGEMINI_API_KEY=${GEMINI_FAKE_A}\n`,
)
// Mesma chave com valor divergente → tabela mostra "conflito" com radio de fonte.
writeFileSync(
  join(fixtureRoot, 'projetos', 'proj-b', '.env.local'),
  `GEMINI_API_KEY=${GEMINI_FAKE_B}\n`,
)
// .example é ignorado pelo scanner — se este valor aparecer, o skip quebrou.
writeFileSync(
  join(fixtureRoot, 'projetos', 'proj-a', '.env.example'),
  'TAVILY_API_KEY=should-never-appear\n',
)
console.log('[fixture] árvore em', fixtureRoot)

// --- fake litellm: GET /v1/models no formato do health do registry ----------
const litellmRequests: string[] = []
const fakeLitellm = createServer((req, res) => {
  litellmRequests.push(
    `${req.method} ${req.url} auth=${req.headers.authorization ? 'bearer' : 'none'}`,
  )
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model-e2e' }] }))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
await new Promise<void>((resolve) => {
  fakeLitellm.listen(0, '127.0.0.1', resolve)
})
const litellmAddress = fakeLitellm.address()
const litellmPort = typeof litellmAddress === 'object' && litellmAddress ? litellmAddress.port : 0
console.log(`[fake-litellm] ouvindo em 127.0.0.1:${litellmPort}`)

// O registry compila as base URLs (sem override por env) — o health DO APP não
// alcança o fake. Validação viável: exercitar o contrato (GET /v1/models com
// bearer) direto contra o fake, do jeito que service-proxy.runHealthCheck faria.
const healthRes = await fetch(`http://127.0.0.1:${litellmPort}/v1/models`, {
  headers: { Authorization: 'Bearer test-key-1234' },
})
const healthBody = (await healthRes.json()) as { data?: Array<{ id: string }> }
console.log(
  `[fake-litellm] health contrato: HTTP ${healthRes.status}, modelos=${JSON.stringify(healthBody.data?.map((m) => m.id))}`,
)
if (!healthRes.ok || healthBody.data?.[0]?.id !== 'fake-model-e2e') {
  throw new Error('FALHA: fake litellm não respondeu o contrato de /v1/models')
}

// --- app -------------------------------------------------------------------
const { app, page, userDataCopy } = await launchApp({
  env: {
    CM_ENV_IMPORT_ROOT: fixtureRoot,
    // Porta efêmera: nunca colide com o app real instalado na 41956.
    CM_MCP_PORT: '0',
  },
})
const { logFile, stop } = captureLogs(app, page)

const errors: string[] = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
})

const rowCheckbox = (key: string) =>
  page.locator('label').filter({ hasText: key }).locator('input[type="checkbox"]').first()

try {
  await waitReady(page)
  await page.waitForTimeout(2000)

  // --- 1. Settings → aba Integrações --------------------------------------
  await openSettings(page)
  await page.getByRole('button', { name: 'Integrações' }).click()
  await page.getByText('Serviços', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  // Cards renderizados pro registry inteiro.
  for (const title of ['LiteLLM', 'Gemini', 'LegalCore', 'ElevenLabs', 'Tavily']) {
    if (!(await page.getByText(title, { exact: true }).count())) {
      throw new Error(`FALHA: card do serviço ${title} não renderizou`)
    }
  }
  const tavilyBadgeBefore = await page
    .getByText('Tavily', { exact: true })
    .first()
    .locator('..')
    .locator('span')
    .last()
    .innerText()
  console.log('[cards] Tavily antes do import:', tavilyBadgeBefore)
  await screenshot(page, 'envhub-01-integrations-tab')

  // --- 2. scan apontando pra fixture ---------------------------------------
  await page.getByRole('button', { name: 'Buscar arquivos .env' }).click()
  await page
    .getByText('TAVILY_API_KEY', { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 })

  const bodyText = (await page.locator('body').innerText()) ?? ''
  const leaked = [TAVILY_FAKE, GEMINI_FAKE_A, GEMINI_FAKE_B, 'should-never-appear'].filter((v) =>
    bodyText.includes(v),
  )
  if (leaked.length > 0) {
    await screenshot(page, 'envhub-99-debug-leak')
    throw new Error(
      `FALHA DE SEGURANÇA: valor de credencial visível no renderer: ${leaked.join(', ')}`,
    )
  }
  console.log('[scan] nenhum valor de credencial no DOM (só fingerprints)')
  if (!bodyText.includes('••••••••1234')) {
    throw new Error('FALHA: fingerprint da TAVILY_API_KEY não apareceu na revisão')
  }
  const geminiConflict = bodyText.includes('conflito')
  console.log('[scan] GEMINI_API_KEY em conflito entre fontes:', geminiConflict)
  await screenshot(page, 'envhub-02-import-review')

  // --- 3. aplicar exatamente 1 chave (TAVILY_API_KEY) ----------------------
  // Pré-seleção depende do cofre copiado (new vs conflict) — normalizar: só a
  // TAVILY marcada.
  for (const key of ['GEMINI_API_KEY']) {
    const box = rowCheckbox(key)
    if ((await box.count()) && (await box.isChecked())) await box.click()
  }
  const tavilyBox = rowCheckbox('TAVILY_API_KEY')
  if (!(await tavilyBox.isChecked())) await tavilyBox.click()
  const applyBtn = page.getByRole('button', { name: /^Importar/ })
  console.log('[apply] botão:', await applyBtn.innerText())
  await applyBtn.click()
  await page
    .getByText('1 chave(s) importada(s) para o cofre.', { exact: false })
    .waitFor({ state: 'visible', timeout: 15_000 })
  console.log('[apply] 1 chave importada para o cofre')

  // --- 4. card do serviço configurado --------------------------------------
  // O apply invalida o cache de health e recarrega statuses (health real de
  // outros serviços pode demorar) — poll no badge do Tavily.
  const tavilyBadge = page
    .getByText('Tavily', { exact: true })
    .first()
    .locator('..')
    .locator('span')
    .last()
  let badgeText = ''
  for (let i = 0; i < 40; i++) {
    badgeText = (await tavilyBadge.innerText()).trim()
    if (badgeText === 'configurado') break
    await page.waitForTimeout(500)
  }
  console.log('[cards] Tavily depois do import:', badgeText)
  if (badgeText !== 'configurado') {
    await screenshot(page, 'envhub-98-debug-card')
    throw new Error(`FALHA: card do Tavily não ficou "configurado" (ficou "${badgeText}")`)
  }
  await screenshot(page, 'envhub-03-service-card-configured')

  // --- 5. MCP service_list via client SDK contra o server real do app ------
  const mcpConfigPath = join(userDataCopy, 'mcp.json')
  for (let i = 0; i < 20 && !existsSync(mcpConfigPath); i++) await page.waitForTimeout(500)
  if (!existsSync(mcpConfigPath))
    throw new Error('FALHA: mcp.json não apareceu na cópia do userData')
  const { url, token } = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as {
    url: string
    token: string
  }
  console.log('[mcp] endpoint:', url)

  const client = new Client({ name: 'env-hub-e2e', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  try {
    const result = await client.callTool({
      name: 'service_list',
      arguments: {},
    })
    const first = (result.content as Array<{ type: string; text: string }>)[0]
    const parsed = JSON.parse(first.text) as {
      services: Array<{
        id: string
        configured: boolean
        operations: Array<{ id: string }>
      }>
    }
    const ids = parsed.services.map((s) => s.id).sort()
    console.log('[mcp] service_list ids:', JSON.stringify(ids))
    if (ids.join(',') !== 'elevenlabs,gemini,laas,legal_core,litellm,tavily') {
      throw new Error(`FALHA: service_list não listou o registry inteiro: ${ids.join(',')}`)
    }
    const tavily = parsed.services.find((s) => s.id === 'tavily')
    console.log('[mcp] tavily configured:', tavily?.configured)
    if (!tavily?.configured)
      throw new Error('FALHA: tavily não aparece configurado no service_list')
    const rawResponse = JSON.stringify(result)
    const mcpLeaks = [TAVILY_FAKE, GEMINI_FAKE_A, GEMINI_FAKE_B].filter((v) =>
      rawResponse.includes(v),
    )
    if (mcpLeaks.length > 0) {
      throw new Error(
        `FALHA DE SEGURANÇA: valor de credencial na resposta MCP: ${mcpLeaks.join(', ')}`,
      )
    }
    console.log('[mcp] nenhum valor de credencial na resposta do service_list')
  } finally {
    await client.close()
  }

  console.log('[fake-litellm] requisições recebidas:', JSON.stringify(litellmRequests))
  console.log('\n=== ERROS DE CONSOLE ===')
  console.log(errors.length === 0 ? 'nenhum' : errors.join('\n'))
  console.log('log completo:', logFile)
  console.log('ENV-HUB-VALIDATION DONE')
} finally {
  stop()
  await app.close()
  fakeLitellm.close()
}
