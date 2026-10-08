// F3 — pedidos tipados de ponta a ponta no app buildado (HOME fake + stub do
// claude, cópia do perfil com CM_DRIVE_SAFE=1):
//   A) mãe despacha a filha por session_handoff (MCP); a filha faz 2 handoff_ask
//      estruturados → 2 linhas em handoff_requests, handoff needs_input
//   B) mãe responde o 1º por handoff_answer → needs_input mantido; <pitwall-answer>
//      no stdin da filha
//   C) filha pede deploy (risk deploy_infra_spend) → mãe não consegue responder
//      (human_only) → handoff_escalate → escalated_by = mãe
//   D) Room: o pedido escalado mostra "só você resolve", 2 radios, "recomendada",
//      "Custo do erro"; o humano escolhe B e responde
//   E) ledger reason='answered' para filha E mãe; envelopes nos dois stubs;
//      handoff_events request_open → request_answer → request_escalate → resume
//   F) rascunho na caixa da filha → a resposta do pedido restante fica held
//      (input-dirty); limpar → delivered
//   G) zero erros de console
// Rodar: TR_SCRATCH=<dir> TR_SANDBOX=<dir> npx tsx e2e/scenarios/typed-requests.ts
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { cleanCopy, closeOverlays, liveGlobal, mcpAs, spawnSession } from '../driver/crew-seed'
import { createFakeHome } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { waitReady } from '../driver/nav'

const RUN_ID = Date.now()
const SCRATCH = process.env.TR_SCRATCH ?? join(tmpdir(), `typed-requests-${RUN_ID}`)
const SANDBOX = process.env.TR_SANDBOX ?? join(tmpdir(), `tr-sandbox-${RUN_ID}`)
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
mkdirSync(SANDBOX, { recursive: true })

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
const MOM = join(SANDBOX, 'mom')
const KID = join(SANDBOX, 'kid')
for (const d of [MOM, KID]) {
  mkdirSync(d, { recursive: true })
  git(d, 'init', '-q')
  writeFileSync(join(d, 'README.md'), 'x\n')
  git(d, 'add', '.')
  git(d, 'commit', '-qm', 'init')
}

const failures: string[] = []
function check(label: string, ok: boolean, detail = ''): boolean {
  console.log(`[typed-requests] ${ok ? 'OK ' : 'FALHOU'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
  return ok
}

const fake = createFakeHome({ parentDir: SANDBOX })
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const RULE = '─'.repeat(50)
// Stub: grava o session file, ecoa o stdin no log por PID. USR1 desenha um
// rascunho na caixa de input (input-dirty); USR2 volta para a caixa vazia.
const stubPath = join(fake.root, 'bin', 'tr-claude.sh')
writeFileSync(
  stubPath,
  `#!/usr/bin/env bash
SESSIONS_DIR=${shq(fake.sessionsDir)}
LOG=${shq(fake.logDir)}/claude-$$.log
session_id=''; name=''
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--resume) session_id="$2"; shift 2 ;;
    -n|--name) name="$2"; shift 2 ;;
    *) shift ;;
  esac
done
now=$(date +%s%3N)
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"idle","name":"%s","startedAt":%s,"updatedAt":%s}' \\
  "$$" "$session_id" "$PWD" "$name" "$now" "$now" > "$SESSIONS_DIR/$$.json"
box() { printf '\\n${RULE}\\n❯ %s\\n${RULE}\\n' "$1"; }
printf 'Fake Claude (typed-requests) nome: %s\\n' "$name"
box ''
trap 'printf "\\033[2J\\033[3J\\033[H"; printf "rascunho\\n"; box "rascunho da filha"; printf "draft:on\\n" >> "$LOG"' USR1
trap 'printf "\\033[2J\\033[3J\\033[H"; printf "rascunho limpo\\n"; box ""; printf "draft:off\\n" >> "$LOG"' USR2
while true; do
  if IFS= read -r line; then
    line=\${line//$'\\e[200~'/}
    line=\${line//$'\\e[201~'/}
    line=\${line%$'\\r'}
    printf 'stdin: %s\\n' "$line" >> "$LOG"
    printf 'recebido: %s\\n' "$line"
    box ''
  elif [ $? -le 128 ]; then
    exit 0
  fi
done
`,
)
chmodSync(stubPath, 0o755)

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData: string = first.userDataCopy
console.log('[typed-requests] userData cópia:', userData)
const proj = (await queryDb(
  userData,
  'SELECT id FROM projects ORDER BY position LIMIT 1',
)) as Array<{
  id: string
}>
const P0 = proj[0].id
const F = 'tr-feature'
const featDir = join(userData, 'features', P0)
mkdirSync(featDir, { recursive: true })
writeFileSync(join(featDir, 'tr-pedidos.md'), '# tr-pedidos\n')
const t0 = Date.now()
await cleanCopy(userData, (db: any) => {
  for (const [id, path] of [
    ['tr-mom', MOM],
    ['tr-kid', KID],
  ])
    db.run(
      'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 990, ?)',
      [id, P0, id, path, t0],
    )
  db.run(
    `INSERT INTO features (id, project_id, slug, title, status, doc_path, synth_mode, created_at, updated_at)
     VALUES (?, ?, 'tr-pedidos', 'TR Pedidos', 'in-progress', ?, 'manual', ?, ?)`,
    [F, P0, join(featDir, 'tr-pedidos.md'), t0, t0],
  )
  for (const repo of ['tr-mom', 'tr-kid'])
    db.run(
      'INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?,?,?,?)',
      [F, repo, null, null],
    )
})
writeCopyPrefs(userData, {
  claude_command: stubPath,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

// A cópia é escrita pelo app vivo (WAL): node:sqlite lê o -wal.
const live = (sql: string): any[] => {
  const d = new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
  try {
    return d.prepare(sql).all() as any[]
  } finally {
    d.close()
  }
}
const logOf = (pid: number) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

// ---------- 2ª subida ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const logs = captureLogs(app, page)
console.log('[typed-requests] log:', logs.logFile)
const pageErrors: string[] = []
page.on('pageerror', (e: Error) => pageErrors.push(e.stack ?? e.message))
page.on('console', (m: any) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text().slice(0, 300)}`)
})
const shot = (n: string) =>
  page.screenshot({ path: join(SCRATCH, `typed-requests-${n}.png`) }).catch(() => {})

async function waitFor(label: string, fn: () => Promise<boolean> | boolean, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - started > timeoutMs) {
      await shot('timeout')
      throw new Error(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(500)
  }
}

async function openRoom(featureId: string): Promise<boolean> {
  await closeOverlays(page)
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  await page.waitForTimeout(700)
  const opt = page.locator(
    `[data-testid="feature-switcher"] [role="option"][data-key="${featureId}"]`,
  )
  if (!(await opt.count())) {
    await page.keyboard.press('Escape')
    await page.keyboard.up('Control')
    return false
  }
  for (let i = 0; i < 20 && (await opt.getAttribute('aria-selected')) !== 'true'; i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(80)
  }
  await page.keyboard.up('Control')
  await page.waitForTimeout(800)
  return page.getByTestId('feature-room').isVisible()
}

const pidByCwd = (dir: string): number | null => {
  const want = realpathSync(dir)
  const f = fake
    .readSessionFiles()
    .find((s: any) => s.data.cwd && realpathSync(s.data.cwd) === want)
  return f ? (f.data as any).pid : null
}
const errorOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => '',
    (e: unknown) => String(e instanceof Error ? e.message : e),
  )

try {
  await app.evaluate(({ BrowserWindow }: any) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setContentSize(1440, 900)
  })
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})

  // ---------- A) despacho real + 2 asks estruturados ----------
  const before = new Set((await liveGlobal(page)).map((s: any) => s.id))
  await spawnSession(page, 'tr-mom')
  let M = ''
  await waitFor('mãe viva', async () => {
    M =
      (await liveGlobal(page)).find((s: any) => s.repo?.id === 'tr-mom' && !before.has(s.id))?.id ??
      ''
    return !!M
  })
  await page.evaluate(([s, f]) => (window as any).api.sessions.setFeature(s, f), [M, F])
  const asM = await mcpAs(userData, fake.root, M)
  const disp = (await asM.call('session_handoff', {
    targetRepo: 'tr-kid',
    fromRepo: 'tr-mom',
    task: 'tr: escolher a fila do worker',
    mode: 'auto-edits',
    featureId: F,
  })) as any
  check(
    'A: session_handoff aceito',
    !!disp?.handoffId && !disp?.error,
    JSON.stringify(disp).slice(0, 200),
  )
  const H: string = disp.handoffId
  let C = ''
  await waitFor(
    'A: filha nasceu',
    async () => {
      const hs = (await page.evaluate(() => (window as any).api.handoffs.list())) as any[]
      C = hs.find((h) => h.id === H)?.childSessionId ?? ''
      return !!C && (await liveGlobal(page)).some((x: any) => x.id === C)
    },
    30_000,
  )
  await waitFor(
    'A: session files da mãe e da filha',
    () => !!pidByCwd(MOM) && !!pidByCwd(KID),
    20_000,
  )
  const pidM = pidByCwd(MOM)!
  const pidC = pidByCwd(KID)!
  console.log('[typed-requests] mãe', M, 'pid', pidM, '· filha', C, 'pid', pidC, '· handoff', H)
  for (const id of [M, C])
    await page.evaluate((pty) => (window as any).api.sessions.resize(pty, 100, 30), id)

  const asC = await mcpAs(userData, fake.root, C)
  const r1 = (await asC.call('handoff_ask', {
    handoffId: H,
    kind: 'decision',
    question: 'Qual fila uso para o worker?',
    options: [
      { key: 'A', label: 'Redis', detail: 'mais uma dependência' },
      { key: 'B', label: 'SQLite', detail: 'já está no app' },
    ],
    recommendation: 'B',
    costOfError: 'reescrever o worker; reversível',
  })) as any
  const r2 = (await asC.call('handoff_ask', {
    handoffId: H,
    question: 'Posso renomear o módulo queue para jobs?',
  })) as any
  const openRows = () =>
    live(
      `SELECT id, kind, resolver, status FROM handoff_requests WHERE handoff_id='${H}' AND status='open'`,
    )
  const statusOf = () => live(`SELECT status FROM handoffs WHERE id='${H}'`)[0]?.status
  check(
    'A: 2 pedidos abertos em handoff_requests',
    openRows().length === 2,
    JSON.stringify(openRows()),
  )
  check('A: handoff needs_input', statusOf() === 'needs_input', statusOf())
  check(
    'A: kinds decision + question',
    r1.requestId &&
      r2.requestId &&
      openRows()
        .map((r) => r.kind)
        .join() === 'decision,question',
  )

  // ---------- B) mãe responde o 1º; o handoff segue esperando o 2º ----------
  await asM.call('handoff_answer', {
    handoffId: H,
    requestId: r1.requestId,
    choice: 'B',
    text: 'vai de SQLite',
  })
  check(
    'B: needs_input mantido com 1 pendente',
    statusOf() === 'needs_input' && openRows().length === 1,
  )
  await waitFor(
    'B: <pitwall-answer> do 1º no stdin da filha',
    () =>
      logOf(pidC).includes(`<pitwall-answer request-id="${r1.requestId}"`) &&
      logOf(pidC).includes('</pitwall-answer>'),
    40_000,
  )
  check(
    'B: envelope traz a resposta e os pendentes',
    logOf(pidC).includes('resposta: B — SQLite') && logOf(pidC).includes('pendentes: 1'),
  )

  // ---------- C) human_only: a mãe não resolve, escala ----------
  const r3 = (await asC.call('handoff_ask', {
    handoffId: H,
    kind: 'decision',
    question: 'Faço o deploy do worker em produção agora?',
    options: [
      { key: 'A', label: 'Agora', detail: 'janela de pico' },
      { key: 'B', label: 'Amanhã cedo', detail: 'fora do pico' },
    ],
    recommendation: 'B',
    costOfError: 'fila parada em produção; rollback de 10 min',
    risk: 'deploy_infra_spend',
  })) as any
  check('C: ask com risk → resolver human_only', r3.resolver === 'human_only', JSON.stringify(r3))
  const refused = await errorOf(
    asM.call('handoff_answer', { handoffId: H, requestId: r3.requestId, choice: 'A' }),
  )
  check(
    'C: handoff_answer da mãe recusado com human_only',
    refused.includes('human_only'),
    refused.slice(0, 200),
  )
  const esc = (await asM.call('handoff_escalate', { handoffId: H, requestId: r3.requestId })) as any
  const r3row = live(
    `SELECT resolver, escalated_by, status FROM handoff_requests WHERE id='${r3.requestId}'`,
  )[0]
  check(
    'C: escalado: resolver human_only, escalated_by = mãe',
    esc.resolver === 'human_only' && r3row?.resolver === 'human_only' && r3row?.escalated_by === M,
    JSON.stringify(r3row),
  )

  // ---------- D) Room: o humano responde inline ----------
  check('D: Room abre pelo Ctrl+`', await openRoom(F))
  const openItem = page.getByTestId('room-queue-open')
  await waitFor(
    'D: item aberto é o pedido escalado',
    async () =>
      (await openItem.count()) > 0 && (await openItem.innerText()).includes('Faço o deploy'),
    20_000,
  )
  const row = page.locator('[data-testid="room-queue-row"][data-kind="request"]').first()
  check('D: linha da fila com data-kind=request', (await row.count()) === 1)
  const text = await openItem.innerText()
  check('D: "só você resolve"', text.includes('só você resolve (human_only)'))
  check('D: "escalado pela mãe"', text.includes('escalado pela mãe'))
  const radios = openItem.getByRole('radio')
  check('D: 2 radios', (await radios.count()) === 2)
  check('D: B é a "recomendada"', (await radios.nth(1).innerText()).includes('recomendada'))
  check(
    'D: "Custo do erro"',
    text.includes('Custo do erro:') && text.includes('rollback de 10 min'),
  )
  check(
    'D: Responder desabilitado antes de escolher',
    await openItem.getByRole('button', { name: 'Escolha uma opção' }).isDisabled(),
  )
  await shot('room')
  await radios.nth(1).click()
  await openItem.getByRole('textbox', { name: 'Comentário' }).fill('amanhã às 7h')
  await openItem.getByRole('button', { name: 'Responder B' }).click()
  await waitFor(
    'D: pedido escalado respondido pelo humano',
    () =>
      live(`SELECT status FROM handoff_requests WHERE id='${r3.requestId}'`)[0]?.status ===
      'answered',
    15_000,
  )
  const r3done = live(
    `SELECT answer, answer_note, answered_by FROM handoff_requests WHERE id='${r3.requestId}'`,
  )[0]
  check(
    'D: resposta B by=human com o comentário',
    r3done?.answer === 'B' &&
      r3done?.answered_by === 'human' &&
      r3done?.answer_note === 'amanhã às 7h',
    JSON.stringify(r3done),
  )
  await waitFor(
    'D: o pedido some da fila',
    async () => !(await page.getByText('Faço o deploy').count()),
    15_000,
  )
  await shot('room-after')

  // ---------- E) entrega para quem perguntou E quem escalou ----------
  const tag3 = `<pitwall-answer request-id="${r3.requestId}"`
  await waitFor('E: envelope no stdin da filha', () => logOf(pidC).includes(tag3), 40_000)
  await waitFor('E: envelope no stdin da mãe', () => logOf(pidM).includes(tag3), 40_000)
  const answeredRows = () =>
    live(
      `SELECT mother_session_id AS target, reason, outcome FROM handoff_wake_deliveries
        WHERE handoff_id='${H}' AND reason='answered' ORDER BY created_at`,
    )
  await waitFor(
    'E: ledger answered delivered para filha e mãe',
    () =>
      [C, M].every((s) => answeredRows().some((r) => r.target === s && r.outcome === 'delivered')),
    20_000,
  )
  console.log('[typed-requests] ledger answered:', JSON.stringify(answeredRows()))
  check(
    'E: ledger reason=answered para a filha e a mãe',
    [C, M].every((s) => answeredRows().some((r) => r.target === s)),
  )

  // ---------- F) rascunho na caixa da filha segura a resposta ----------
  process.kill(pidC, 'SIGUSR1')
  await waitFor('F: draft:on no stub', () => logOf(pidC).includes('draft:on'), 10_000)
  await page.waitForTimeout(1500)
  await asM.call('handoff_answer', { handoffId: H, requestId: r2.requestId, text: 'pode renomear' })
  const tag2 = `<pitwall-answer request-id="${r2.requestId}"`
  const r2Rows = () =>
    live(
      `SELECT r.outcome, r.detail, r.held_at, r.delivered_at FROM handoff_wake_deliveries r
        WHERE r.handoff_id='${H}' AND r.reason='answered' AND r.mother_session_id='${C}'
        ORDER BY r.created_at DESC LIMIT 1`,
    )[0]
  await waitFor('F: ledger held (input-dirty)', () => r2Rows()?.outcome === 'held', 40_000)
  check(
    'F: held com detail input-dirty',
    r2Rows()?.detail === 'input-dirty',
    JSON.stringify(r2Rows()),
  )
  await page.waitForTimeout(3000)
  check('F: com rascunho, nada no stdin', !logOf(pidC).includes(tag2))
  check('F: handoff retomou (sem pendentes)', statusOf() === 'running', statusOf())
  process.kill(pidC, 'SIGUSR2')
  await waitFor('F: envelope entregue depois de limpar', () => logOf(pidC).includes(tag2), 40_000)
  await waitFor('F: ledger delivered', () => r2Rows()?.outcome === 'delivered', 15_000)
  check(
    'F: held → delivered (held_at preservado)',
    !!r2Rows()?.held_at && !!r2Rows()?.delivered_at,
    JSON.stringify(r2Rows()),
  )

  // E (trilha): a ordem dos eventos do handoff
  const events = live(
    `SELECT event FROM handoff_events WHERE handoff_id='${H}' ORDER BY at, rowid`,
  ).map((e) => e.event as string)
  const at = (e: string) => events.indexOf(e)
  check(
    'E: handoff_events request_open → request_answer → request_escalate → resume',
    at('request_open') >= 0 &&
      at('request_open') < at('request_answer') &&
      at('request_answer') < at('request_escalate') &&
      at('request_escalate') < events.lastIndexOf('resume'),
    events.join(','),
  )

  // ---------- H1) handoff_message sem requestId com só human_only aberto → recusado ----------
  const r4 = (await asC.call('handoff_ask', {
    handoffId: H,
    kind: 'decision',
    question: 'Apago a tabela jobs_old em produção?',
    options: [
      { key: 'A', label: 'Sim', detail: 'libera espaço' },
      { key: 'B', label: 'Não', detail: 'mantém histórico' },
    ],
    recommendation: 'B',
    costOfError: 'perda de histórico; irreversível',
    risk: 'destructive_data',
  })) as any
  check('H1: ask destructive_data → human_only', r4.resolver === 'human_only', JSON.stringify(r4))
  check(
    'H1: só o human_only aberto',
    openRows().length === 1 && openRows()[0].resolver === 'human_only',
    JSON.stringify(openRows()),
  )
  const MARK_H1 = 'tr-h1-libera-sem-requestid'
  const refusedMsg = await errorOf(asM.call('handoff_message', { handoffId: H, text: MARK_H1 }))
  check(
    'H1: handoff_message recusado (cita human_only e handoff_escalate)',
    refusedMsg.includes('human_only') && refusedMsg.includes('handoff_escalate'),
    refusedMsg.slice(0, 300),
  )
  await page.waitForTimeout(3000)
  check('H1: nada injetado no stdin da filha', !logOf(pidC).includes(MARK_H1))
  check(
    'H1: pedido human_only segue aberto',
    live(`SELECT status FROM handoff_requests WHERE id='${r4.requestId}'`)[0]?.status === 'open',
  )
  check('H1: handoff segue needs_input', statusOf() === 'needs_input', statusOf())

  // ---------- H2) handoff_message com requestId fecha o pedido ----------
  const r5 = (await asC.call('handoff_ask', {
    handoffId: H,
    question: 'Posso adicionar índice em jobs.created_at?',
  })) as any
  check('H2: ask comum → não human_only', !!r5.requestId && r5.resolver !== 'human_only')
  const viaMsg = (await asM.call('handoff_message', {
    handoffId: H,
    requestId: r5.requestId,
    text: 'pode criar o índice',
  })) as any
  console.log('[typed-requests] H2 retorno:', JSON.stringify(viaMsg).slice(0, 300))
  const r5row = () =>
    live(
      `SELECT status, answered_by, answer_note FROM handoff_requests WHERE id='${r5.requestId}'`,
    )[0]
  check(
    'H2: pedido fechado (answered by mother)',
    r5row()?.status === 'answered' && r5row()?.answered_by === 'mother',
    JSON.stringify(r5row()),
  )
  check(
    'H2: sai da fila de abertos (só sobra o human_only)',
    openRows().length === 1 && openRows()[0].id === r4.requestId,
    JSON.stringify(openRows()),
  )
  const tag5 = `<pitwall-answer request-id="${r5.requestId}"`
  await waitFor('H2: envelope do r5 no stdin da filha', () => logOf(pidC).includes(tag5), 40_000)
  check(
    'H2: envelope entregue uma vez',
    logOf(pidC).split(tag5).length - 1 === 1,
    String(logOf(pidC).split(tag5).length - 1),
  )
  check('H2: handoff segue needs_input (human_only aberto)', statusOf() === 'needs_input')

  // ---------- G) ----------
  check('G: zero erros de console', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 500))
  console.log('[typed-requests] stdin da filha:\n' + logOf(pidC))
} catch (err) {
  failures.push(String(err))
  console.error('[typed-requests] ERRO', err)
  await shot('error')
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    /* já saiu */
  }
}

if (failures.length > 0) {
  console.error(`[typed-requests] ${failures.length} falha(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('[typed-requests] PASS')
