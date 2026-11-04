// Valida, no app BUILDADO, o diálogo de plano (ExitPlanMode) respondido pelo Chat:
//  (a) PlanCard com um botão por opção real + destaque, sem mandar ao terminal;
//  (b) "Pedir mudanças" pelo campo do card -> Claude replaneja -> novo card;
//  (c) texto no Composer com o diálogo aberto vai como feedback (não aprova);
//  (d) "Aprovar com edições manuais" -> "Decisão enviada…" até o tool_result, modo manual.
// Sessão NOVA do claude (HOME real pra auth, haiku/low, plan) num repo-sandbox inserido
// só na cópia do userData. Uso:
//   PLAN_SB=<dir> npx tsx e2e/scenarios/validate-chat-plan-approval.ts
// Saídas: PLAN_SB/shots/*.png e PLAN_SB/scenario.log; termina com [verdict] PASS/FAIL.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
const SB = process.env.PLAN_SB ?? join(tmpdir(), `chat-plan-approval-${Date.now()}`)
const SANDBOX = join(SB, 'drive-sandbox')
const SHOTS = join(SB, 'shots')
const LOG = join(SB, 'scenario.log')
mkdirSync(SANDBOX, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
const REPO_ID = 'plan-approval-sandbox-repo'
const REPO_LABEL = 'plan-approval-sandbox'
const SESSION_NAME = 'plan-approval-e2e'
const PROMPT = "Planeje criar hello.txt com 'oi'. Só planeje e chame ExitPlanMode."
const CARD_FEEDBACK = "Mude o conteúdo do arquivo para 'olá mundo'."
const COMPOSER_FEEDBACK = 'Use o nome saudacao.txt em vez de hello.txt.'
const TERMINAL_RE =
  /use o terminal|responda (?:por lá|no terminal|.*ou no terminal)|abra o terminal/i

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

// ---------- 1ª subida: migrations na cópia; semeia o repo-sandbox ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
log('[plan] userData copy', userData, 'sandbox', SANDBOX)

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
// Em Wayland a janela do Electron lançado pelo Playwright não chega a ser mapeada
// (isVisible=false): clique espera "visible" e o screenshot estoura. XWayland mapeia.
const OZONE = process.env.PLAN_OZONE ?? 'x11'
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

// Cards de plano: título fixo do PlanCard. O pendente é o que tem botões habilitados.
const planTitles = () => page.getByText('Plano pronto — sua decisão', { exact: true })
const choiceButtons = () => page.locator('[data-testid^="plan-choice-"]')
async function pendingCardLive(): Promise<boolean> {
  const n = await choiceButtons().count()
  if (n === 0) return false
  return choiceButtons().first().isEnabled()
}
async function describeChoices() {
  return choiceButtons().evaluateAll((els) =>
    els.map((e) => ({
      id: e.getAttribute('data-testid'),
      text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
      title: e.getAttribute('title'),
      highlighted: e.getAttribute('data-highlighted') === 'true',
      disabled: (e as HTMLButtonElement).disabled,
    })),
  )
}
async function statusLabels(): Promise<string[]> {
  return page
    .locator('text=/^(Aprovado|Rejeitado|Aguardando decisão)$/')
    .allInnerTexts()
    .catch(() => [])
}
// Título markdown do último PlanCard (o texto do plano que o card exibe).
async function lastPlanHeading(): Promise<string> {
  return page.evaluate(() => {
    const titles = [...document.querySelectorAll('span')].filter(
      (e) => e.textContent?.trim() === 'Plano pronto — sua decisão',
    )
    let el: Element | null = titles.at(-1) ?? null
    while (el && !el.querySelector('h1, h2')) el = el.parentElement
    return el?.querySelector('h1, h2')?.textContent?.trim() ?? ''
  })
}
async function pillText(): Promise<string> {
  const pill = page.locator('[title*="Modo de permissão"]').first()
  if (!(await pill.count())) return '(pill não encontrado)'
  const t = (await pill.innerText().catch(() => '')).trim()
  return t || (await pill.getAttribute('aria-label')) || (await pill.getAttribute('title')) || ''
}
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
  log('[plan] trust respondido pelo card:', txt.replace(/\s+/g, ' ').slice(0, 160))
  return true
}

// Toasts com timestamp, para provar que nenhum "Modo alterado" saiu com o plano pendente.
// Como string: o tsx (esbuild keepNames) injetaria __name() nas funções aninhadas, e ele
// não existe no renderer.
const TOAST_PROBE = `(() => {
  if (window.__toasts) return
  const seen = new WeakSet()
  window.__toasts = []
  const scan = () => {
    for (const el of document.querySelectorAll('[data-testid="toast-card"]')) {
      if (seen.has(el)) continue
      seen.add(el)
      window.__toasts.push({ t: Date.now(), text: el.innerText.trim() })
    }
  }
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
  scan()
})()`
async function installToastProbe(): Promise<void> {
  await page.evaluate(TOAST_PROBE)
}
const toastsSeen = () =>
  page.evaluate(
    () => (window as unknown as { __toasts?: Array<{ t: number; text: string }> }).__toasts ?? [],
  )
const MODE_TOAST_RE = /Modo alterado/i

// O plano aprovado de fato é o toolUseResult.plan do ExitPlanMode no transcript da sessão.
function approvedPlanFromTranscript(): string | null {
  const dir = join(homedir(), '.claude', 'projects', SANDBOX.replace(/[^a-zA-Z0-9]/g, '-'))
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const f of files) {
    let plan: string | null = null
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('toolUseResult')) continue
      try {
        const p = (JSON.parse(line) as { toolUseResult?: { plan?: unknown } }).toolUseResult?.plan
        if (typeof p === 'string' && p.trim()) plan = p
      } catch {
        /* linha parcial */
      }
    }
    if (plan) return plan
  }
  return null
}
const normHeading = (s: string) => s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
const markdownHeading = (md: string) => /^#{1,2}\s+(.+)$/m.exec(md)?.[1] ?? ''

let promptAt = 0
let fallbackBefore: unknown = null
let fallbackAfter: unknown = null
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 20 && !(await skip.count()); i++) await page.waitForTimeout(500)
  if (await skip.count()) await skip.click().catch(() => {})
  log(
    '[plan] drive-safe:',
    mainOutput()
      .split('\n')
      .filter((l) => l.includes('drive-safe') || l.includes('[launch]')),
  )
  await installToastProbe()
  fallbackBefore = await attentionDebug()
  log('[plan] attention-debug antes:', fallbackBefore)

  // ---------- spawn pela UI: haiku / low / plano / chat ----------
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(REPO_LABEL)
  await search.press('Enter')
  await page.getByTestId('spawn-provider').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByPlaceholder('opcional').first().fill(SESSION_NAME)
  await page.getByRole('button', { name: 'Haiku', exact: true }).click()
  await page.getByRole('button', { name: 'Low', exact: true }).click()
  await page.getByRole('button', { name: 'Plano', exact: true }).click()
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await shot('01-spawn-dialog')
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()

  // Composer pronto (pós-trust) -> manda o prompt.
  let trusted = false
  await waitFor(
    'composer da sessão',
    async () => {
      if (!trusted) trusted = await answerTrustIfShown()
      const live = (await page.evaluate(() =>
        (
          window as unknown as {
            api: {
              sessions: {
                listLiveGlobal: () => Promise<
                  Array<{ name?: string; title?: string; status?: string; cwd?: string }>
                >
              }
            }
          }
        ).api.sessions.listLiveGlobal(),
      )) as Array<{ status?: string; cwd?: string | null; repo?: { id: string } | null }>
      const mine = live.find((s) => s.repo?.id === REPO_ID || s.cwd === SANDBOX)
      return mine?.status === 'idle' || mine?.status === 'waiting'
    },
    90_000,
  )
  await page.waitForTimeout(1500)
  await answerTrustIfShown()
  await shot('02-chat-ready')
  const composer = await composerTextarea()
  await composer.click()
  await composer.fill(PROMPT)
  await composer.press('Enter')
  promptAt = Date.now()
  log('[plan] prompt enviado; pill:', await pillText())
  log(
    '[plan] argv do claude spawnado:',
    execSync("pgrep -af 'claude .*--session-id' || true")
      .toString()
      .split('\n')
      .filter((l) => l.includes(userData)),
  )

  // ---------- (a) 1º card ----------
  await waitFor('1º PlanCard pendente', pendingCardLive, 180_000)
  const pendingSince = Date.now()
  await page.waitForTimeout(1200)
  const c1 = await describeChoices()
  log('[plan] escolhas do 1º card:', c1)
  const ids = c1.map((c) => c.id)
  const paneText = await page.locator('body').innerText()
  const hasFeedback = (await page.locator('[data-testid="plan-feedback"]').count()) > 0
  const highlighted = c1.filter((c) => c.highlighted)
  await shot('a-plan-card')
  check(
    '(a) botões por opção real',
    ids.includes('plan-choice-approve-manual') &&
      ids.includes('plan-choice-reject') &&
      c1.length >= 3,
    ids.join(','),
  )
  check(
    '(a) tem aprovação com auto mode',
    ids.some((i) => i === 'plan-choice-approve-auto' || i?.startsWith('plan-choice-approve-clear')),
    ids.join(','),
  )
  check('(a) campo "Pedir mudanças"', hasFeedback)
  check(
    '(a) marca de destaque em 1 opção',
    highlighted.length === 1 && /destaque no terminal/.test(highlighted[0].text),
    highlighted.map((h) => h.id).join(','),
  )
  const termHit = TERMINAL_RE.exec(paneText)
  check('(a) sem texto mandando ao terminal', !termHit, termHit?.[0] ?? '')

  // ---------- (b) pedir mudanças pelo card ----------
  const cardsBefore = await planTitles().count()
  await page.locator('[data-testid="plan-feedback"]').fill(CARD_FEEDBACK)
  await page.locator('[data-testid="plan-feedback-send"]').click()
  await page.waitForTimeout(400)
  await shot('b1-feedback-sent')
  await waitFor(
    '2º PlanCard pendente',
    async () => (await planTitles().count()) > cardsBefore && (await pendingCardLive()),
    180_000,
  )
  await page.waitForTimeout(1200)
  const st2 = await statusLabels()
  await shot('b2-second-card')
  check(
    '(b) replanejou com novo card',
    (await planTitles().count()) > cardsBefore,
    `cards=${await planTitles().count()} status=${st2.join('|')}`,
  )
  check('(b) 1º card ficou como rejeitado/feedback', st2.includes('Rejeitado'), st2.join('|'))

  // ---------- (c) texto no Composer vira feedback ----------
  const cardsBeforeC = await planTitles().count()
  const pillBeforeC = await pillText()
  const comp2 = await composerTextarea()
  await comp2.click()
  await comp2.fill(COMPOSER_FEEDBACK)
  await comp2.press('Enter')
  // O aviso só sai depois do sendThenClear (paste + tecla no PTY): espera, não amostra.
  const noticeC = await page
    .getByText('Mudanças enviadas ao plano.')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  await shot('c1-composer-feedback')
  await waitFor(
    '3º PlanCard pendente',
    async () => (await planTitles().count()) > cardsBeforeC && (await pendingCardLive()),
    180_000,
  )
  await page.waitForTimeout(1200)
  const st3 = await statusLabels()
  const pillAfterC = await pillText()
  await shot('c2-third-card')
  check('(c) aviso "Mudanças enviadas ao plano."', noticeC)
  check(
    '(c) composer não aprovou (novo card, nenhum Aprovado)',
    (await planTitles().count()) > cardsBeforeC && !st3.includes('Aprovado'),
    `status=${st3.join('|')}`,
  )
  check(
    '(c) continua em plan mode',
    /plan/i.test(pillAfterC),
    `pill antes=${pillBeforeC} depois=${pillAfterC}`,
  )

  // ---------- (d) aprovar com edições manuais ----------
  const headingPending = await lastPlanHeading()
  const approvedAt = Date.now()
  await page.locator('[data-testid="plan-choice-approve-manual"]').click()
  const modeToastsPending = (await toastsSeen()).filter(
    (x) => x.t >= pendingSince && x.t < approvedAt && MODE_TOAST_RE.test(x.text),
  )
  check(
    '(d) nenhum toast de modo com o plano pendente',
    modeToastsPending.length === 0,
    modeToastsPending.map((x) => x.text.replace(/\s+/g, ' ')).join(' | '),
  )
  // Pill em manual/Padrão em até 3s depois do clique (a aprovação pelo card).
  let pillMs = -1
  let pillLast = ''
  for (;;) {
    pillLast = await pillText()
    if (/padr|default/i.test(pillLast) && !/plan/i.test(pillLast)) {
      pillMs = Date.now() - approvedAt
      break
    }
    if (Date.now() - approvedAt > 3000) break
    await page.waitForTimeout(100)
  }
  check('(d) pill em Padrão em até 3s', pillMs >= 0, pillMs >= 0 ? `${pillMs}ms` : pillLast)
  const sentShown = (await page.getByText('Decisão enviada…').count()) > 0
  const btnsDisabled = await choiceButtons()
    .evaluateAll((els) => els.length > 0 && els.every((e) => (e as HTMLButtonElement).disabled))
    .catch(() => false)
  await shot('d1-decision-sent')
  check(
    '(d) "Decisão enviada…" logo após o clique',
    sentShown,
    `botões desabilitados=${btnsDisabled}`,
  )
  await waitFor(
    'tool_result do plano aprovado',
    async () => (await statusLabels()).includes('Aprovado'),
    60_000,
  )
  await page.waitForTimeout(2500)
  const pillD = await pillText()
  const stD = await statusLabels()
  await shot('d2-approved')
  check('(d) card aprovado sai dos botões', (await choiceButtons().count()) === 0, stD.join('|'))
  const headingApproved = await lastPlanHeading()
  check(
    '(d) card aprovado mostra o plano que estava pendente',
    headingApproved === headingPending,
    `pendente="${headingPending}" aprovado="${headingApproved}"`,
  )
  const approvedPlan = approvedPlanFromTranscript()
  const approvedHeading = approvedPlan ? markdownHeading(approvedPlan) : ''
  check(
    '(d) card aprovado mostra o toolUseResult.plan',
    !!approvedHeading && normHeading(headingApproved) === normHeading(approvedHeading),
    `card="${headingApproved}" toolUseResult.plan="${approvedHeading}"`,
  )
  check('(d) modo manual no pill', /padr|default/i.test(pillD) && !/plan/i.test(pillD), pillD)
  await page.waitForTimeout(4000)
  await shot('d3-after-approval')
  const noticeAfter = await page
    .getByText('Mudanças enviadas ao plano.')
    .filter({ visible: true })
    .count()
  check(
    '(d) aviso "Mudanças enviadas ao plano." sumiu',
    noticeAfter === 0,
    `visíveis=${noticeAfter}`,
  )
  const pillD3 = await pillText()
  check('(d) pill segue em Padrão', /padr|default/i.test(pillD3) && !/plan/i.test(pillD3), pillD3)
  const modeToastsAll = (await toastsSeen()).filter((x) => MODE_TOAST_RE.test(x.text))
  log('[plan] toasts de modo na sessão (ms desde o prompt):', {
    primeiroCard: pendingSince - promptAt,
    aprovacao: approvedAt - promptAt,
    toasts: modeToastsAll.map((x) => ({ t: x.t - promptAt, text: x.text })),
  })
} catch (e) {
  log('[plan] ERRO:', String((e as Error).stack ?? e))
  check('cenário completo', false, String(e))
  await shot('error')
} finally {
  fallbackAfter = await attentionDebug().catch((e) => `erro: ${String(e)}`)
  log('[plan] attention-debug depois:', fallbackAfter)
  log('[plan] console errors:', consoleErrors.length, consoleErrors.slice(0, 20))
  log(
    '[plan] main tui/plan lines:',
    mainOutput()
      .split('\n')
      .filter((l) => /tui-menu|plan|fallback|attention/i.test(l))
      .slice(-25),
  )
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    /* já saiu */
  }
  log(
    '[plan] hello/saudacao no sandbox:',
    existsSync(join(SANDBOX, 'hello.txt')),
    existsSync(join(SANDBOX, 'saudacao.txt')),
  )
  const failed = results.filter((r) => !r.ok)
  log(
    `[verdict] ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`,
  )
  process.exitCode = failed.length === 0 ? 0 : 1
}
