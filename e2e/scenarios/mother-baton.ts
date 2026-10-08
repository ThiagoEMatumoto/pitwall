import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// F3 — mãe visível e transferível, sobre a CÓPIA do perfil real com HOME fake e
// stubs vivos do `claude` (nunca tocam os repos, nenhuma API é chamada):
//   M (mãe, sessão comum) + C1/C2 (filhas de handoff de M) → mapa: só M tem
//   [data-mother=true] e o badge "MÃE · 2" (ou só "2" no brief) com ≥ 11px efetivos →
//   menu de contexto "Passar o bastão da mãe…" → briefing ESCRITO À MÃO (a
//   destilação não tem transcript no HOME fake) → sucessora S.
// Aceite: handoffs de C1/C2 apontam pra S (SQL) · stub de C1 recebeu a nota com
// o alias novo · fios saem de S · [data-mother=true] só em S · M "bastão passado"
// · handoff_report de C1 chega em S · zero erros de console.
// Rodar: BATON_SHOTS=<dir> npx tsx e2e/scenarios/mother-baton.ts

const SHOTS = process.env.BATON_SHOTS ?? join(tmpdir(), `mother-baton-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0
const shotPath = (name: string) => join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub vivo (o mesmo de mission-control-journey.ts): caixa de input ociosa e eco
// do stdin, linha a linha, em claude-<pid>.log — é lá que a nota da mãe aparece.
function liveStub(sessionsDir: string, logDir: string): string {
  const rule = '─'.repeat(50)
  return `#!/usr/bin/env bash
SESSIONS_DIR=${shq(sessionsDir)}
LOGDIR=${shq(logDir)}
LOG="$LOGDIR/claude-$$.log"
printf 'argv:' >> "$LOG"; for a in "$@"; do printf ' %q' "$a" >> "$LOG"; done; printf '\\n' >> "$LOG"
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
box() { printf '\\n%s\\n\\u276f \\n%s\\n' ${shq(rule)} ${shq(rule)}; }
printf '\\u256d\\u2500 Fake Claude Code (stub e2e)\\n'
printf '\\u2502  nome:   %s\\n' "$name"
printf '\\u2570\\u2500\\n'
box
while true; do
  if IFS= read -r line; then
    line=\${line//$'\\e[200~'/}
    line=\${line//$'\\e[201~'/}
    line=\${line%$'\\r'}
    printf 'stdin: %s\\n' "$line" >> "$LOG"
    printf 'recebido: %s\\n' "$line"
    box
  elif [ $? -le 128 ]; then
    exit 0
  fi
done
`
}
const stub = join(fake.root, 'bin', 'live-claude.sh')
mkdirSync(join(fake.root, 'bin'), { recursive: true })
writeFileSync(stub, liveStub(fake.sessionsDir, fake.logDir))
chmodSync(stub, 0o755)

const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[baton] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const repo = (
  await queryDb<{ id: string; label: string; path: string }>(
    userData,
    'SELECT id, label, path FROM repos ORDER BY position',
  )
).find((r) => r.path?.startsWith('/') && existsSync(r.path))
if (!repo) throw new Error('a cópia precisa de 1 repo com path absoluto existente')
console.log(`[baton] repo: ${repo.label}`)

writeCopyPrefs(userData, {
  claude_command: stub,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

// ---------- 2ª subida: app real, HOME fake ----------
const { app, page, mainOutput } = await launchApp({ userDataDir: userData, env: fake.env })
const logs = captureLogs(app, page)
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
})
const shot = (name: string) => page.screenshot({ path: shotPath(name) }).catch(() => {})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[baton] timeout esperando: ${label}`)
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(400)
  }
}

function mcpAs(sessionId: string) {
  const cfg = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8'))
  const url = new URL(cfg.url)
  url.searchParams.set('s', sessionId)
  const dir = join(fake.root, `mcp-as-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ ...cfg, url: url.toString() }))
  return connectMcp(dir)
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const pidOf = (cc: string) => files().find((f) => f.data.sessionId === cc)?.data.pid
const stdinOf = (pid: number | undefined) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return pid && existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const graph = () => page.evaluate(() => window.api.sessionGraph.get())
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const fit = async () => {
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await page.waitForTimeout(500)
}

// Tamanho de texto NA TELA: font-size × escala do viewport do React Flow.
async function effectivePx(selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    const vp = document.querySelector('.react-flow__viewport')
    if (!el || !vp) return 0
    const scale = new DOMMatrix(getComputedStyle(vp).transform).a
    return parseFloat(getComputedStyle(el).fontSize) * scale
  }, selector)
}

const BRIEFING_MANUAL =
  '## Estado atual\nBriefing escrito à mão no e2e (destilação indisponível).\n## Próximo passo\nSupervisionar as filhas.'

let fatal: unknown = null
const sqlChecks: { idS?: string; resultStatus?: string } = {}
let c1Ref = { handoffId: '' }
let c2Ref = { handoffId: '' }
let idMRef = ''
try {
  await waitReady(page)

  // ---------- M + C1/C2 (PTYs vivas) ----------
  const spawned = await page.evaluate(async (repoId) => {
    const m = await window.api.sessions.spawn({ repoId, name: 'mae-baton-e2e' })
    const kids: Array<{ id: string; cc: string | null; handoffId: string }> = []
    for (const [name, task] of [
      ['mauricio-mapa-e2e', 'Agrupar o mapa por feature'],
      ['otavio-modal-e2e', 'Terminal em modal'],
    ] as const) {
      const c = await window.api.sessions.spawn({ repoId, name, handoffChild: true })
      // As duas filhas dividem o checkout do repo: em plan (read-only) não
      // disputam a posse do diretório, nem com filhas ativas da cópia do perfil.
      const { handoff } = await window.api.handoffs.createManual({
        repoId,
        motherSessionId: m.id,
        task,
        mode: 'plan',
      })
      await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: c.id })
      kids.push({ id: c.id, cc: c.ccSessionId, handoffId: handoff.id })
    }
    return { m: { id: m.id, cc: m.ccSessionId }, kids }
  }, repo.id)
  const idM = spawned.m.id
  const [c1, c2] = spawned.kids
  c1Ref = c1
  c2Ref = c2
  idMRef = idM
  const up = await waitFor('session files de M, C1, C2', async () =>
    [spawned.m.cc, c1.cc, c2.cc].every((cc) => !!cc && pidOf(cc) !== undefined),
  )
  check(up, 'M, C1 e C2 com PTYs vivas (stub)')

  // ---------- mapa: M é a mãe ----------
  // O mapa é uma vista da área de projetos: o atalho não age a partir da Home.
  await goToArea(page, 'projects')
  await page.keyboard.press('Control+Shift+KeyG')
  check(
    await waitFor('mapa', async () => page.getByTestId('session-map').isVisible(), 10_000),
    'Ctrl+Shift+G abre o mapa',
  )
  await fit()
  await waitFor(
    'cartões',
    async () => (await card(idM).count()) > 0 && (await card(c1.id).count()) > 0,
  )
  const motherBefore = await page
    .locator('[data-testid="session-card"][data-mother="true"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id')))
  check(
    motherBefore.length === 1 && motherBefore[0] === idM,
    `antes: [data-mother=true] só em M (${motherBefore.join(',')})`,
  )
  const badgeSel = `[data-testid="session-card"][data-session-id="${idM}"] [data-testid="card-mother-badge"]`
  const badgeText = (
    await page
      .locator(badgeSel)
      .first()
      .innerText()
      .catch(() => '')
  ).trim()
  const badgePx = await effectivePx(badgeSel)
  // Brief/recolhido: só coroa + contagem; aberto: "MÃE · 2". O extenso no tooltip.
  const badgeTitle = (await page.locator(badgeSel).first().getAttribute('title')) ?? ''
  check(
    /^(MÃE · )?2$/i.test(badgeText) && /lidera 2 filhas/.test(badgeTitle),
    `badge de M: "${badgeText}" (title "${badgeTitle}")`,
  )
  check(badgePx >= 11, `badge com ${badgePx.toFixed(1)}px efetivos (>= 11)`)
  await shot('before-baton')

  // ---------- bastão da mãe PELA UI, briefing manual ----------
  await card(idM).click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: /Passar o bastão da mãe/ })
  check(
    await waitFor('item do menu', async () => (await item.count()) > 0, 5000),
    'menu de contexto de M oferece "Passar o bastão da mãe…"',
  )
  await item.click()
  check(
    await waitFor(
      'modo mãe',
      async () => (await page.getByTestId('baton-mother-mode').count()) > 0,
      10_000,
    ),
    'diálogo em modo mãe (lista as filhas)',
  )
  // A destilação falha sem transcript; se ainda estiver rodando, pula pro manual.
  const manual = page.getByTestId('baton-write-manual')
  if (await manual.isVisible().catch(() => false)) await manual.click()
  const textarea = page.getByTestId('baton-briefing')
  check(
    await waitFor('textarea do briefing', async () => textarea.isVisible(), 95_000),
    'textarea do briefing disponível sem destilação',
  )
  await textarea.fill(BRIEFING_MANUAL)
  await shot('dialog-manual')
  const beforeIds = new Set((await graph()).nodes.map((n) => n.sessionId))
  await page.getByTestId('baton-confirm').click()

  let idS = ''
  await waitFor('sucessora no grafo', async () => {
    idS =
      (await graph()).nodes.find((n) => !beforeIds.has(n.sessionId) && n.status !== 'ended')
        ?.sessionId ?? ''
    return idS !== ''
  })
  check(!!idS, `sucessora S subiu (${idS})`)

  // O alias de S vem do grafo (conexão viva); o SQL é conferido depois do
  // app.close(), quando o WAL já foi checkpointed (ver e2e/driver/inspect.ts).
  const sNode = (await graph()).nodes.find((n) => n.sessionId === idS)
  const sTitle = sNode?.cliName ?? sNode?.title ?? ''
  sqlChecks.idS = idS

  // Nota no stub de C1 com o alias novo (e o antigo).
  const c1Pid = pidOf(c1.cc!)
  const noted = await waitFor(
    'nota no stdin de C1',
    async () => stdinOf(c1Pid).includes(`Sua mãe agora é "${sTitle}"`),
    15_000,
  )
  if (!noted || !stdinOf(c1Pid).includes('mae-baton-e2e'))
    console.log(`[baton] stdin de C1 (${c1Pid}):\n${stdinOf(c1Pid).slice(-1500)}`)
  check(
    noted && stdinOf(c1Pid).includes('mae-baton-e2e'),
    'stub de C1 recebeu a nota com o alias novo e o antigo',
  )

  // Briefing manual + Filhas ativas no system prompt / kickoff de S.
  const sPid = files().find((f) => f.data.name === sTitle)?.data.pid
  const sArgv = stdinOf(sPid)
  check(
    sArgv.includes('MÃE') && sArgv.includes('mauricio-mapa-e2e'),
    'kickoff de S lista as filhas e o papel de mãe',
  )

  // Fios e indicador depois do bastão.
  const g = await graph()
  const wires = g.edges.filter(
    (e) => e.kind === 'handoff' && (e.to === c1.id || e.to === c2.id),
  ) as Array<{ from: string }>
  check(
    wires.length === 2 && wires.every((w) => w.from === idS),
    `fios saem de S (${wires.map((w) => w.from).join(',')})`,
  )
  check(
    g.edges.some((e) => e.kind === 'baton' && e.from === idM && e.to === idS),
    'aresta baton M→S no grafo',
  )
  // O bastão leva o usuário à aba da sucessora: volta ao mapa para conferir o nó.
  if (
    !(await page
      .getByTestId('session-map')
      .isVisible()
      .catch(() => false))
  ) {
    await page.keyboard.press('Control+Shift+KeyG')
    await waitFor('mapa (depois)', async () => page.getByTestId('session-map').isVisible(), 10_000)
  }
  await fit()
  const motherAfterOk = await waitFor('data-mother em S', async () => {
    const ids = await page
      .locator('[data-testid="session-card"][data-mother="true"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id')))
    return ids.length === 1 && ids[0] === idS
  })
  check(motherAfterOk, 'depois: [data-mother=true] só em S')
  check(
    (await card(idM).getByTestId('card-baton-passed').count()) > 0 &&
      (await card(idM).getByTestId('card-baton-end').count()) > 0,
    'M marcada "bastão passado" com "Encerrar"',
  )
  await shot('after-baton')

  // handoff_report de C1 chega na sucessora.
  const asC1 = await mcpAs(c1.id)
  await asC1.call('handoff_report', { handoffId: c1.handoffId, summary: 'mapa agrupado' })
  const asS = await mcpAs(idS)
  const res = await asS.call<{ status: string; summary?: string }>('handoff_result', {
    handoffId: c1.handoffId,
  })
  sqlChecks.resultStatus = res.status
} catch (err) {
  fatal = err
  console.error('[baton] erro fatal:', err)
  await page.screenshot({ path: join(SHOTS, 'zz-fatal.png') }).catch(() => {})
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

// ---------- SQL com o app fechado (WAL checkpointed) ----------
if (sqlChecks.idS) {
  const idS = sqlChecks.idS
  const rows = await queryDb<{ id: string; mother_session_id: string; status: string }>(
    userData,
    `SELECT id, mother_session_id, status FROM handoffs WHERE id IN ('${c1Ref.handoffId}','${c2Ref.handoffId}')`,
  )
  check(
    rows.length === 2 && rows.every((r) => r.mother_session_id === idS),
    `handoffs.mother_session_id de C1/C2 = S (${rows.map((r) => r.mother_session_id).join(',')})`,
  )
  const ev = await queryDb<{ detail: string }>(
    userData,
    `SELECT detail FROM handoff_events WHERE handoff_id = '${c1Ref.handoffId}' AND event = 'mother_transferred'`,
  )
  check(
    ev.length === 1 &&
      JSON.parse(ev[0].detail).from === idMRef &&
      JSON.parse(ev[0].detail).to === idS,
    `handoff_events mother_transferred {from:M,to:S}`,
  )
  const sRow = (
    await queryDb<{ title: string; title_source: string }>(
      userData,
      `SELECT title, title_source FROM sessions WHERE id = '${idS}'`,
    )
  )[0]
  check(
    !!sRow?.title && sRow.title !== 'mae-baton-e2e' && sRow.title_source === 'manual',
    `S com alias novo e manual (${sRow?.title} / ${sRow?.title_source})`,
  )
  const c1Row = rows.find((r) => r.id === c1Ref.handoffId)
  check(
    c1Row?.status === 'done' &&
      c1Row.mother_session_id === idS &&
      sqlChecks.resultStatus === 'done',
    `handoff_report de C1 chega em S (status ${c1Row?.status}, result ${sqlChecks.resultStatus})`,
  )
}

check(
  consoleErrors.length === 0,
  `zero erros de console (${consoleErrors.slice(0, 3).join(' | ')})`,
)
const logText = readFileSync(logs.logFile, 'utf8') + mainOutput()
check(logText.includes('[drive-safe]'), '[drive-safe] no log')
fake.cleanup()

const failed = results.filter((r) => !r.ok)
console.log('\n[baton] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(
  `[baton] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS} · log ${logs.logFile}`,
)
if (fatal || failed.length) process.exit(1)
