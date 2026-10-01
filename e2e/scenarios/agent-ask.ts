import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { launchApp } from '../driver/launch'
import { createFakeHome } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { goToArea, waitReady } from '../driver/nav'
import type { AgentBusSnapshot } from '../../shared/types/agent-bus'
import type { LiveSessionInfo } from '../../shared/types/ipc'

// Agente perguntando a agente (P7), de ponta a ponta no app buildado:
//   - A (projeto Front) chama agent_ask via MCP HTTP com o ?s= dela, repo=api
//   - o envelope <pitwall-ask> só chega no stdin de B (projeto API) com B ociosa
//   - a aba Conversas mostra o par; o mapa mostra o fio temporário com balão
//   - B responde com agent_reply (?s= de B) → agent_check de A traz a resposta,
//     e o fio some do mapa
//   - cadeia A→B→A→B: o 4º nível (B→A) é recusado e o contador aparece na aba
// HOME fake + stub do claude: nenhuma API é chamada e o ~/.claude real não é
// tocado. Rodar: ASK_SCRATCH=<dir> npx tsx e2e/scenarios/agent-ask.ts
// (depois de `npm run rebuild:native && npm run build`).

const require = createRequire(import.meta.url)
const SCRATCH = process.env.ASK_SCRATCH ?? mkdtempSync(join(tmpdir(), 'agent-ask-'))
mkdirSync(SCRATCH, { recursive: true })
const fake = createFakeHome({ parentDir: SCRATCH })
const shot = (name: string) => join(SCRATCH, `agent-ask-${name}.png`)

const failures: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[agent-ask] ${ok ? 'OK ' : 'FALHOU'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
{
  const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
  const now = Date.now()
  db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('claude_command', ?)", [
    fake.fakeCliPath('claude'),
  ])
  db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
  db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
  db.run(
    `INSERT INTO projects (id, name, color, position, created_at, updated_at) VALUES
       ('ask-front', 'Ask Front', '#9d8cff', -20, ?, ?), ('ask-api', 'Ask API', '#6fd695', -19, ?, ?)`,
    [now, now, now, now],
  )
  for (const [id, project, label] of [
    ['ask-front-web', 'ask-front', 'ask-web'],
    ['ask-api-core', 'ask-api', 'ask-api'],
  ]) {
    const path = join(SCRATCH, 'repos', label)
    mkdirSync(path, { recursive: true })
    db.run(
      'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      [id, project, label, path, now],
    )
  }
  writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
  db.close()
}

// ---------- 2ª subida: app real, HOME fake ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: shot('timeout') }).catch(() => {})
      throw new Error(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(500)
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

// MCP como uma sessão específica: o mesmo ?s= que o app carimba no spawn.
function mcpAs(sessionId: string) {
  const cfg = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8'))
  const url = new URL(cfg.url)
  url.searchParams.set('s', sessionId)
  const dir = join(SCRATCH, `mcp-as-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ ...cfg, url: url.toString() }))
  return connectMcp(dir)
}

const logOf = (pid: number) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const busSnapshot = () =>
  page.evaluate(() => window.api.agentBus.list()) as Promise<AgentBusSnapshot>

interface AskResult {
  askId: string | null
  mode: string
  routedTo: { sessionId: string; alias: string } | null
  depth: number | null
}

try {
  await waitReady(page)
  await dismissIntro()

  const [ptyA, ptyB] = (await page.evaluate(() =>
    Promise.all([
      window.api.sessions.spawn({ repoId: 'ask-front-web', name: 'web-front' }),
      window.api.sessions.spawn({ repoId: 'ask-api-core', name: 'api-contrato' }),
    ]),
  )) as Array<{ id: string }>
  await waitFor('2 session files', async () => fake.readSessionFiles().length >= 2)
  const files = fake.readSessionFiles()
  const fileA = files.find((f) => f.data.name === 'web-front')!
  const fileB = files.find((f) => f.data.name === 'api-contrato')!

  // O spawn via IPC cru não passa pelo store: o reload faz o boot ver as PTYs.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await waitReady(page)
  await dismissIntro()
  await waitFor('as duas sessões vivas', async () => {
    const live = (await page.evaluate(() =>
      window.api.sessions.listLiveGlobal(),
    )) as LiveSessionInfo[]
    return [ptyA.id, ptyB.id].every((id) => live.some((s) => s.id === id))
  })
  for (const id of [ptyA.id, ptyB.id]) {
    await page.evaluate((pty) => window.api.sessions.resize(pty, 80, 24), id)
  }

  const asA = await mcpAs(ptyA.id)
  const asB = await mcpAs(ptyB.id)

  const listed = await asA.call<{ items: Array<{ alias: string; project: string }> }>(
    'agent_list',
    {},
  )
  check(
    'agent_list de A mostra B com projeto',
    listed.items.some((p) => p.alias === 'api-contrato' && p.project === 'Ask API'),
    JSON.stringify(listed.items),
  )

  // ---------- 1. ask por repo com B ocupada: fila; B ociosa: stdin recebe ----------
  const asked = await asA.call<AskResult>('agent_ask', {
    repo: 'ask-api',
    text: 'Como está o contrato de POST /orders?',
  })
  check('ask roteado para B por repo', asked.routedTo?.sessionId === ptyB.id, JSON.stringify(asked))
  check('B ocupada (busy): ask fica na fila on-idle', asked.mode === 'queued', asked.mode)
  await page.waitForTimeout(4000)
  check('B ocupada: nada chegou no stdin', !logOf(fileB.data.pid).includes('pitwall-ask'))

  fake.setStatus(fileB.data.pid, 'idle')
  await waitFor(
    'stdin de B com o envelope',
    async () => logOf(fileB.data.pid).includes(`id="${asked.askId}"`),
    20_000,
  )
  const logB = logOf(fileB.data.pid)
  check(
    'envelope marca agente↔agente e o remetente',
    logB.includes('stdin: <pitwall-ask from="web-front @ Ask Front"') &&
      logB.includes('reply-with="agent_reply"') &&
      logB.includes('OUTRO AGENTE'),
  )
  check('A não recebeu o próprio ask', !logOf(fileA.data.pid).includes('pitwall-ask'))

  // ---------- 2. aba Conversas + fio temporário no mapa ----------
  await goToArea(page, 'projects')
  await page.getByTestId('projects-view-map').click()
  await waitFor(
    'fio de ask no mapa',
    async () => (await page.getByTestId('edge-ask-balloon').count()) === 1,
    20_000,
  )
  check('mapa: fio temporário com balão entre A e B', true)

  const dock = page.getByTestId('crew-dock')
  await dock.waitFor({ state: 'visible', timeout: 10_000 })
  if ((await dock.getAttribute('data-expanded')) !== 'true') {
    await page.getByTestId('crew-rail-conversations').click()
  }
  await page.getByTestId('conversations-tab-button').click()
  const row = page.locator(`[data-testid="conversation-row"][data-ask-id="${asked.askId}"]`)
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  const pair = await row.getByTestId('conversation-pair').innerText()
  check(
    'Conversas mostra o par de → para',
    pair.includes('web-front @ Ask Front') && pair.includes('api-contrato @ Ask API'),
    pair,
  )
  // O par trunca a ORIGEM primeiro: o destinatário fica inteiro à vista.
  const toFits = await row
    .getByTestId('conversation-pair')
    .evaluate((el) => {
      const to = el.lastElementChild as HTMLElement | null
      return !!to && to.scrollWidth <= to.clientWidth + 1
    })
  check('Conversas: destinatário visível sem truncar', toFits)
  await page.screenshot({ path: shot('1-pending') })

  // ---------- 3. B responde; A lê; o fio some ----------
  await asB.call('agent_reply', { askId: asked.askId, text: '201 Created com { id, status }' })
  const checked = await asA.call<{ status: string; reply: string }>('agent_check', {
    askId: asked.askId,
  })
  check(
    'agent_check de A traz a resposta',
    checked.status === 'answered' && checked.reply === '201 Created com { id, status }',
    JSON.stringify(checked),
  )
  await waitFor(
    'fio some do mapa',
    async () => (await page.getByTestId('edge-ask-balloon').count()) === 0,
    10_000,
  )
  check('mapa: fio temporário some após a resposta', true)
  await row.click()
  check(
    'Conversas: resposta expansível',
    (await row.getByTestId('conversation-reply').innerText()).includes('201 Created'),
  )
  await page.screenshot({ path: shot('2-answered') })

  // ---------- 4. profundidade: A→B→A→B ok, o 4º (B→A) recusado ----------
  fake.setStatus(fileA.data.pid, 'idle')
  const deliveredTo = async (askId: string, from: typeof asA) =>
    (await from.call<{ delivered: boolean }>('agent_check', { askId })).delivered
  const chain: Array<{ from: typeof asA; to: string; depth: number }> = [
    { from: asA, to: 'api-contrato', depth: 1 },
    { from: asB, to: 'web-front', depth: 2 },
    { from: asA, to: 'api-contrato', depth: 3 },
  ]
  for (const step of chain) {
    const r = await step.from.call<AskResult>('agent_ask', {
      to: step.to,
      text: `nível ${step.depth}`,
    })
    check(`cadeia: nível ${step.depth} aceito`, r.depth === step.depth, JSON.stringify(r))
    // A fila entrega um por turno: o próximo nível só existe com este entregue.
    await waitFor(`nível ${step.depth} entregue`, () => deliveredTo(r.askId!, step.from), 40_000)
  }
  const refused = await asB
    .call('agent_ask', { to: 'web-front', text: 'nível 4' })
    .then(() => '')
    .catch((e: Error) => e.message)
  check('cadeia: 4º nível recusado', /profundidade/.test(refused), refused)
  const snap = await busSnapshot()
  check(
    'contador rejectedDepth = 1',
    snap.counters.rejectedDepth === 1,
    JSON.stringify(snap.counters),
  )
  const counter = await page
    .locator('[data-testid="conversations-counters"] [data-counter="rejectedDepth"]')
    .innerText()
  check('aba Conversas mostra o contador de profundidade', counter.includes('1'), counter)
  await page.screenshot({ path: shot('3-depth-refused') })

  console.log('[agent-ask] page errors:', pageErrors.length ? pageErrors.join('\n') : 'nenhum')
  check('sem erros no renderer', pageErrors.length === 0)
  console.log('[agent-ask] screenshots em', SCRATCH)
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

if (failures.length > 0) {
  console.error(`[agent-ask] ${failures.length} falha(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('[agent-ask] PASS')
