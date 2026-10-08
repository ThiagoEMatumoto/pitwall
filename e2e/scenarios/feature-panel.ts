import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import matter from 'gray-matter'
import { launchApp, writeCopyPrefs, type LaunchResult } from '../driver/launch'
import { createFakeHome } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// F4 do Mission Control v2: painel da feature sobre o mapa, sobre a CÓPIA do
// perfil real, com PTYs vivas do stub `claude` (HOME fake; CM_DRIVE_SAFE).
// O mesmo stub responde ao `claude -p` da síntese holística com um doc HOSTIL
// (que "reescreve" regras e notas) — nenhuma API real é chamada: o stub vem
// primeiro no PATH e no claude_command.
// Asserções (evidência positiva):
//   header do card da feature abre o painel (não navega) · regra "Desconto máx
//   10%" e uma nota fixada digitadas no painel chegam ao .md (autosave) ·
//   relaunch com o mesmo userDataDir → continuam no painel e no .md · síntese
//   forçada roda (Estado atual muda) e regra/nota saem iguais, e o prompt da
//   síntese não as contém · sessão nova da feature recebe a regra no arquivo
//   --append-system-prompt-file · "Fixar na feature" tira a nota do canvas e ela
//   aparece nas notas fixadas (e no card) · toolbar de seleção não cobre o
//   header da feature · com a modal do terminal aberta os toasts ficam fora dela
//   · status da modal = status do composer · zero erros de console.
// Rodar: PANEL_SHOTS=<dir> npx tsx e2e/scenarios/feature-panel.ts

const SHOTS = process.env.PANEL_SHOTS ?? join(tmpdir(), `feature-panel-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0
const RULE = 'Desconto máx 10%'
const NOTE = 'Lembrar: PIX só acima de R$ 50'
const LOOSE_NOTE = 'Nota solta que vai para a feature'
const SYNTH_STATE = 'Estado reescrito pela síntese e2e.'

const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[panel] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// `claude` do cenário: com -p é a síntese (grava o prompt e devolve o doc
// hostil preparado pelo cenário); sem -p é o stub interativo do fake-home.
const binDir = join(fake.root, 'bin')
const synthOut = join(fake.logDir, 'synth-output.md')
const synthPrompt = join(fake.logDir, 'synth-prompt.txt')
const dispatch = join(binDir, 'claude')
writeFileSync(
  dispatch,
  `#!/usr/bin/env bash
for ((i=1; i<=$#; i++)); do
  if [ "\${!i}" = "-p" ]; then
    j=$((i+1)); printf '%s' "\${!j}" > ${shq(synthPrompt)}
    cat ${shq(synthOut)}
    exit 0
  fi
done
exec ${shq(fake.fakeCliPath('claude'))} "$@"
`,
)
chmodSync(dispatch, 0o755)
const env = { ...fake.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
const repos = (
  await queryDb<{ id: string; label: string; path: string; project_id: string }>(
    userData,
    'SELECT id, label, path, project_id FROM repos ORDER BY position, label',
  )
).filter((r) => r.path?.startsWith('/') && existsSync(r.path))
const repo = repos[0]
if (!repo) throw new Error('a cópia precisa de pelo menos um repo')
console.log(`[panel] repo: ${repo.label}`)
writeCopyPrefs(userData, {
  claude_command: dispatch,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

let current: LaunchResult | null = null
const consoleErrors: string[] = []

async function boot(): Promise<LaunchResult> {
  const launched = await launchApp({ userDataDir: userData, env })
  launched.page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message))
  launched.page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
  })
  await waitReady(launched.page)
  const skip = launched.page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  current = launched
  return launched
}

async function shutdown(l: LaunchResult): Promise<void> {
  const proc = l.app.process()
  await Promise.race([l.app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
  current = null
}

const shotOf = (l: LaunchResult) => (name: string) =>
  l.page
    .screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
    .catch(() => {})

async function waitFor(
  l: LaunchResult,
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs = 20_000,
) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[panel] timeout esperando: ${label}`)
      await shotOf(l)(`timeout-${label.replace(/\W+/g, '-')}`)
      return false
    }
    await l.page.waitForTimeout(250)
  }
}

const docBody = (path: string) => matter(readFileSync(path, 'utf8')).content
function section(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}\n`)
  if (start === -1) return ''
  const next = body.indexOf('\n## ', start + 1)
  return body.slice(start + heading.length + 4, next === -1 ? body.length : next).trim()
}

async function openMap(l: LaunchResult): Promise<boolean> {
  await goToArea(l.page, 'projects')
  const map = l.page.getByTestId('session-map')
  // A vista do mapa persiste entre subidas e o atalho alterna: só aperta se fechado.
  await map.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {})
  if (!(await map.isVisible())) await l.page.keyboard.press('Control+Shift+KeyG')
  return waitFor(l, 'mapa', () => map.isVisible())
}

const featureHeader = (l: LaunchResult, id: string) =>
  l.page.locator(
    `[data-testid="lane-feature"][data-feature-id="${id}"] [data-testid="feature-card-header"]`,
  )
const panel = (l: LaunchResult) => l.page.getByTestId('feature-panel')

async function typeSection(
  l: LaunchResult,
  tab: 'rules' | 'notes',
  text: string,
): Promise<boolean> {
  // Notas fixadas e regras de negócio dividem a aba "Notas & regras".
  await l.page.getByTestId('feature-panel-tab-notes').click()
  await l.page.getByTestId(`feature-panel-${tab}-view`).click()
  const input = l.page.getByTestId(`feature-panel-${tab}-input`)
  await input.fill(text)
  return waitFor(
    l,
    `autosave ${tab}`,
    async () =>
      (await l.page.getByTestId(`feature-panel-${tab}-status`).getAttribute('data-state')) ===
      'saved',
    5000,
  )
}

type Box = { x: number; y: number; width: number; height: number }
const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

let fatal: unknown = null
let featureId = ''
let docPath = ''
try {
  // ================= Subida 2: criar, digitar, fixar, modal =================
  const a = await boot()
  const shotA = shotOf(a)
  const created = await a.page.evaluate(
    async ({ projectId, repoId, path }) =>
      window.api.features.create({
        projectId,
        title: `E2E painel ${Date.now()}`,
        status: 'in-progress',
        overview: 'Feature criada pelo cenário feature-panel.',
        repos: [{ repoId, branch: 'feat/e2e-panel', worktreePath: path }],
      }),
    { projectId: repo.project_id, repoId: repo.id, path: repo.path },
  )
  featureId = created.id
  docPath = created.docPath
  const s1 = await a.page.evaluate(
    async ({ repoId, featureId }) =>
      window.api.sessions.spawn({ repoId, name: 'painel-a', featureId }),
    { repoId: repo.id, featureId },
  )
  check(!!s1?.id, `sessão S1 da feature subiu (${s1?.id})`)
  check(await openMap(a), 'mapa aberto')
  await a.page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  check(
    await waitFor(
      a,
      'card da feature',
      async () => (await featureHeader(a, featureId).count()) === 1,
    ),
    'card da feature no mapa, com header',
  )

  // ---- toolbar de seleção x header da feature ----
  const s1Card = a.page.locator(`[data-testid="session-card"][data-session-id="${s1.id}"]`)
  await s1Card
    .getByTestId('card-status')
    .click()
    .catch(() => {})
  const toolbar = a.page.getByTestId('map-selection-toolbar')
  if (await waitFor(a, 'toolbar de seleção', async () => (await toolbar.count()) === 1, 5000)) {
    const tb = await toolbar.boundingBox()
    const headers = await a.page
      .locator('[data-testid="feature-card-header"], [data-testid="lane-repo"] > :first-child')
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 60) }
        }),
      )
    check(
      !!tb && headers.every((h) => !intersects(tb, h)),
      `toolbar de seleção não intersecta header de feature/lane (${headers.length} headers)`,
    )
    await shotA('toolbar-selection')
  } else {
    check(false, 'toolbar de seleção apareceu')
  }
  await a.page.keyboard.press('Escape')

  // ---- abrir painel pelo header ----
  await featureHeader(a, featureId).click()
  check(
    await waitFor(a, 'painel', async () => (await panel(a).count()) === 1),
    'header do card abre o painel da feature',
  )
  check(
    await a.page.getByTestId('session-map').isVisible(),
    'o painel não navega (mapa segue visível)',
  )
  const pbox = await panel(a).boundingBox()
  check(!!pbox && Math.abs(pbox.width - 380) <= 2, `painel lateral de ~380px (${pbox?.width})`)

  check(await typeSection(a, 'rules', RULE), 'regra digitada e autosave confirmado')
  check(await typeSection(a, 'notes', NOTE), 'nota fixada digitada e autosave confirmado')
  const bodyA = docBody(docPath)
  check(
    section(bodyA, 'Regras de negócio') === RULE,
    `.md tem a regra (${JSON.stringify(section(bodyA, 'Regras de negócio'))})`,
  )
  check(section(bodyA, 'Notas fixadas') === NOTE, '.md tem a nota fixada')
  await shotA('panel-typed')

  // ---- "Fixar na feature" numa nota solta ----
  await a.page.getByTestId('feature-panel-close').click()
  await a.page.getByTestId('map-top-bar').getByTitle('Nova nota solta').click()
  const editor = a.page.getByLabel('Texto da nota')
  await editor.waitFor({ state: 'visible', timeout: 5000 })
  await editor.fill(LOOSE_NOTE)
  await editor.press('Control+Enter')
  const loose = a.page.locator('[data-testid="canvas-note"]', { hasText: LOOSE_NOTE })
  check(
    await waitFor(a, 'nota solta salva', async () => (await loose.count()) === 1),
    'nota solta criada no mapa',
  )
  await loose.getByTestId('note-fix-to-feature').click()
  await a.page.getByTestId('note-feature-picker-search').fill(created.title)
  await a.page
    .getByTestId('note-feature-picker')
    .getByRole('option', { name: new RegExp(created.title) })
    .click()
  check(
    await waitFor(a, 'nota sai do canvas', async () => (await loose.count()) === 0),
    '"Fixar na feature": a nota some do canvas',
  )
  check(
    await waitFor(a, 'nota no .md', async () =>
      section(docBody(docPath), 'Notas fixadas').includes(LOOSE_NOTE),
    ),
    'a nota solta foi anexada às notas fixadas do .md',
  )
  check(
    await waitFor(
      a,
      'lembrete no card',
      async () =>
        // Abaixo de REMINDER_LINE_MIN_ZOOM o card mostra só o chip "N lembretes"
        // (card-display.ts); no zoom de enquadrar é ele que aparece.
        (await a.page
          .locator(
            `[data-testid="lane-feature"][data-feature-id="${featureId}"] :is([data-testid="feature-card-reminder"], [data-testid="feature-card-reminders-chip"])`,
          )
          .count()) >= 1,
      8000,
    ),
    'as notas fixadas aparecem resumidas no card da feature',
  )
  await shotA('note-fixed')

  // ---- modal do terminal: toasts fora dela e status único ----
  await s1Card.getByTestId('card-interact').click()
  const lift = a.page.locator('[role="dialog"][data-peek-lift]')
  check(
    await waitFor(a, 'modal', async () => (await lift.count()) === 1),
    'modal do terminal aberta',
  )
  await a.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      for (let i = 1; i <= 3; i++) {
        w.webContents.send('notify:event', {
          title: `Aviso e2e ${i}`,
          body: 'teste de sobreposição',
          at: Date.now() + i,
        })
      }
    }
  })
  await a.page.waitForTimeout(600)
  const liftBox = await lift.first().boundingBox()
  const stackRects = await a.page.evaluate(() => {
    const stack = document.querySelector<HTMLElement>('[data-testid="toast-stack"]')
    if (!stack || stack.hidden) return []
    return [
      ...stack.querySelectorAll<HTMLElement>(
        '[data-testid="toast-card"]:not([hidden]), [data-testid="toast-overflow"]',
      ),
    ]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
  })
  check(
    !!liftBox && stackRects.every((r) => !intersects(r, liftBox)),
    `toasts não cobrem a modal (${stackRects.length} caixas visíveis)`,
  )
  // O status mora só no selo do header: sem subagentes, a faixa do HUD (que o
  // repetia) não aparece; com eles, mostra o mesmo selo.
  const statusSame = await waitFor(a, 'status só no header', async () => {
    const head = (await lift.getByTestId('peek-live-badge').innerText()).trim()
    const hud = lift.getByTestId('agent-hud-status')
    if (head === '') return false
    if ((await hud.count()) === 0) return true
    return head.toLowerCase() === (await hud.innerText()).trim().toLowerCase()
  })
  check(statusSame, 'status da modal não se repete: só o selo do header (ou o HUD igual a ele)')
  await shotA('modal-toasts')
  await a.page.keyboard.press('Shift+Escape')
  await shutdown(a)

  // ================= Entre subidas: registro de sessão + doc hostil =================
  const db = new DatabaseSync(join(userData, 'app.db'))
  db.prepare(
    `INSERT INTO feature_session_records (session_id, feature_id, cc_session_id, summary, model, session_at, created_at)
     VALUES (?, ?, NULL, 'Sessão e2e mexeu no checkout.', NULL, ?, ?)`,
  ).run(s1.id, featureId, Date.now(), Date.now())
  db.close()
  const before = matter(readFileSync(docPath, 'utf8'))
  writeFileSync(
    synthOut,
    matter.stringify(
      [
        '## Visão geral\n\nVisão reescrita pela síntese.',
        '## Regras de negócio\n\n- Desconto máx 50%',
        '## Notas fixadas\n\n(o modelo apagou as notas)',
        `## Estado atual\n\n${SYNTH_STATE}`,
      ].join('\n\n'),
      before.data,
    ),
  )

  // ================= Subida 3: persistência, síntese, system prompt =================
  const b = await boot()
  const shotB = shotOf(b)
  check(await openMap(b), 'mapa aberto após relaunch')
  await b.page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  // S1 não sobrevive ao relaunch (abas não restauradas): sessão nova da feature
  // traz o card de volta e prova a injeção da regra no system prompt.
  const s2 = await b.page.evaluate(
    async ({ repoId, featureId }) =>
      window.api.sessions.spawn({ repoId, name: 'painel-b', featureId }),
    { repoId: repo.id, featureId },
  )
  const argvLine = () =>
    fake
      .readCliLog('claude')
      .split('\n')
      .find((l) => l.startsWith('argv:') && l.includes('painel-b')) ?? ''
  const argv = await waitFor(b, 'argv de S2', async () => argvLine().includes('--append-system-prompt-file'))
  // %q do bash escapa espaços com "\ ": desfaz antes de abrir o arquivo.
  const promptFile = (/--append-system-prompt-file ((?:\\ |\S)+)/.exec(argvLine())?.[1] ?? '').replaceAll('\\ ', ' ')
  const promptText = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : ''
  check(
    argv && promptText.includes(RULE),
    `sessão nova da feature recebe a regra no --append-system-prompt-file (${promptFile})`,
  )
  check(!promptText.includes(NOTE), 'as notas fixadas NÃO entram no system prompt')

  check(
    await waitFor(
      b,
      'card da feature (relaunch)',
      async () => (await featureHeader(b, featureId).count()) === 1,
    ),
    `card da feature no mapa após relaunch (S2 ${s2?.id})`,
  )
  // O enquadrar lá em cima rodou ANTES de S2 existir, e o mapa não enquadra nó
  // novo sozinho: sem enquadrar de novo o card pode nascer fora da tela.
  await b.page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await featureHeader(b, featureId).click()
  await waitFor(b, 'painel (relaunch)', async () => (await panel(b).count()) === 1)
  await b.page.getByTestId('feature-panel-tab-notes').click()
  check(
    await waitFor(b, 'regra no painel', async () =>
      (await b.page.getByTestId('feature-panel-rules-view').innerText()).includes(RULE),
    ),
    'após relaunch a regra continua no painel',
  )
  await b.page.getByTestId('feature-panel-tab-notes').click()
  check(
    await waitFor(b, 'nota no painel', async () =>
      (await b.page.getByTestId('feature-panel-notes-view').innerText()).includes('PIX só acima'),
    ),
    'após relaunch a nota fixada continua no painel',
  )
  check(
    section(docBody(docPath), 'Regras de negócio') === RULE,
    'após relaunch a regra continua no .md',
  )

  // ---- síntese forçada com o LLM "reescrevendo" as seções ----
  const rulesBefore = section(docBody(docPath), 'Regras de negócio')
  const notesBefore = section(docBody(docPath), 'Notas fixadas')
  await b.page.evaluate((id) => window.api.features.synthesizeNow(id), featureId)
  const after = docBody(docPath)
  check(
    section(after, 'Estado atual') === SYNTH_STATE,
    'a síntese rodou (Estado atual veio do LLM)',
  )
  check(section(after, 'Regras de negócio') === rulesBefore, 'após a síntese a regra sai igual')
  check(
    section(after, 'Notas fixadas') === notesBefore,
    'após a síntese as notas fixadas saem iguais',
  )
  check(
    !after.includes('50%') && !after.includes('o modelo apagou'),
    'nada do texto hostil do LLM nas seções do usuário',
  )
  const sentPrompt = existsSync(synthPrompt) ? readFileSync(synthPrompt, 'utf8') : ''
  check(
    sentPrompt.length > 0 && !sentPrompt.includes(RULE) && !sentPrompt.includes('PIX só acima'),
    'o prompt da síntese não contém regras nem notas',
  )
  await b.page.getByTestId('feature-panel-tab-notes').click()
  check(
    await waitFor(b, 'regra no painel pós-síntese', async () =>
      (await b.page.getByTestId('feature-panel-rules-view').innerText()).includes(RULE),
    ),
    'após a síntese a regra continua no painel',
  )
  await b.page.getByTestId('feature-panel-tab-decisions').click()
  await shotB('panel-after-synth')

  check(consoleErrors.length === 0, `zero erros de console (${consoleErrors.length})`)
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 5).join('\n---\n'))
} catch (err) {
  fatal = err
  console.error('[panel] erro fatal:', err)
  if (current) await shotOf(current)('fatal')
} finally {
  if (current) await shutdown(current)
  fake.cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log(
  `\n[panel] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS}`,
)
if (fatal || failed.length) process.exit(1)
