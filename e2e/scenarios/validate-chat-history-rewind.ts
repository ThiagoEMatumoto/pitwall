// Valida, no app BUILDADO, a busca de histórico (Ctrl+R) e o "Voltar a este ponto" pelo Chat:
//  (a) Ctrl+R pelo card: busca, cicla, aceita -> a caixa da CLI/o Claude recebe o texto como
//      o card promete (modal: só preenche; inline: envia); outra busca cancelada não muda nada;
//  (b) "Voltar a este ponto" numa mensagem do meio -> submenu como card -> Never mind -> nada muda;
//  (c) de novo -> Restore conversation -> o chat mostra a conversa até ali e a sessão segue;
//  (d) Restore code and conversation numa edição do sandbox -> o arquivo volta;
//  (e) plano pela pill -> aprovar pelo card -> pill/toast no modo certo, sem toast falso.
// Sessão NOVA do claude (HOME real pra auth e settings, haiku/low, modo Padrão) num repo git
// de brinquedo inserido só na cópia do userData. Uso:
//   RW_OUT=<dir> RW_SANDBOX=<dir> npx tsx e2e/scenarios/validate-chat-history-rewind.ts
// Saídas: RW_OUT/shots/*.png e RW_OUT/scenario.log; termina com [verdict] PASS/FAIL.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
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
const OUT = process.env.RW_OUT ?? join(tmpdir(), `chat-history-rewind-${Date.now()}`)
const SANDBOX = process.env.RW_SANDBOX ?? join(OUT, 'drive-sandbox')
const SHOTS = join(OUT, 'shots')
const LOG = join(OUT, 'scenario.log')
mkdirSync(SANDBOX, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
const REPO_ID = 'history-rewind-sandbox-repo'
const REPO_LABEL = 'history-rewind-sandbox'
const SESSION_NAME = 'history-rewind-e2e'
const P = [
  'Responda só: ok um zebra-alfa.',
  'Crie o arquivo notas.txt contendo só a linha: um. Não faça mais nada.',
  'Responda só: ok tres zebra-beta.',
  "Acrescente a linha 'quatro' ao final de notas.txt. Não faça mais nada.",
  'Responda só: ok cinco zebra-gama.',
]
const P_AFTER_RESTORE = 'Responda só: ok seis.'
const P_EDIT_SETE = "Acrescente a linha 'sete' ao final de notas.txt. Não faça mais nada."
const P_AFTER_CODE = 'Responda só: ok oito.'
const PROMPT_PLAN = "Planeje criar plano.txt com a linha 'oi'. Só planeje e chame ExitPlanMode."
const QUERY = 'zebra-'
const SETTINGS_FILES = [
  join(homedir(), '.claude', 'settings.json'),
  join(homedir(), '.claude', 'settings.local.json'),
  join(SANDBOX, '.claude', 'settings.json'),
  join(SANDBOX, '.claude', 'settings.local.json'),
]
const MODE_TOAST_RE = /Modo alterado/i

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
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 }).trim()
const readSandbox = (f: string) =>
  existsSync(join(SANDBOX, f)) ? readFileSync(join(SANDBOX, f), 'utf8') : null

// Repo de brinquedo: o único lugar onde a sessão edita e o rewind restaura código.
if (!existsSync(join(SANDBOX, '.git'))) {
  git(SANDBOX, 'init', '-q')
  writeFileSync(join(SANDBOX, 'README.md'), '# sandbox do validate-chat-history-rewind\n')
  git(SANDBOX, 'add', '.')
  git(SANDBOX, '-c', 'user.name=e2e', '-c', 'user.email=e2e@local', 'commit', '-qm', 'init')
}

// ---------- 1ª subida: migrations na cópia; semeia o repo-sandbox ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
log('[rw] userData copy', userData, 'sandbox', SANDBOX)

const projects = await queryDb<{ id: string }>(
  userData,
  'SELECT id FROM projects ORDER BY position LIMIT 1',
)
if (!projects[0]) throw new Error('a cópia não tem projeto para pendurar o repo-sandbox')
// Repos reais registrados: estado git antes/depois, para provar que nenhum mudou.
const realRepos = (await queryDb<{ path: string }>(userData, 'SELECT path FROM repos'))
  .map((r) => r.path)
  .filter((p) => p && p !== SANDBOX && existsSync(join(p, '.git')))
function repoStates(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of realRepos) {
    try {
      out[p] = createHash('sha256')
        .update(git(p, 'rev-parse', 'HEAD') + '\n' + git(p, 'status', '--porcelain'))
        .digest('hex')
    } catch (e) {
      out[p] = `erro: ${String(e).slice(0, 80)}`
    }
  }
  return out
}
const reposBefore = repoStates()
log('[rw] repos reais monitorados:', realRepos.length)

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
const OZONE = process.env.RW_OZONE ?? 'x11'
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
type AttentionDebug = {
  attentionReasonUnparsed?: number
  chatFallbacks?: Record<string, number>
}
const attentionDebug = () =>
  page.evaluate(() =>
    (
      window as unknown as { api: { sessions: { attentionDebug: () => Promise<unknown> } } }
    ).api.sessions.attentionDebug(),
  ) as Promise<AttentionDebug>
const fallbackSum = (d: AttentionDebug | null) =>
  Object.values(d?.chatFallbacks ?? {}).reduce((a, b) => a + b, 0)
type Live = { id: string; status?: string; cwd?: string | null; repo?: { id: string } | null }
async function liveSession(): Promise<Live | undefined> {
  const live = (await page.evaluate(() =>
    (
      window as unknown as { api: { sessions: { listLiveGlobal: () => Promise<unknown[]> } } }
    ).api.sessions.listLiveGlobal(),
  )) as Live[]
  return live.find((s) => s.repo?.id === REPO_ID || s.cwd === SANDBOX)
}
const sessionStatus = async () => (await liveSession())?.status

// Banner de "tela não reconhecida" pisca entre screenshots: o contador só o vê depois.
// Fotografa cada aparição e despeja o que a CLI desenhava naquele instante.
const BANNERS = '[data-testid="chat-wait-unrecognized"], [data-testid="chat-wait-open-terminal"]'
let bannerSeen = 0
let bannerOn = false
let bannerBusy = false
let bannerTimer: ReturnType<typeof setInterval> | null = null
function watchBanners(): void {
  bannerTimer = setInterval(async () => {
    if (bannerBusy) return
    bannerBusy = true
    try {
      const on = (await page.locator(BANNERS).count()) > 0
      if (on && !bannerOn) {
        bannerSeen++
        const id = (await liveSession())?.id
        const preview = id
          ? await page.evaluate(
              (sid) =>
                (
                  window as unknown as {
                    api: { sendTo: { preview: (id: string) => Promise<unknown> } }
                  }
                ).api.sendTo.preview(sid),
              id,
            )
          : null
        log(`[banner] #${bannerSeen} @${new Date().toISOString()} status=${await sessionStatus()}`)
        log('[banner] tela da CLI:', preview)
        await shot(`banner-${bannerSeen}`)
      }
      bannerOn = on
    } catch {
      /* página fechando */
    } finally {
      bannerBusy = false
    }
  }, 300)
}
const logCounters = async (at: string) =>
  log(`[rw] contadores ${at} @${new Date().toISOString()}:`, await attentionDebug())

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
  log('[rw] trust respondido pelo card:', txt.replace(/\s+/g, ' ').slice(0, 160))
  return true
}
// Espera o Claude parar aprovando UMA vez (nunca "sempre") cada permissão de edição.
let approvals = 0
async function waitIdleApproving(label: string, ms = 180_000): Promise<void> {
  await waitFor(
    label,
    async () => {
      const approve = page.locator('[data-testid="permission-approve"]:enabled')
      if (await approve.count()) {
        const txt = await page
          .locator('[data-testid="permission-card"]')
          .last()
          .innerText()
          .catch(() => '')
        await shot(`perm-${++approvals}`)
        await approve.last().click()
        log(
          `[rw] permissão #${approvals} aprovada pelo card:`,
          txt.replace(/\s+/g, ' ').slice(0, 160),
        )
        await page.waitForTimeout(1500)
        return false
      }
      return (await sessionStatus()) === 'idle'
    },
    ms,
  )
}
async function sendAndWait(text: string, label: string): Promise<void> {
  const mark = userEntries().length
  await sendComposer(text)
  await waitFor(`${label}: prompt no transcript`, async () => userEntries().length > mark, 60_000)
  await waitIdleApproving(label)
  await page.waitForTimeout(1200)
}

// Transcript da própria sessão (--session-id do argv). O /rewind não troca de arquivo: o
// ramo novo entra no mesmo JSONL com outro parentUuid.
let claudeSessionId: string | undefined
function transcriptEntries(): Array<Record<string, unknown>> {
  if (!claudeSessionId) return []
  const f = join(
    homedir(),
    '.claude',
    'projects',
    SANDBOX.replace(/[^a-zA-Z0-9]/g, '-'),
    `${claudeSessionId}.jsonl`,
  )
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}
// Prompts digitados (user com texto, sem tool_result e sem meta).
function userEntries(): string[] {
  return transcriptEntries().flatMap((e) => {
    if (e.type !== 'user' || e.isMeta) return []
    const c = (e.message as { content?: unknown } | undefined)?.content
    if (typeof c === 'string') return [c]
    if (Array.isArray(c)) {
      const t = c
        .filter((b: { type?: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('')
      return t ? [t] : []
    }
    return []
  })
}

// Bolhas do usuário no chat, na ordem em que aparecem.
const userBubbles = () =>
  page
    .locator('div.group.flex-col.items-end')
    .evaluateAll((els) =>
      els.map((e) => ((e.firstElementChild as HTMLElement | null)?.innerText ?? '').trim()),
    )
const bubbleWith = (text: string) =>
  page.locator('div.group.flex-col.items-end').filter({ hasText: text }).last()
const genericCard = () => page.getByTestId('generic-menu').last()
const cliDraft = () => page.getByTestId('cli-draft')
async function cliDraftText(): Promise<string | null> {
  if (!(await cliDraft().count())) return null
  return (await cliDraft().locator('span.font-mono').innerText()).trim()
}
async function optionsOf(card: Locator) {
  return card.locator('[data-testid^="generic-option-"]').evaluateAll((els) =>
    els.map((e) => ({
      id: e.getAttribute('data-testid') ?? '',
      label: ((e.querySelector('span.font-medium') as HTMLElement | null)?.innerText ?? '').trim(),
      enabled: !(e as HTMLButtonElement).disabled,
    })),
  )
}
// Clica a opção pelo rótulo, rolando o card ("Mostrar mais") quando ela está fora da janela.
async function pickGeneric(label: RegExp): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const opts = await optionsOf(genericCard())
    const hit = opts.find((o) => label.test(o.label))
    if (hit) {
      if (!hit.enabled) throw new Error(`opção ${hit.label} desabilitada`)
      await genericCard().getByTestId(hit.id).click()
      return hit.label
    }
    const down = genericCard().getByTestId('generic-scroll-down')
    if (!(await down.count())) break
    const before = JSON.stringify(opts)
    await down.click()
    await waitFor(
      'card rolou',
      async () => JSON.stringify(await optionsOf(genericCard())) !== before,
      8_000,
    )
    await page.waitForTimeout(500)
  }
  throw new Error(
    `opção ${label} não encontrada: ${JSON.stringify(await optionsOf(genericCard()))}`,
  )
}
async function openRewindAt(text: string, name: string): Promise<string> {
  const btn = bubbleWith(text).getByTestId('rewind-here')
  await bubbleWith(text).hover()
  await waitFor('Voltar a este ponto habilitado', async () => btn.isEnabled(), 30_000)
  await btn.click()
  await waitFor(
    'submenu do rewind no card',
    async () =>
      (await page.getByTestId('generic-menu').count()) > 0 &&
      /Confirm you want to restore/i.test(await genericCard().innerText()),
    20_000,
  )
  await page.waitForTimeout(1000)
  const txt = await genericCard().innerText()
  await shot(name)
  const notice = (await page.getByTestId('rewind-notice').count())
    ? await page.getByTestId('rewind-notice').innerText()
    : ''
  log('[rw] submenu:', txt.replace(/\s+/g, ' ').slice(0, 400), notice ? `aviso=${notice}` : '')
  return txt
}

// Toasts com timestamp, para provar que nenhum "Modo alterado" saiu errado.
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
const toastsSeen = () =>
  page.evaluate(
    () => (window as unknown as { __toasts?: Array<{ t: number; text: string }> }).__toasts ?? [],
  )
async function pillText(): Promise<string> {
  const pill = page.locator('[title*="Modo de permissão"]').first()
  if (!(await pill.count())) return '(pill não encontrado)'
  const t = (await pill.innerText().catch(() => '')).trim()
  return t || (await pill.getAttribute('aria-label')) || (await pill.getAttribute('title')) || ''
}

let fallbackBefore: AttentionDebug | null = null
let fallbackAfter: AttentionDebug | null = null
const hashesBefore = settingsHashes()
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 20 && !(await skip.count()); i++) await page.waitForTimeout(500)
  if (await skip.count()) await skip.click().catch(() => {})
  log(
    '[rw] drive-safe:',
    mainOutput()
      .split('\n')
      .filter((l) => l.includes('drive-safe') || l.includes('[launch]')),
  )
  fallbackBefore = await attentionDebug()
  log('[rw] attention-debug antes:', fallbackBefore)

  // ---------- spawn pela UI: haiku / low / Padrão / chat ----------
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
  await page.evaluate(TOAST_PROBE)
  await shot('02-chat-ready')
  watchBanners()
  const argv = execSync("pgrep -af 'claude .*--session-id' || true")
    .toString()
    .split('\n')
    .filter((l) => l.includes(userData))
  log('[rw] argv do claude spawnado:', argv)
  claudeSessionId = argv[0]?.match(/--session-id (\S+)/)?.[1]
  check(
    'spawn em modo Padrão',
    argv.length === 1 && !/--permission-mode (?!default)/.test(argv[0]),
    argv[0]?.match(/--permission-mode \S+/)?.[0] ?? 'sem --permission-mode',
  )

  // ---------- conversa base: 5 mensagens, 2 com edição no sandbox ----------
  for (const [i, p] of P.entries()) await sendAndWait(p, `msg ${i + 1}`)
  await shot('03-conversation')
  check(
    'conversa base no chat',
    P.every((p) => userEntries().includes(p)),
    `bolhas=${(await userBubbles()).length}`,
  )
  check(
    'notas.txt após as edições',
    readSandbox('notas.txt') === 'um\nquatro\n',
    JSON.stringify(readSandbox('notas.txt')),
  )

  // ---------- (a) Ctrl+R: buscar, ciclar, aceitar ----------
  try {
    await logCounters('antes de (a)')
    const c = await composerTextarea()
    await c.click()
    await page.keyboard.press('Control+r')
    await waitFor(
      'card do Ctrl+R',
      async () => (await page.getByTestId('history-search').count()) > 0,
      15_000,
    )
    const mode = await page.getByTestId('history-search').getAttribute('data-mode')
    await page.getByTestId('history-query').fill(QUERY)
    const currentResult = () =>
      page
        .locator('[data-testid^="history-result-"]')
        .evaluateAll(
          (els) =>
            els
              .filter((e) => e.className.includes('color-accent)]/10'))
              .map((e) =>
                ((e.querySelector('span.font-mono') as HTMLElement | null)?.innerText ?? '').trim(),
              )[0] ?? null,
        )
    const inlineMatch = async () => {
      const t = await page
        .getByTestId('history-match')
        .innerText()
        .catch(() => '')
      return /^Encontrado:\s*/.test(t) ? t.replace(/^Encontrado:\s*/, '').trim() : null
    }
    const current = () => (mode === 'modal' ? currentResult() : inlineMatch())
    await waitFor(
      'resultado da busca',
      async () => ((await current()) ?? '').includes(QUERY),
      15_000,
    )
    await page.waitForTimeout(800)
    const first = await current()
    const allResults =
      mode === 'modal'
        ? await page.locator('[data-testid^="history-result-"] span.font-mono').allInnerTexts()
        : [first]
    const effect = await page.getByTestId('history-effect').innerText()
    const acceptLabel = await page.getByTestId('history-accept').innerText()
    await shot('a1-history-query')
    log('[rw] (a) modo=', mode, 'resultados=', allResults, 'efeito=', effect)
    check(
      '(a) card do Ctrl+R com resultados da busca',
      // O filtro do modal é fuzzy (subsequência): no escopo "todos os projetos" entram
      // prompts de outros projetos sem "zebra-" contíguo. Basta os nossos estarem lá.
      P.filter((p) => p.includes(QUERY)).every((p) => allResults.includes(p)) &&
        (first ?? '').includes(QUERY),
      `modo=${mode} atual="${first}" n=${allResults.length}`,
    )
    await page.getByTestId(mode === 'modal' ? 'history-up' : 'history-older').click()
    await waitFor(
      'ciclou para outro resultado',
      async () => {
        const now = await current()
        return now != null && now !== first && now.includes(QUERY)
      },
      10_000,
    )
    await page.waitForTimeout(800)
    const chosen = (await current())!
    await shot('a2-history-cycled')
    check('(a) ciclar mudou o resultado', chosen !== first, `"${first}" -> "${chosen}"`)
    const mark = userEntries().length
    await page.getByTestId('history-accept').click()
    await waitFor(
      'card do Ctrl+R fecha',
      async () => (await page.getByTestId('history-search').count()) === 0,
      10_000,
    )
    if (mode === 'modal') {
      check(
        '(a) card promete só preencher',
        /Usar este prompt/.test(acceptLabel) && /nada é enviado/.test(effect),
        acceptLabel,
      )
      await waitFor(
        'aviso da caixa do terminal',
        async () => (await cliDraftText()) != null,
        10_000,
      )
      await page.waitForTimeout(3000)
      const draft = await cliDraftText()
      await shot('a3-history-filled')
      check('(a) caixa do terminal recebeu o texto escolhido', draft === chosen, `draft="${draft}"`)
      check(
        '(a) nada foi enviado ao Claude',
        userEntries().length === mark,
        `prompts ${mark}->${userEntries().length}`,
      )
      await cliDraft().getByTestId('cli-draft-send').click()
      await waitFor(
        'prompt do Ctrl+R no transcript',
        async () => userEntries().length > mark,
        30_000,
      )
      await waitIdleApproving('resposta ao prompt do Ctrl+R')
      await page.waitForTimeout(1200)
    } else {
      check('(a) card promete enviar', /Enviar este prompt/.test(acceptLabel), acceptLabel)
      await waitFor(
        'prompt do Ctrl+R no transcript',
        async () => userEntries().length > mark,
        30_000,
      )
      await waitIdleApproving('resposta ao prompt do Ctrl+R')
      await page.waitForTimeout(1200)
    }
    const sent = userEntries().slice(mark)
    await shot('a4-history-sent')
    check(
      '(a) o Claude recebeu exatamente o prompt escolhido',
      sent.length === 1 && sent[0] === chosen,
      JSON.stringify(sent),
    )
    check('(a) caixa do terminal vazia depois', (await cliDraftText()) == null)

    // Cancelar outra busca: nada muda.
    const mark2 = userEntries().length
    const bubbles2 = await userBubbles()
    const c2 = await composerTextarea()
    await c2.click()
    await page.keyboard.press('Control+r')
    await waitFor(
      '2º card do Ctrl+R',
      async () => (await page.getByTestId('history-search').count()) > 0,
      15_000,
    )
    await page.getByTestId('history-query').fill(QUERY)
    await waitFor(
      'resultado da 2ª busca',
      async () => ((await current()) ?? '').includes(QUERY),
      15_000,
    )
    await page.waitForTimeout(600)
    await shot('a5-history-before-cancel')
    await page.getByTestId('history-cancel').click()
    await waitFor(
      '2º card fecha',
      async () => (await page.getByTestId('history-search').count()) === 0,
      10_000,
    )
    await page.waitForTimeout(3000)
    await shot('a6-history-cancelled')
    check(
      '(a) cancelar não mudou nada',
      userEntries().length === mark2 &&
        (await cliDraftText()) == null &&
        JSON.stringify(await userBubbles()) === JSON.stringify(bubbles2) &&
        (await sessionStatus()) === 'idle',
      `prompts ${mark2}->${userEntries().length} draft=${await cliDraftText()}`,
    )
  } catch (e) {
    log('[rw] (a) ERRO:', String((e as Error).stack ?? e))
    check('(a) completo', false, String(e))
    await shot('a-error')
    if (await page.getByTestId('history-cancel').count())
      await page
        .getByTestId('history-cancel')
        .click()
        .catch(() => {})
    await waitIdleApproving('recuperação após (a)', 60_000).catch(() => {})
  }

  // ---------- (b) Voltar a este ponto -> Never mind ----------
  const target = P[3]
  try {
    await logCounters('antes de (b)')
    const bubblesB = await userBubbles()
    const markB = transcriptEntries().length
    const sub = await openRewindAt(target, 'b1-rewind-submenu')
    check(
      '(b) submenu do rewind como card, na mensagem certa',
      sub.includes(target),
      sub.replace(/\s+/g, ' ').slice(0, 160),
    )
    const picked = await pickGeneric(/^Never mind$/)
    await shot('b2-after-never-mind')
    // Never mind volta ao seletor do /rewind; Esc pelo card fecha.
    await waitFor(
      'seletor ou nada depois do Never mind',
      async () =>
        (await page.getByTestId('generic-menu').count()) === 0 ||
        !/Confirm you want to restore/i.test(await genericCard().innerText()),
      10_000,
    )
    await page.waitForTimeout(800)
    if (await page.getByTestId('generic-menu').count()) {
      log(
        '[rw] (b) depois do Never mind:',
        (await genericCard().innerText()).replace(/\s+/g, ' ').slice(0, 200),
      )
      await genericCard().getByTestId('generic-esc').click()
    }
    await waitFor(
      'card do rewind fecha',
      async () => (await page.getByTestId('generic-menu').count()) === 0,
      10_000,
    )
    await page.waitForTimeout(2500)
    await shot('b3-never-mind-closed')
    check(
      '(b) Never mind não mudou nada',
      picked === 'Never mind' &&
        JSON.stringify(await userBubbles()) === JSON.stringify(bubblesB) &&
        transcriptEntries().length === markB &&
        (await cliDraftText()) == null &&
        readSandbox('notas.txt') === 'um\nquatro\n' &&
        (await sessionStatus()) === 'idle',
      `bolhas=${(await userBubbles()).length}/${bubblesB.length} jsonl ${markB}->${transcriptEntries().length} draft=${await cliDraftText()}`,
    )
  } catch (e) {
    log('[rw] (b) ERRO:', String((e as Error).stack ?? e))
    check('(b) completo', false, String(e))
    await shot('b-error')
    if (await page.getByTestId('generic-esc').count())
      await page
        .getByTestId('generic-esc')
        .last()
        .click()
        .catch(() => {})
  }

  // ---------- (c) de novo -> Restore conversation ----------
  try {
    await logCounters('antes de (c)')
    const bubblesC = await userBubbles()
    const idx = bubblesC.findIndex((b) => b === target)
    const sub = await openRewindAt(target, 'c1-rewind-submenu')
    const opts = await optionsOf(genericCard())
    log(
      '[rw] (c) opções:',
      opts.map((o) => o.label),
    )
    check(
      '(c) submenu oferece Restore conversation',
      opts.some((o) => o.label === 'Restore conversation'),
      sub.slice(0, 80),
    )
    await pickGeneric(/^Restore conversation$/)
    await waitFor(
      'card fecha após restore',
      async () => (await page.getByTestId('generic-menu').count()) === 0,
      15_000,
    )
    await waitFor(
      'mensagem restaurada na caixa do terminal',
      async () => (await cliDraftText()) != null,
      15_000,
    )
    await page.waitForTimeout(1500)
    const notice = (await page.getByTestId('rewind-notice').count())
      ? await page.getByTestId('rewind-notice').innerText()
      : ''
    await shot('c2-after-restore')
    check(
      '(c) caixa do terminal tem a mensagem desfeita',
      (await cliDraftText()) === target,
      `draft="${await cliDraftText()}"`,
    )
    check('(c) aviso explica o restore', /conversa voltou/i.test(notice), notice.slice(0, 120))
    check(
      '(c) restore só da conversa não mexeu no arquivo',
      readSandbox('notas.txt') === 'um\nquatro\n',
      JSON.stringify(readSandbox('notas.txt')),
    )
    const blocked = await bubbleWith(P[1]).getByTestId('rewind-here').isDisabled()
    check('(c) novo rewind bloqueado até a próxima mensagem', blocked)
    await cliDraft().getByTestId('cli-draft-clear').click()
    await waitFor('caixa do terminal limpa', async () => (await cliDraftText()) == null, 10_000)
    await sendAndWait(P_AFTER_RESTORE, 'mensagem depois do restore')
    const after = await userBubbles()
    await shot('c3-conversation-after-restore')
    const expected = [...bubblesC.slice(0, idx), P_AFTER_RESTORE]
    check(
      '(c) chat mostra a conversa até aquele ponto + a nova',
      JSON.stringify(after) === JSON.stringify(expected),
      JSON.stringify(after),
    )
    const reply = await page.locator('body').innerText()
    check('(c) sessão continua respondendo', /ok seis/i.test(reply))
  } catch (e) {
    log('[rw] (c) ERRO:', String((e as Error).stack ?? e))
    check('(c) completo', false, String(e))
    await shot('c-error')
    if (await page.getByTestId('generic-esc').count())
      await page
        .getByTestId('generic-esc')
        .last()
        .click()
        .catch(() => {})
  }

  // ---------- (d) Restore code and conversation, só no sandbox ----------
  try {
    await logCounters('antes de (d)')
    await sendAndWait(P_EDIT_SETE, 'edição sete')
    const before = readSandbox('notas.txt')
    check('(d) edição sete aplicada', before === 'um\nquatro\nsete\n', JSON.stringify(before))
    const bubblesD = await userBubbles()
    const sub = await openRewindAt(P_EDIT_SETE, 'd1-rewind-code-submenu')
    const opts = await optionsOf(genericCard())
    log(
      '[rw] (d) opções:',
      opts.map((o) => o.label),
    )
    const hasCode = opts.some((o) => o.label === 'Restore code and conversation')
    check(
      '(d) submenu oferece restaurar código',
      hasCode && /notas\.txt/.test(sub),
      sub.replace(/\s+/g, ' ').slice(0, 200),
    )
    if (hasCode) {
      check(
        '(d) cwd da sessão é o sandbox',
        (await liveSession())?.cwd === SANDBOX,
        String((await liveSession())?.cwd),
      )
      await pickGeneric(/^Restore code and conversation$/)
      await waitFor(
        'card fecha após restore de código',
        async () => (await page.getByTestId('generic-menu').count()) === 0,
        15_000,
      )
      await waitFor(
        'mensagem restaurada na caixa',
        async () => (await cliDraftText()) != null,
        15_000,
      )
      await page.waitForTimeout(1500)
      await shot('d2-after-code-restore')
      check(
        '(d) notas.txt voltou para antes da edição',
        readSandbox('notas.txt') === 'um\nquatro\n',
        JSON.stringify(readSandbox('notas.txt')),
      )
      check(
        '(d) caixa do terminal tem a mensagem desfeita',
        (await cliDraftText()) === P_EDIT_SETE,
        `draft="${await cliDraftText()}"`,
      )
      await cliDraft().getByTestId('cli-draft-clear').click()
      await waitFor('caixa limpa (d)', async () => (await cliDraftText()) == null, 10_000)
      await sendAndWait(P_AFTER_CODE, 'mensagem depois do restore de código')
      const after = await userBubbles()
      await shot('d3-after-code-restore-next')
      check(
        '(d) chat sem a mensagem desfeita',
        JSON.stringify(after) === JSON.stringify([...bubblesD.slice(0, -1), P_AFTER_CODE]),
        JSON.stringify(after),
      )
    }
  } catch (e) {
    log('[rw] (d) ERRO:', String((e as Error).stack ?? e))
    check('(d) completo', false, String(e))
    await shot('d-error')
    if (await page.getByTestId('generic-esc').count())
      await page
        .getByTestId('generic-esc')
        .last()
        .click()
        .catch(() => {})
  }

  // ---------- (e) plano pela pill -> aprovar -> pill/toast ----------
  try {
    await logCounters('antes de (e)')
    const pill0 = await pillText()
    const t0 = Date.now()
    await page.locator('[title*="Modo de permissão"]').first().click()
    await page.locator('button:has(> span:text-is("Plano"))').last().click()
    await waitFor('pill em Plano', async () => /plano|plan/i.test(await pillText()), 15_000)
    await page.waitForTimeout(1500)
    await shot('e1-pill-plan')
    const tPlan = Date.now()
    log('[rw] (e) pill', pill0, '->', await pillText())
    await sendComposer(PROMPT_PLAN)
    const choice = page.locator('[data-testid="plan-choice-approve-manual"]')
    await waitFor(
      'PlanCard pendente',
      async () => (await choice.count()) > 0 && (await choice.last().isEnabled()),
      180_000,
    )
    const pendingSince = Date.now()
    await page.waitForTimeout(1200)
    await shot('e2-plan-card')
    const approvedAt = Date.now()
    await choice.last().click()
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
    check(
      '(e) pill em Padrão em até 3s após aprovar',
      pillMs >= 0,
      pillMs >= 0 ? `${pillMs}ms` : pillLast,
    )
    await waitIdleApproving('execução do plano aprovado')
    await page.waitForTimeout(4000)
    await shot('e3-plan-executed')
    const pillEnd = await pillText()
    check(
      '(e) pill segue em Padrão',
      /padr|default/i.test(pillEnd) && !/plan/i.test(pillEnd),
      pillEnd,
    )
    check(
      '(e) plano executado no sandbox',
      /oi/.test(readSandbox('plano.txt') ?? ''),
      JSON.stringify(readSandbox('plano.txt')),
    )
    const toasts = (await toastsSeen()).filter((x) => MODE_TOAST_RE.test(x.text))
    log(
      '[rw] (e) toasts de modo (ms desde a pill):',
      toasts.map((x) => ({ t: x.t - t0, text: x.text })),
    )
    const pending = toasts.filter((x) => x.t >= pendingSince && x.t < approvedAt)
    check(
      '(e) nenhum toast de modo com o plano pendente',
      pending.length === 0,
      pending.map((x) => x.text).join(' | '),
    )
    const afterApproval = toasts.filter((x) => x.t >= approvedAt)
    check(
      '(e) toasts depois da aprovação só dizem Padrão',
      afterApproval.every((x) => /Padrão/.test(x.text)),
      afterApproval.map((x) => x.text).join(' | ') || 'nenhum',
    )
    const beforeChat = toasts.filter((x) => x.t < tPlan)
    check(
      '(e) troca pela pill terminou num toast de Plano',
      beforeChat.length === 0 || /Plano/.test(beforeChat[beforeChat.length - 1].text),
      beforeChat.map((x) => x.text).join(' | ') || 'nenhum',
    )
  } catch (e) {
    log('[rw] (e) ERRO:', String((e as Error).stack ?? e))
    check('(e) completo', false, String(e))
    await shot('e-error')
  }
} catch (e) {
  log('[rw] ERRO:', String((e as Error).stack ?? e))
  check('cenário completo', false, String(e))
  await shot('error')
} finally {
  if (bannerTimer) clearInterval(bannerTimer)
  log('[rw] banners de terminal vistos:', bannerSeen)
  check('nenhum banner de terminal', bannerSeen === 0, String(bannerSeen))
  fallbackAfter = await attentionDebug().catch(() => null)
  log('[rw] attention-debug depois:', fallbackAfter)
  check(
    'chatFallbacks sem incremento',
    fallbackAfter != null && fallbackSum(fallbackAfter) === fallbackSum(fallbackBefore),
    `${fallbackSum(fallbackBefore)} -> ${fallbackSum(fallbackAfter)}`,
  )
  check(
    'attentionReasonUnparsed sem incremento',
    fallbackAfter != null &&
      (fallbackAfter.attentionReasonUnparsed ?? 0) ===
        (fallbackBefore?.attentionReasonUnparsed ?? 0),
    `${fallbackBefore?.attentionReasonUnparsed} -> ${fallbackAfter?.attentionReasonUnparsed}`,
  )
  log('[rw] console errors:', consoleErrors.length, consoleErrors.slice(0, 20))
  check('zero console errors', consoleErrors.length === 0, String(consoleErrors.length))
  log('[rw] permissões aprovadas:', approvals)
  log(
    '[rw] main tui/menu lines:',
    mainOutput()
      .split('\n')
      .filter((l) => /tui-menu|fallback|attention|unparsed|rewind/i.test(l))
      .slice(-25),
  )
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    /* já saiu */
  }
  const hashesEnd = settingsHashes()
  const touched = SETTINGS_FILES.filter((f) => hashesBefore[f] !== hashesEnd[f])
  check('settings.json intactos no fim', touched.length === 0, touched.join(',') || 'iguais')
  const reposAfter = repoStates()
  const changed = realRepos.filter((p) => reposBefore[p] !== reposAfter[p])
  check(
    'nenhum repo real mudou',
    changed.length === 0,
    changed.join(',') || `${realRepos.length} iguais`,
  )
  log('[rw] sandbox git status:', git(SANDBOX, 'status', '--porcelain'))
  const failed = results.filter((r) => !r.ok)
  log(
    `[verdict] ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`,
  )
  process.exitCode = failed.length === 0 ? 0 : 1
}
