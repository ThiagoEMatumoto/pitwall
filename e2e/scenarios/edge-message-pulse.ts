import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// Bolinha de informação no fio do mapa (session-link-pulse → edge-pulse-store →
// SessionEdge). Mãe (Ctrl+N) + 2 filhas por MCP session_handoff, PTYs vivas (stub
// fake-claude). Para cada mensagem REAL — handoff_message (mãe→filha 1),
// handoff_ask (filha 2→mãe), handoff_report (filha 1→mãe) — assere:
//   · a bolinha nasce na aresta certa com from/to/direção certos;
//   · ela ANDA pelo path (posição muda entre 2 frames);
//   · o ping aparece no cartão destino;
// e, com prefers-reduced-motion emulado, só o flash do fio (sem bolinha).
// Frames do trajeto em $PULSE_SHOTS (padrão: <scratch>/drive/W3-pulse) + GIF.
// Rodar (depois de rebuild:native + build): npx tsx e2e/scenarios/edge-message-pulse.ts

const SHOTS =
  process.env.PULSE_SHOTS ??
  join(
    tmpdir(),
    'claude-1000',
    '-home-thiagoematumoto-projetos-pessoal-claude-manager',
    'mc2',
    'drive',
    'W3-pulse',
  )
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Mesmo stub vivo do mission-control-journey: caixa de input ociosa e eco do stdin.
function liveStub(sessionsDir: string, logDir: string): string {
  const rule = '─'.repeat(50)
  return `#!/usr/bin/env bash
SESSIONS_DIR=${shq(sessionsDir)}
LOGDIR=${shq(logDir)}
LOG="$LOGDIR/claude-$$.log"
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
  console.log(`[pulse] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

interface RepoRow {
  id: string
  label: string
  path: string
}
const repos = (
  await queryDb<RepoRow>(userData, 'SELECT id, label, path FROM repos ORDER BY position')
).filter((r) => r.path?.startsWith('/') && existsSync(r.path))
const labelCount = new Map<string, number>()
for (const r of repos) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)
const unique = repos.filter((r) => labelCount.get(r.label) === 1)
const [repoMae, repoF1, repoF2] = [unique[0], unique[1], unique[2] ?? unique[1]]
if (!repoMae || !repoF1) throw new Error('a cópia precisa de 2 repos com labels únicos')

writeCopyPrefs(userData, {
  claude_command: stub,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

// ---------- 2ª subida: app real, HOME fake ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const logs = captureLogs(app, page)
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[pulse] timeout esperando: ${label}`)
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(300)
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
const live = () =>
  page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<
    Array<{ id: string; ccSessionId: string }>
  >
async function newSessionId(before: Set<number>, label: string): Promise<string> {
  let id = ''
  await waitFor(label, async () => {
    const f = files().find((x) => !before.has(x.data.pid))
    if (!f) return false
    id = (await live()).find((s) => s.ccSessionId === f.data.sessionId)?.id ?? ''
    return id !== ''
  })
  return id
}

interface Observed {
  found: boolean
  from: string | null
  to: string | null
  direction: string | null
  kind: string | null
  positions: Array<{ x: number; y: number }>
  ping: boolean
  flash: boolean
}

// Observa, DENTRO da página, a 1ª bolinha que nascer na aresta `edgeId` vindo de
// `from`: amostra a posição da cabeça em vários frames e espera o ping no destino.
// O tsx injeta __name nas funções nomeadas do callback (tick, edge), e esse helper
// não existe na página: define-o como identidade antes de avaliar.
async function observe(
  edgeId: string,
  from: string,
  to: string,
  reduced = false,
): Promise<Observed> {
  await page.evaluate('globalThis.__name ??= (f) => f')
  return page.evaluate(
    ({ edgeId, from, to, reduced }) =>
      new Promise<Observed>((resolve) => {
        const out: Observed = {
          found: false,
          from: null,
          to: null,
          direction: null,
          kind: null,
          positions: [],
          ping: false,
          flash: false,
        }
        // O fio aceso mora no <g> do edge; a bolinha e o ping, na camada acima dos
        // cartões (svg[data-edge-pulse-layer] no ViewportPortal).
        const edge = () => {
          const wire = document.querySelector(`.react-flow__edge[data-id="${edgeId}"]`)
          const top = document.querySelector(`[data-edge-pulse-layer="${edgeId}"]`)
          if (!wire && !top) return null
          return {
            querySelector: (q: string) => top?.querySelector(q) ?? wire?.querySelector(q) ?? null,
          }
        }
        const started = performance.now()
        const tick = () => {
          const root = edge()
          const sel = `[data-from="${from}"][data-to="${to}"]`
          if (reduced) {
            if (root?.querySelector(`[data-edge-pulse-flash]${sel}`)) out.flash = true
            if (root?.querySelector(`[data-edge-pulse]${sel}`)) out.found = true
            if (performance.now() - started > 2500) return resolve(out)
            return void requestAnimationFrame(tick)
          }
          const g = root?.querySelector(`[data-edge-pulse]${sel}`)
          if (g) {
            out.found = true
            out.from = g.getAttribute('data-from')
            out.to = g.getAttribute('data-to')
            out.direction = g.getAttribute('data-direction')
            out.kind = g.getAttribute('data-kind')
            const head = g.querySelector('[data-edge-pulse-head]')
            const x = Number(head?.getAttribute('cx'))
            const y = Number(head?.getAttribute('cy'))
            if (Number.isFinite(x) && Number.isFinite(y) && head?.hasAttribute('cx'))
              out.positions.push({ x, y })
          }
          if (root?.querySelector(`[data-edge-ping][data-session="${to}"]`)) {
            out.ping = true
            return resolve(out)
          }
          if (performance.now() - started > 6000) return resolve(out)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { edgeId, from, to, reduced },
  )
}

let frameN = 0
async function frames(prefix: string, n: number, gapMs: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page
      .screenshot({ path: join(SHOTS, `${prefix}-${String(++frameN).padStart(2, '0')}.png`) })
      .catch(() => {})
    await page.waitForTimeout(gapMs)
  }
}

function moved(o: Observed): boolean {
  const [a, b] = [o.positions[0], o.positions.at(-1)]
  return !!a && !!b && Math.hypot(b.x - a.x, b.y - a.y) > 20
}

let fatal: unknown = null
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})

  // ---------- mãe: Ctrl+N ----------
  await goToArea(page, 'projects')
  const beforeMae = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(repoMae.label)
  await search.press('Enter')
  await page
    .locator('div.fixed.inset-0', { hasText: `Nova sessão · ${repoMae.label}` })
    .getByRole('button', { name: 'Abrir', exact: true })
    .click()
  const idMae = await newSessionId(beforeMae, 'sessão da mãe')
  check(!!idMae, `mãe aberta em ${repoMae.label}`)

  // ---------- 2 filhas via MCP session_handoff ----------
  const asMae = await mcpAs(idMae)
  const beforeF1 = new Set(files().map((f) => f.data.pid))
  const h1 = await asMae.call<{ handoffId: string; alias: string }>('session_handoff', {
    targetRepo: repoF1.label,
    task: 'Investigar o contrato de pedidos',
    mode: 'plan',
    force: true,
  })
  const idF1 = await newSessionId(beforeF1, 'filha 1')
  const beforeF2 = new Set(files().map((f) => f.data.pid))
  const h2 = await asMae.call<{ handoffId: string; alias: string }>('session_handoff', {
    targetRepo: repoF2.label,
    task: 'Mapear os testes de checkout',
    mode: 'plan',
    force: true,
  })
  const idF2 = await newSessionId(beforeF2, 'filha 2')
  check(!!idF1 && !!idF2, `2 filhas vivas (${h1.alias}, ${h2.alias})`)

  // ---------- mapa ----------
  await page.keyboard.press('Control+Shift+KeyG')
  check(
    await waitFor('mapa', async () => page.getByTestId('session-map').isVisible(), 10_000),
    'mapa aberto',
  )
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  const e1 = `e:h:${h1.handoffId}`
  const e2 = `e:h:${h2.handoffId}`
  const edgesOk = await waitFor(
    'fios mãe→filhas',
    async () =>
      (await page.locator(`.react-flow__edge[data-id="${e1}"]`).count()) === 1 &&
      (await page.locator(`.react-flow__edge[data-id="${e2}"]`).count()) === 1,
  )
  check(edgesOk, 'fios mãe→filha 1 e mãe→filha 2 no mapa')
  await page.waitForTimeout(1500)

  // ---------- 1. handoff_message: mãe → filha 1 ----------
  {
    const seen = observe(e1, idMae, idF1)
    await asMae.call('handoff_message', { handoffId: h1.handoffId, text: 'Priorize o POST.' })
    await frames('message', 4, 140)
    const o = await seen
    check(
      o.found && o.direction === 'forward',
      `message: bolinha no fio certo, ida (${o.direction})`,
    )
    check(o.kind === 'message', `message: tipo ${o.kind}`)
    check(moved(o), `message: anda pelo path (${o.positions.length} amostras)`)
    check(o.ping, 'message: ping no cartão da filha 1')
  }

  // ---------- 2. handoff_ask: filha 2 → mãe (contra o sentido do fio) ----------
  {
    const asF2 = await mcpAs(idF2)
    await page.waitForTimeout(1200)
    const seen = observe(e2, idF2, idMae)
    await asF2.call('handoff_ask', { handoffId: h2.handoffId, question: 'Incluo os e2e?' })
    await frames('question', 4, 140)
    const o = await seen
    check(o.found && o.direction === 'reverse', `question: bolinha volta pelo fio (${o.direction})`)
    check(o.kind === 'question', `question: tipo ${o.kind}`)
    check(moved(o), `question: anda pelo path (${o.positions.length} amostras)`)
    check(o.ping, 'question: ping no cartão da mãe')
  }

  // ---------- 3. handoff_report: filha 1 → mãe ----------
  {
    const asF1 = await mcpAs(idF1)
    await page.waitForTimeout(1200)
    const seen = observe(e1, idF1, idMae)
    await asF1.call('handoff_report', { handoffId: h1.handoffId, summary: 'Contrato revisado.' })
    await frames('report', 4, 140)
    const o = await seen
    check(o.found && o.direction === 'reverse', `report: bolinha volta pelo fio (${o.direction})`)
    check(o.kind === 'report', `report: tipo ${o.kind}`)
    check(moved(o), `report: anda pelo path (${o.positions.length} amostras)`)
    check(o.ping, 'report: ping no cartão da mãe')
  }

  // ---------- 4. reduced-motion: só o flash ----------
  {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForTimeout(1200)
    const asF2 = await mcpAs(idF2)
    const seen = observe(e2, idF2, idMae, true)
    await asF2.call('handoff_progress', { handoffId: h2.handoffId, step: 'lendo os specs' })
    await frames('reduced', 2, 150)
    const o = await seen
    check(o.flash && !o.found, `reduced-motion: flash no fio, sem bolinha (flash=${o.flash})`)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
} catch (err) {
  fatal = err
  console.error('[pulse] erro fatal:', err)
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

check(
  consoleErrors.length === 0,
  `zero erros de console (${consoleErrors.slice(0, 3).join(' | ')})`,
)
fake.cleanup()

// GIF dos frames do trajeto (best-effort: sem ffmpeg, ficam os PNGs).
const gif = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '6',
    '-pattern_type',
    'glob',
    '-i',
    join(SHOTS, '*-[0-9][0-9].png'),
    '-vf',
    'scale=1280:-1:flags=lanczos',
    join(SHOTS, 'pulse.gif'),
  ],
  { stdio: 'ignore' },
)
console.log(`[pulse] gif: ${gif.status === 0 ? join(SHOTS, 'pulse.gif') : 'não gerado'}`)

const failed = results.filter((r) => !r.ok)
console.log('\n[pulse] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(`[pulse] ${results.length - failed.length}/${results.length} PASS — frames em ${SHOTS}`)
if (fatal || failed.length) process.exit(1)
