import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { launchApp, REPO_ROOT } from '../driver/launch'
import { waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// Evidência visual do CrewPeek (quick look): espiar e DESBLOQUEAR uma filha sem
// criar aba no dockview. Mesmo aparato do validate-crew-dock: stub do `claude`
// (nenhuma API chamada) + HOME redirecionado pra um fake-home (o ~/.claude real
// não é tocado). A pergunta pendente (needs_input + pending_question) é criada
// pelo caminho de produção — a tool MCP handoff_ask, que é como a filha real
// levanta um bloqueio — e não por escrita direta no banco.

const require = createRequire(import.meta.url)
const SCRATCH = process.env.CREW_SCRATCH!
const FAKE_CLAUDE = join(SCRATCH, 'fake-claude-peek.sh')
const FAKE_HOME = join(SCRATCH, 'peek-home')
const MAIN_ENTRY = join(REPO_ROOT, 'out/main/index.js')

const SEEDS = [
  { id: 'peek-mauricio', task: 'Refatorar auth para tokens rotativos', mode: 'auto-edits' },
  { id: 'peek-otavio', task: 'Investigar listagem lenta no dashboard', mode: 'plan' },
  { id: 'peek-renata', task: 'Migrar endpoint de export para Cloud SQL', mode: 'interactive' },
]
const ASKED =
  'Migro os 3 chamadores do fluxo legado e apago auth/legacy.ts de uma vez (invalida as sessões vivas no deploy), ou mantenho os dois fluxos por uma janela de transição?'
const ANSWER = 'Mantenha os dois durante uma janela de 7 dias e só então remova o legado.'

// ---------- 1ª subida: roda migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const repos = (await queryDb(userData, 'SELECT id, label, path FROM repos ORDER BY label')) as Array<{
  id: string
  label: string
  path: string
}>
const target = repos.find((r) => r.path && existsSync(r.path))
if (!target) throw new Error('nenhum repo da cópia existe no disco')
console.log('[peek] repo-alvo:', target.label, target.path)

// ---------- seed ----------
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
const now = Date.now()
db.run(
  "UPDATE handoffs SET status = 'done' WHERE status IN ('pending','approved','running','needs_input')",
)
db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('claude_command', ?)", [FAKE_CLAUDE])
db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
for (const [i, s] of SEEDS.entries()) {
  db.run(
    `INSERT INTO handoffs
       (id, mother_session_id, target_repo_id, child_session_id, feature_id, task,
        context_json, composed_prompt, status, mode, summary, error, created_at, updated_at)
     VALUES (?, NULL, ?, NULL, NULL, ?, NULL, ?, 'pending', ?, NULL, NULL, ?, ?)`,
    [
      s.id,
      target.id,
      s.task,
      `## Tarefa\n${s.task}\n\nContexto: validação visual do CrewPeek.`,
      s.mode,
      now - i * 1000,
      now - i * 1000,
    ],
  )
}
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()
console.log('[peek]', SEEDS.length, 'handoffs pendentes seedados em', userData)

mkdirSync(join(FAKE_HOME, '.claude', 'sessions'), { recursive: true })
mkdirSync(join(FAKE_HOME, '.claude', 'projects'), { recursive: true })
writeFileSync(join(FAKE_HOME, '.zshrc'), '')
writeFileSync(join(FAKE_HOME, '.zshenv'), '')

// ---------- 2ª subida ----------
// CM_MCP_PORT: sem isto a cópia herda o mcp.json do app REAL (que segura a
// 41956) e o client falaria com a instância errada — foi o que aconteceu na 1ª
// tentativa ("handoff não encontrado").
const MCP_PORT = 41999
const app = await electron.launch({
  args: [MAIN_ENTRY, '--no-sandbox', `--user-data-dir=${userData}`],
  env: { ...process.env, HOME: FAKE_HOME, CM_MCP_PORT: String(MCP_PORT) },
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const consoleErrors: string[] = []
const pageErrors: string[] = []
const failedRequests: string[] = []
const mainErr: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`)
})
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))
page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText ?? '?'} ${r.url()}`))
app.process().stderr?.on('data', (d) => mainErr.push(String(d).trimEnd()))

const dock = page.locator('[data-testid="crew-dock"]')

async function dotTitles(): Promise<string[]> {
  return page.$$eval('[data-testid="crew-dock"] button[title]', (els) =>
    els.map((e) => e.getAttribute('title') ?? ''),
  )
}

async function workingCount(): Promise<number> {
  const fromTitles = (await dotTitles()).filter((t) => t.includes('trabalhando')).length
  const fromText = await dock
    .evaluate((el) => ((el as HTMLElement).innerText.match(/trabalhando/g) ?? []).length)
    .catch(() => 0)
  return Math.max(fromTitles, fromText)
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

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 120_000) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: join(SCRATCH, 'peek-timeout-diagnostic.png') }).catch(() => {})
      const dump = await dock.innerText({ timeout: 2000 }).catch(() => '(dock ausente)')
      console.log('[peek] DIAGNOSTICO no timeout — dock innerText:\n' + dump)
      throw new Error(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(1000)
  }
}

// Descrição estável de quem tem o foco AGORA — a resposta literal da pergunta 3.
async function activeElement(): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return '(null)'
    const bits = [el.tagName.toLowerCase()]
    if (el.getAttribute('data-crew-card')) bits.push(`[data-crew-card="${el.getAttribute('data-crew-card')}"]`)
    if (el.getAttribute('data-testid')) bits.push(`[data-testid="${el.getAttribute('data-testid')}"]`)
    if (el.getAttribute('placeholder')) bits.push(`[placeholder="${el.getAttribute('placeholder')}"]`)
    if (el.getAttribute('title')) bits.push(`[title="${el.getAttribute('title')}"]`)
    if (el.className && typeof el.className === 'string') {
      bits.push(`.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`)
    }
    const insideDock = !!el.closest('[data-testid="crew-dock"]')
    const insidePeek = !!el.closest('.pw-rise')
    return `${bits.join('')} | dock=${insideDock} peek=${insidePeek}`
  })
}

// Abas do dockview. .dv-tab é a aba renderizada; contamos também os painéis.
async function dockviewTabs(): Promise<{ tabs: number; panels: number; titles: string[] }> {
  return page.evaluate(() => ({
    tabs: document.querySelectorAll('.dv-tab').length,
    panels: document.querySelectorAll('.dv-view').length,
    titles: Array.from(document.querySelectorAll('.dv-tab')).map(
      (t) => (t as HTMLElement).innerText.trim().split('\n')[0],
    ),
  }))
}

// Estado durável do handoff pela tool MCP handoff_result — leitura autoritativa
// (passa pela conexão better-sqlite3 VIVA do app; ler o app.db por fora com
// sql.js pegaria um snapshot pré-WAL e mentiria sobre o estado).
async function mcpClient(): Promise<Client> {
  const info = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8')) as {
    url: string
    token: string
    pid: number
  }
  if (info.pid !== app.process().pid) {
    throw new Error(
      `mcp.json aponta pro pid ${info.pid}, mas o app desta run é ${app.process().pid} — ` +
        'o client falaria com OUTRA instância.',
    )
  }
  const client = new Client({ name: 'crew-peek-scenario', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(info.url), {
      requestInit: { headers: { Authorization: `Bearer ${info.token}` } },
    }),
  )
  return client
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = await mcpClient()
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
      content?: Array<{ type: string; text?: string }>
    }
    const text = res.content?.find((c) => c.type === 'text')?.text
    if (res.isError) throw new Error(`tool ${name} falhou: ${text ?? '(sem texto)'}`)
    if (res.structuredContent && Object.keys(res.structuredContent).length > 0) {
      return res.structuredContent
    }
    // O SDK alpha nem sempre propaga structuredContent — ok() sempre escreve o
    // mesmo objeto como texto, então o fallback é fiel.
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } finally {
    await client.close()
  }
}

interface HandoffState {
  status?: string
  pendingQuestion?: string | null
  liveStatus?: string | null
  lastText?: string | null
}

async function handoffState(id: string): Promise<HandoffState> {
  return (await mcpCall('handoff_result', { handoffId: id })) as HandoffState
}

try {
  await waitReady(page)
  await dismissIntro()
  console.log('[peek] app pronto — aguardando as 3 filhas')
  await waitFor('3 filhas trabalhando', async () => (await workingCount()) === 3)

  // Estado inicial do dock = default do produto, não o herdado do perfil real.
  await page.evaluate(() => localStorage.removeItem('cm:crew-dock'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await waitReady(page)
  await dismissIntro()
  await waitFor('dock remontado', async () => (await dotTitles()).length >= 4)
  await page.waitForTimeout(1500)

  // ---------- baseline: uma aba REAL no dockview ----------
  // Promover a Otávio a terminal dá ao dockview uma aba de verdade — assim a
  // contagem "antes/depois" mede algo, e a screenshot do peek mostra a aba viva
  // por trás do overlay.
  await dock.locator('button[title="Equipe: 3 sessão(ões) delegada(s)"]').click()
  await page.waitForTimeout(800)
  const otavioCard = page
    .locator('[data-testid="handoff-card"]')
    .filter({ hasText: 'listagem lenta' })
    .first()
  await otavioCard.locator('button[title="Anexar o terminal desta sessão-filha"]').click()
  await waitFor('aba do Otávio no dockview', async () => (await dockviewTabs()).tabs >= 1, 60_000)
  await page.waitForTimeout(2000)
  const tabsBaseline = await dockviewTabs()
  console.log('[peek] ABAS baseline (antes do peek):', JSON.stringify(tabsBaseline))

  // ---------- a filha levanta um bloqueio (MCP handoff_ask) ----------
  console.log(
    '[peek] handoff_ask →',
    JSON.stringify(await mcpCall('handoff_ask', { handoffId: 'peek-mauricio', question: ASKED })),
  )
  await waitFor('handoff em needs_input', async () => {
    const st = await handoffState('peek-mauricio')
    return st.status === 'needs_input' && !!st.pendingQuestion
  }, 30_000)
  const rowAsked = await handoffState('peek-mauricio')
  console.log('[peek] DB após ask:', JSON.stringify(rowAsked))
  await waitFor('card em espera na UI', async () =>
    (await dock.innerText().catch(() => '')).includes('esperando'),
  30_000)
  await page.waitForTimeout(1200)

  // ---------- teclado: Ctrl+J → ↑/↓ → Espaço ----------
  const focusBefore = await activeElement()
  console.log('[peek] FOCO antes do Ctrl+J:', focusBefore)
  await page.keyboard.press('Control+j')
  await page.waitForTimeout(700)
  const focusAfterCtrlJ = await activeElement()
  console.log('[peek] FOCO após Ctrl+J:', focusAfterCtrlJ)

  // Navega até a filha BLOQUEADA. O cursor entra onde o usuário estava (o card
  // do Otávio, cujo botão de terminal foi clicado antes) — ↑ sobe a lista, que
  // o orderCrew já reordenou pondo quem espera no topo.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(400)
  console.log('[peek] FOCO após ↓:', await activeElement())
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(400)
    const now = await activeElement()
    console.log(`[peek] FOCO após ↑ (${i + 1}):`, now)
    if (now.includes('peek-mauricio')) break
  }
  const focusOnCard = await activeElement()
  if (!focusOnCard.includes('peek-mauricio')) {
    throw new Error(`teclado não alcançou o card bloqueado — foco em ${focusOnCard}`)
  }

  await page.keyboard.press(' ')
  await page.waitForTimeout(1500)
  const peekOpen = await page.locator('.pw-rise').count()
  console.log('[peek] overlay montado após Espaço:', peekOpen)
  if (peekOpen === 0) throw new Error('Espaço não abriu o peek')
  const focusInPeek = await activeElement()
  console.log('[peek] FOCO dentro do peek:', focusInPeek)
  console.log('[peek] --- conteúdo do overlay ---\n' + (await page.locator('.pw-rise').innerText()))

  const tabsDuringPeek = await dockviewTabs()
  console.log('[peek] ABAS com o peek aberto:', JSON.stringify(tabsDuringPeek))
  const dockviewMounted = await page.evaluate(() => {
    const root = document.querySelector('.dv-dockview') as HTMLElement | null
    if (!root) return '(sem .dv-dockview)'
    const r = root.getBoundingClientRect()
    return `montado ${Math.round(r.width)}x${Math.round(r.height)} visível=${r.width > 0 && r.height > 0}`
  })
  console.log('[peek] dockview por trás:', dockviewMounted)
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(SCRATCH, 'peek-1-aberto.png') })

  // A11y: o overlay é modal de fato? (role/aria + contenção do Tab)
  console.log('[peek] ARIA do overlay:', await page.evaluate(() => {
    const panel = document.querySelector('.pw-rise') as HTMLElement | null
    const backdrop = panel?.parentElement as HTMLElement | null
    return JSON.stringify({
      backdropRole: backdrop?.getAttribute('role'),
      ariaModal: backdrop?.getAttribute('aria-modal'),
      ariaLabelledby: backdrop?.getAttribute('aria-labelledby'),
      peekZ: backdrop ? getComputedStyle(backdrop).zIndex : null,
      sashes: document.querySelectorAll('.dv-sash').length,
      sashZ: document.querySelector('.dv-sash')
        ? getComputedStyle(document.querySelector('.dv-sash')!).zIndex
        : '(nenhum sash: layout de painel único)',
    })
  }))
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(250)
    console.log(`[peek] FOCO após Tab ${i + 1}:`, await activeElement())
  }
  await page.locator('.pw-rise textarea').focus()

  // ---------- responder pelo campo do peek ----------
  const textarea = page.locator('.pw-rise textarea')
  await textarea.fill(ANSWER)
  await page.waitForTimeout(300)
  await textarea.press('Enter')
  await waitFor('handoff saiu de needs_input', async () => {
    const st = await handoffState('peek-mauricio')
    return st.status !== 'needs_input'
  }, 30_000)
  const rowAnswered = await handoffState('peek-mauricio')
  console.log('[peek] DB após resposta:', JSON.stringify(rowAnswered))
  await page.waitForTimeout(3000)
  await page.screenshot({ path: join(SCRATCH, 'peek-2-respondido.png') })

  const dockTextAfter = await dock.innerText().catch(() => '(sem dock)')
  console.log('[peek] dock innerText após resposta:\n' + dockTextAfter)
  console.log('[peek] ainda tem "esperando" no dock?', dockTextAfter.includes('esperando'))

  // ---------- Esc: volta pro card; Esc de novo: sai do dock ----------
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1000)
  const peekAfterEsc = await page.locator('.pw-rise').count()
  const focusAfterEsc = await activeElement()
  console.log('[peek] overlay após Esc:', peekAfterEsc, '| FOCO:', focusAfterEsc)

  const tabsAfter = await dockviewTabs()
  console.log('[peek] ABAS depois de fechar o peek:', JSON.stringify(tabsAfter))
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(SCRATCH, 'peek-3-dock-apos.png') })

  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const focusAfterEsc2 = await activeElement()
  console.log('[peek] FOCO após 2º Esc (saída do dock):', focusAfterEsc2)

  console.log('[peek] ===== RESUMO =====')
  console.log('[peek] abas antes:', tabsBaseline.tabs, '| durante:', tabsDuringPeek.tabs, '| depois:', tabsAfter.tabs)
  console.log('[peek] status handoff: pending→', rowAsked?.status, '→', rowAnswered?.status)
  console.log('[peek] pendingQuestion após resposta:', JSON.stringify(rowAnswered?.pendingQuestion))
  console.log('[peek] liveStatus da filha após resposta:', JSON.stringify(rowAnswered?.liveStatus))
  console.log('[peek] --- console errors/warnings ---')
  console.log(consoleErrors.length ? consoleErrors.join('\n') : 'nenhum')
  console.log('[peek] --- page errors ---')
  console.log(pageErrors.length ? pageErrors.join('\n') : 'nenhum')
  console.log('[peek] --- requests falhados ---')
  console.log(failedRequests.length ? failedRequests.join('\n') : 'nenhum')
  console.log('[peek] --- main stderr ---')
  console.log(mainErr.length ? mainErr.join('\n') : 'nenhum')
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
}
