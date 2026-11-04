// Valida, no app BUILDADO, perguntas e diálogos da CLI respondidos pelo Chat:
//  (a) AskUserQuestion multiSelect: checkboxes + Other -> 2 marcadas + Other -> revisão
//      no card -> Enviar -> a resposta do Claude cita as 3;
//  (b) single-select -> "Conversar sobre isso" -> card some, Composer livre, mensagem vai;
//  (c) /hooks pelo Composer -> card genérico (sem mandar ao terminal) -> Esc pelo card;
//  (d) /permissions -> card genérico -> troca de aba e volta, Esc, nada alterado.
// Sessão NOVA do claude (HOME real pra auth, haiku/low, modo Padrão) num repo-sandbox
// inserido só na cópia do userData. Uso:
//   QM_SB=<dir> npx tsx e2e/scenarios/validate-chat-questions-menus.ts
// Saídas: QM_SB/shots/*.png e QM_SB/scenario.log; termina com [verdict] PASS/FAIL.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import type { Locator } from 'playwright'
import { launchApp } from '../driver/launch'
import { waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// Marcadores de sessão Claude Code herdados do harness: a sessão spawnada se trataria
// como aninhada (sem transcript) e o chat ficaria vazio.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') delete process.env[k]
}

const require = createRequire(import.meta.url)
const SB = process.env.QM_SB ?? join(tmpdir(), `chat-questions-menus-${Date.now()}`)
const SANDBOX = join(SB, 'drive-sandbox')
const SHOTS = join(SB, 'shots')
const LOG = join(SB, 'scenario.log')
mkdirSync(SANDBOX, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
const REPO_ID = 'questions-menus-sandbox-repo'
const REPO_LABEL = 'questions-menus-sandbox'
const SESSION_NAME = 'questions-menus-e2e'
const PROMPT_MULTI =
  'Use a ferramenta AskUserQuestion com UMA pergunta multiSelect com 3 opções sobre cores. ' +
  'Depois da resposta, repita exatamente todas as cores que escolhi, numa linha, e pare.'
const OTHER_TEXT = 'verde agua'
const PROMPT_SINGLE =
  'Use a ferramenta AskUserQuestion com UMA pergunta single-select (multiSelect false) com 3 ' +
  "opções sobre frutas. Se eu preferir conversar, responda só 'pode falar' e pare."
const CHAT_MSG = 'Quero falar de abacaxi. Responda só: ok abacaxi.'
const TERMINAL_RE =
  /ir pro terminal|use o terminal|responda (?:por lá|no terminal|.*ou no terminal)|abra o terminal/i
const SETTINGS_FILES = [
  join(homedir(), '.claude', 'settings.json'),
  join(homedir(), '.claude', 'settings.local.json'),
  join(SANDBOX, '.claude', 'settings.json'),
  join(SANDBOX, '.claude', 'settings.local.json'),
]

const log = (...a: unknown[]) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  appendFileSync(LOG, line + '\n')
}
const results: Array<{ step: string; ok: boolean; detail: string }> = []
function check(step: string, ok: boolean, detail = ''): void {
  results.push({ step, ok, detail })
  log(`[check] ${ok ? 'PASS' : 'FAIL'} ${step}${detail ? ` — ${detail}` : ''}`)
}
function settingsHashes(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of SETTINGS_FILES)
    out[f] = existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent'
  return out
}

// ---------- 1ª subida: migrations na cópia; semeia o repo-sandbox ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
log('[qm] userData copy', userData, 'sandbox', SANDBOX)

const projects = await queryDb<{ id: string }>(
  userData,
  'SELECT id FROM projects ORDER BY position LIMIT 1',
)
if (!projects[0]) throw new Error('a cópia não tem projeto para pendurar o repo-sandbox')
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
db.run(
  'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 999, ?)',
  [REPO_ID, projects[0].id, REPO_LABEL, SANDBOX, Date.now()],
)
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()

// ---------- 2ª subida ----------
// Em Wayland a janela do Electron lançado pelo Playwright não chega a ser mapeada; XWayland mapeia.
const OZONE = process.env.QM_OZONE ?? 'x11'
const { app, page, mainOutput } = await launchApp({
  userDataDir: userData,
  extraArgs: OZONE ? [`--ozone-platform=${OZONE}`] : [],
})
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.stack ?? e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
})

const shot = async (name: string) => {
  const p = join(SHOTS, `${name}.png`)
  await page.screenshot({ path: p }).catch(() => {})
  log('[shot]', p)
  return p
}
async function waitFor(label: string, fn: () => Promise<boolean>, ms = 120_000) {
  const t0 = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return
    if (Date.now() - t0 > ms) {
      await shot(`timeout-${label.replace(/\W+/g, '-')}`)
      throw new Error('timeout: ' + label)
    }
    await page.waitForTimeout(500)
  }
}
const attentionDebug = () =>
  page.evaluate(() =>
    (
      window as unknown as { api: { sessions: { attentionDebug: () => Promise<unknown> } } }
    ).api.sessions.attentionDebug(),
  )
async function sessionStatus(): Promise<string | undefined> {
  const live = (await page.evaluate(() =>
    (
      window as unknown as { api: { sessions: { listLiveGlobal: () => Promise<unknown[]> } } }
    ).api.sessions.listLiveGlobal(),
  )) as Array<{ status?: string; cwd?: string | null; repo?: { id: string } | null }>
  return live.find((s) => s.repo?.id === REPO_ID || s.cwd === SANDBOX)?.status
}
async function sessionId(): Promise<string | undefined> {
  const live = (await page.evaluate(() =>
    (
      window as unknown as { api: { sessions: { listLiveGlobal: () => Promise<unknown[]> } } }
    ).api.sessions.listLiveGlobal(),
  )) as Array<{ id: string; cwd?: string | null; repo?: { id: string } | null }>
  return live.find((s) => s.repo?.id === REPO_ID || s.cwd === SANDBOX)?.id
}
// Card que não veio: fotografa o terminal cru (o que a CLI mostrava) e fecha o diálogo
// com Esc direto no PTY, para o passo seguinte não digitar dentro dele.
async function captureTerminalAndEscape(name: string): Promise<void> {
  const toTerm = page.getByRole('button', { name: 'Mudar para Terminal' })
  if (await toTerm.count()) {
    await toTerm.first().click()
    await page.waitForTimeout(1500)
    await shot(`${name}-terminal`)
    await page.getByRole('button', { name: 'Mudar para Chat' }).first().click()
    await page.waitForTimeout(1000)
  }
  const id = await sessionId()
  for (let i = 0; i < 3 && id; i++) {
    if ((await sessionStatus()) === 'idle') break
    await page.evaluate(
      ([sid]) =>
        (
          window as unknown as {
            api: { sessions: { write: (id: string, d: string) => Promise<void> } }
          }
        ).api.sessions.write(sid, '\x1b'),
      [id],
    )
    await page.waitForTimeout(1200)
  }
  log('[qm] recuperação: status depois do Esc no PTY =', await sessionStatus())
}
const waitIdle = (label: string, ms = 180_000) =>
  waitFor(label, async () => (await sessionStatus()) === 'idle', ms)

async function composerTextarea(): Promise<Locator> {
  const idx = await page
    .locator('textarea')
    .evaluateAll((els) =>
      els.findIndex(
        (e) =>
          e.getAttribute('data-testid') !== 'plan-feedback' &&
          !e.classList.contains('xterm-helper-textarea') &&
          (e as HTMLElement).offsetParent !== null &&
          !(e as HTMLTextAreaElement).disabled,
      ),
    )
  if (idx < 0) throw new Error('Composer não encontrado')
  return page.locator('textarea').nth(idx)
}
async function sendComposer(text: string): Promise<void> {
  const c = await composerTextarea()
  await c.click()
  await c.fill(text)
  await c.press('Enter')
}
// Trust de pasta nova: o chat espelha como PermissionCard (kind trust).
async function answerTrustIfShown(): Promise<boolean> {
  const card = page.locator('[data-testid="permission-card"]')
  if (!(await card.count())) return false
  const txt = await card
    .first()
    .innerText()
    .catch(() => '')
  if (!/trust|confi/i.test(txt)) return false
  await shot('00-trust-card')
  await card.first().locator('[data-testid="permission-approve"]').click()
  log('[qm] trust respondido pelo card:', txt.replace(/\s+/g, ' ').slice(0, 160))
  return true
}
async function noTerminalHints(): Promise<string> {
  const body = await page.locator('body').innerText()
  const hit = TERMINAL_RE.exec(body)?.[0]
  const banners =
    (await page.locator('[data-testid="chat-wait-open-terminal"]').count()) +
    (await page.locator('[data-testid="chat-wait-unrecognized"]').count())
  return [hit ? `texto "${hit}"` : '', banners ? `${banners} banner(s) de terminal` : '']
    .filter(Boolean)
    .join('; ')
}

// Card de pergunta pendente: o último com o cabeçalho "Claude perguntou".
const questionCard = () =>
  page
    .locator('div.rounded-md')
    .filter({ has: page.getByText('Claude perguntou', { exact: true }) })
    .last()
const toggles = () => questionCard().locator('button.w-full')
async function toggleStates(): Promise<Array<{ label: string; checked: boolean }>> {
  return toggles().evaluateAll((els) =>
    els.map((e) => ({
      label: (e.querySelector('div.font-medium') as HTMLElement | null)?.innerText.trim() ?? '',
      checked: e.innerHTML.includes('square-check'),
    })),
  )
}
const reviewCard = () =>
  page
    .locator('div.rounded-md')
    .filter({ has: page.getByText('Revise suas respostas', { exact: true }) })
    .last()

// Transcript da sessão no sandbox: linhas JSONL do arquivo mais recente.
function transcriptLines(): string[] {
  const dir = join(homedir(), '.claude', 'projects', SANDBOX.replace(/[^a-zA-Z0-9]/g, '-'))
  if (!existsSync(dir)) return []
  const f = readdirSync(dir)
    .filter((x) => x.endsWith('.jsonl'))
    .map((x) => join(dir, x))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  return f ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
}
type Entry = {
  type?: string
  message?: { role?: string; content?: unknown }
  toolUseResult?: unknown
}
function entriesFrom(mark: number): Entry[] {
  return transcriptLines()
    .slice(mark)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Entry]
      } catch {
        return []
      }
    })
}
function assistantTextFrom(mark: number): string {
  return entriesFrom(mark)
    .filter((e) => e.type === 'assistant' && Array.isArray(e.message?.content))
    .flatMap((e) =>
      (e.message!.content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!),
    )
    .join('\n')
}
function askAnswersFrom(mark: number): Record<string, string> | null {
  for (const e of entriesFrom(mark).reverse()) {
    const r = e.toolUseResult as { answers?: Record<string, string> } | undefined
    if (r && typeof r === 'object' && r.answers) return r.answers
  }
  return null
}
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

let fallbackBefore: unknown = null
let fallbackAfter: unknown = null
const hashesBefore = settingsHashes()
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 20 && !(await skip.count()); i++) await page.waitForTimeout(500)
  if (await skip.count()) await skip.click().catch(() => {})
  log(
    '[qm] drive-safe:',
    mainOutput()
      .split('\n')
      .filter((l) => l.includes('drive-safe') || l.includes('[launch]')),
  )
  fallbackBefore = await attentionDebug()
  log('[qm] attention-debug antes:', fallbackBefore)

  // ---------- spawn pela UI: haiku / low / Padrão (default do diálogo) / chat ----------
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(REPO_LABEL)
  await search.press('Enter')
  await page.getByTestId('spawn-provider').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByPlaceholder('opcional').first().fill(SESSION_NAME)
  await page.getByRole('button', { name: 'Haiku', exact: true }).click()
  await page.getByRole('button', { name: 'Low', exact: true }).click()
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  // Dois "Padrão" no diálogo (preset e modo): este é o do controle "Permissão".
  await page.locator('label:text-is("Permissão") + div >> button:text-is("Padrão")').click()
  await shot('01-spawn-dialog')
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()

  let trusted = false
  await waitFor(
    'composer da sessão',
    async () => {
      if (!trusted) trusted = await answerTrustIfShown()
      const st = await sessionStatus()
      return st === 'idle' || st === 'waiting'
    },
    90_000,
  )
  await page.waitForTimeout(1500)
  await answerTrustIfShown()
  await shot('02-chat-ready')
  const argv = execSync("pgrep -af 'claude .*--session-id' || true")
    .toString()
    .split('\n')
    .filter((l) => l.includes(userData))
  log('[qm] argv do claude spawnado:', argv)
  check(
    'spawn em modo Padrão',
    argv.length === 1 && !/--permission-mode (?!default)/.test(argv[0]),
    argv[0]?.match(/--permission-mode \S+/)?.[0] ?? 'sem --permission-mode',
  )

  // ---------- (a) multiSelect + Other -> revisão -> envio ----------
  try {
    const mark = transcriptLines().length
    await sendComposer(PROMPT_MULTI)
    await waitFor(
      'card multiSelect',
      async () =>
        (await toggles().count()) >= 3 &&
        (await toggles().first().isEnabled()) &&
        (await questionCard().innerText()).includes('(múltipla)'),
      180_000,
    )
    await page.waitForTimeout(1200)
    const st0 = await toggleStates()
    const hasOther = (await questionCard().getByTestId('question-other-input').count()) === 1
    await shot('a1-multi-card')
    check(
      '(a) card com checkboxes + Other',
      st0.length >= 3 && st0.every((s) => !s.checked) && hasOther,
      `opções=${st0.map((s) => s.label).join('|')} other=${hasOther}`,
    )
    const hint = await noTerminalHints()
    check('(a) sem mandar ao terminal', hint === '', hint)
    const picked = [st0[0].label, st0[1].label]
    await toggles().nth(0).click()
    await waitFor('1ª marcada', async () => (await toggleStates())[0]?.checked === true, 15_000)
    await page.waitForTimeout(600)
    await toggles().nth(1).click()
    await waitFor(
      '2ª marcada',
      async () => (await toggleStates()).filter((s) => s.checked).length === 2,
      15_000,
    )
    await page.waitForTimeout(600)
    await questionCard().getByTestId('question-other-input').fill(OTHER_TEXT)
    await questionCard().getByRole('button', { name: 'Marcar', exact: true }).click()
    await waitFor(
      'Other digitado',
      async () =>
        (await questionCard().getByTestId('question-other-typed').innerText()).includes(OTHER_TEXT),
      20_000,
    )
    await page.waitForTimeout(800)
    const st1 = await toggleStates()
    await shot('a2-marked')
    check(
      '(a) 2 marcadas + Other no card',
      st1.filter((s) => s.checked).length === 2,
      JSON.stringify(st1),
    )
    await questionCard().getByTestId('question-submit-multi').click()
    await waitFor('card de revisão', async () => (await reviewCard().count()) > 0, 20_000)
    await page.waitForTimeout(800)
    const summary = await reviewCard().innerText()
    await shot('a3-review')
    check(
      '(a) revisão no card cita as 3',
      [...picked, OTHER_TEXT].every((x) => norm(summary).includes(norm(x))),
      summary.replace(/\s+/g, ' ').slice(0, 240),
    )
    await reviewCard().getByRole('button', { name: 'Enviar respostas', exact: true }).click()
    await waitFor('answers no transcript', async () => askAnswersFrom(mark) != null, 30_000)
    await waitIdle('resposta do Claude ao multi')
    await page.waitForTimeout(1500)
    const answers = askAnswersFrom(mark)
    const reply = assistantTextFrom(mark)
    await shot('a4-answered')
    const ansText = JSON.stringify(answers)
    check(
      '(a) toolUseResult.answers tem as 3',
      [...picked, OTHER_TEXT].every((x) => norm(ansText).includes(norm(x))),
      ansText,
    )
    const lastReply = reply.split('\n').filter(Boolean).slice(-3).join(' / ')
    check(
      '(a) resposta do Claude cita as 3',
      [...picked, OTHER_TEXT].every((x) => norm(reply).includes(norm(x))),
      lastReply.slice(0, 240),
    )
  } catch (e) {
    log('[qm] (a) ERRO:', String((e as Error).stack ?? e))
    check('(a) completo', false, String(e))
    await shot('a-error')
    await waitIdle('recuperação após (a)', 60_000).catch(() => {})
  }

  // ---------- (b) single-select -> Conversar sobre isso ----------
  try {
    const mark = transcriptLines().length
    await sendComposer(PROMPT_SINGLE)
    await waitFor(
      'card single-select',
      async () =>
        (await questionCard().getByTestId('question-chat').count()) === 1 &&
        (await questionCard().getByTestId('question-chat').isEnabled()) &&
        !(await questionCard().innerText()).includes('(múltipla)') &&
        (await toggles().count()) >= 3,
      180_000,
    )
    await page.waitForTimeout(1200)
    await shot('b1-single-card')
    await questionCard().getByTestId('question-chat').click()
    await waitFor(
      'card some',
      async () => (await page.getByTestId('question-chat').count()) === 0,
      20_000,
    )
    await waitIdle('Claude depois do chat sentinel')
    await page.waitForTimeout(1500)
    const liveBtns = await page.locator('div.rounded-md button.w-full').count()
    const c = await composerTextarea().catch(() => null)
    await shot('b2-after-chat')
    check(
      '(b) card some e Composer livre',
      c != null && (await page.getByTestId('question-chat').count()) === 0,
      `botões de opção visíveis=${liveBtns}`,
    )
    const mark2 = transcriptLines().length
    await sendComposer(CHAT_MSG)
    await page.waitForTimeout(1500)
    const bodyNow = await page.locator('body').innerText()
    await shot('b3-message-sent')
    await waitIdle('resposta à mensagem livre')
    await page.waitForTimeout(1500)
    const userSent = entriesFrom(mark2).some(
      (e) => e.type === 'user' && JSON.stringify(e.message?.content ?? '').includes('abacaxi'),
    )
    const reply = assistantTextFrom(mark2)
    await shot('b4-reply')
    check(
      '(b) mensagem enviada normalmente',
      userSent && bodyNow.includes(CHAT_MSG) && !bodyNow.includes('Mudanças enviadas'),
      `transcript=${userSent} eco=${bodyNow.includes(CHAT_MSG)}`,
    )
    check('(b) Claude respondeu à mensagem', /abacaxi/i.test(reply), reply.slice(0, 160))
    log('[qm] (b) texto do Claude após o sentinel:', assistantTextFrom(mark).slice(0, 300))
  } catch (e) {
    log('[qm] (b) ERRO:', String((e as Error).stack ?? e))
    check('(b) completo', false, String(e))
    await shot('b-error')
    await waitIdle('recuperação após (b)', 60_000).catch(() => {})
  }

  // ---------- (c) /hooks -> card genérico -> Esc pelo card ----------
  try {
    await sendComposer('/hooks')
    await waitFor(
      'card genérico /hooks',
      async () => (await page.getByTestId('generic-menu').count()) > 0,
      20_000,
    )
    await page.waitForTimeout(1200)
    const txt = await page.getByTestId('generic-menu').last().innerText()
    const hint = await noTerminalHints()
    await shot('c1-hooks-card')
    check('(c) card genérico do /hooks', /hook/i.test(txt), txt.replace(/\s+/g, ' ').slice(0, 200))
    check('(c) sem "Ir pro Terminal"/banner', hint === '', hint)
    await page.getByTestId('generic-esc').last().click()
    await waitFor(
      'card /hooks fecha',
      async () => (await page.getByTestId('generic-menu').count()) === 0,
      15_000,
    )
    await page.waitForTimeout(1000)
    await shot('c2-hooks-closed')
    check('(c) Esc pelo card fechou', true)
    await waitIdle('idle após /hooks', 30_000)
  } catch (e) {
    log('[qm] (c) ERRO:', String((e as Error).stack ?? e))
    check('(c) completo', false, String(e))
    await shot('c-error')
    await captureTerminalAndEscape('c-error')
  }

  // ---------- (d) /permissions -> aba -> volta -> Esc ----------
  try {
    await sendComposer('/permissions')
    await waitFor(
      'card genérico /permissions',
      async () => (await page.getByTestId('generic-menu').count()) > 0,
      20_000,
    )
    await page.waitForTimeout(1200)
    const card = () => page.getByTestId('generic-menu').last()
    const t0 = await card().innerText()
    await shot('d1-permissions-card')
    check(
      '(d) card genérico do /permissions',
      /permission|allow|deny/i.test(t0),
      t0.replace(/\s+/g, ' ').slice(0, 200),
    )
    const hint = await noTerminalHints()
    check('(d) sem "Ir pro Terminal"/banner', hint === '', hint)
    const next = page.getByTestId('generic-tab-next')
    if ((await next.count()) && (await next.last().isEnabled())) {
      await next.last().click()
      await page.waitForTimeout(1500)
      const t1 = await card().innerText()
      await shot('d2-permissions-next-tab')
      check('(d) aba seguinte pelo card', t1 !== t0, t1.replace(/\s+/g, ' ').slice(0, 200))
      await page.getByTestId('generic-tab-prev').last().click()
      await page.waitForTimeout(1500)
      const t2 = await card().innerText()
      await shot('d3-permissions-back')
      check('(d) voltou à 1ª aba', t2 === t0, t2.replace(/\s+/g, ' ').slice(0, 200))
    } else {
      check('(d) botões de aba no card', false, 'generic-tab-next ausente/desabilitado')
    }
    await card().getByTestId('generic-esc').click()
    await waitFor(
      'card /permissions fecha',
      async () => (await page.getByTestId('generic-menu').count()) === 0,
      15_000,
    )
    await page.waitForTimeout(1000)
    await shot('d4-permissions-closed')
    await waitIdle('idle após /permissions', 30_000)
    const hashesAfter = settingsHashes()
    const changed = SETTINGS_FILES.filter((f) => hashesBefore[f] !== hashesAfter[f])
    check('(d) Esc fechou e nada alterado', changed.length === 0, changed.join(',') || 'settings iguais')
  } catch (e) {
    log('[qm] (d) ERRO:', String((e as Error).stack ?? e))
    check('(d) completo', false, String(e))
    await shot('d-error')
    await captureTerminalAndEscape('d-error')
  }
} catch (e) {
  log('[qm] ERRO:', String((e as Error).stack ?? e))
  check('cenário completo', false, String(e))
  await shot('error')
} finally {
  fallbackAfter = await attentionDebug().catch((e) => `erro: ${String(e)}`)
  log('[qm] attention-debug depois:', fallbackAfter)
  log('[qm] console errors:', consoleErrors.length, consoleErrors.slice(0, 20))
  check('zero console errors', consoleErrors.length === 0, String(consoleErrors.length))
  const hashesEnd = settingsHashes()
  const touched = SETTINGS_FILES.filter((f) => hashesBefore[f] !== hashesEnd[f])
  check('settings.json intactos no fim', touched.length === 0, touched.join(',') || 'iguais')
  log(
    '[qm] main tui/menu lines:',
    mainOutput()
      .split('\n')
      .filter((l) => /tui-menu|fallback|attention|unparsed/i.test(l))
      .slice(-25),
  )
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    /* já saiu */
  }
  const failed = results.filter((r) => !r.ok)
  log(
    `[verdict] ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`,
  )
  process.exitCode = failed.length === 0 ? 0 : 1
}
