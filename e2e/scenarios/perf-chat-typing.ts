import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLongMotherLines } from '../../electron/main/services/__fixtures__/long-mother-jsonl'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { copyRealUserData, launchApp, REPO_ROOT, writeCopyPrefs } from '../driver/launch'
import { goToArea, waitReady } from '../driver/nav'
import {
  collectPerf,
  installPerfProbe,
  markPerf,
  parsePerfLines,
  summarizePerf,
} from '../driver/perf'

// Medição de desempenho antes/depois (plano A1), sobre a CÓPIA do perfil real com
// HOME fake e stubs do `claude`. Uma sessão A recebe um transcript grande e passa
// pelas fases; as demais só existem para dar carga (saída de PTY e batch de
// atividade), como no uso real com várias sessões vivas.
//   open             alterna A para o chat com o transcript já no disco
//   chat-typing      transcript crescendo a cada 100 ms + PTYs emitindo saída,
//                    enquanto 200 caracteres entram no composer a 30 ms
//   to-terminal      alterna A para o terminal (sem carga)
//   terminal-typing  a mesma carga, digitando no xterm de A
//   to-chat          volta A para o chat e deixa assentar (sem carga)
//   idle             20 s sem nada acontecendo, com o chat de A montado
//   tab-switch       Ctrl+Tab entre A (chat) e B (terminal)
// Saída: .cm-drive/perf/<CM_PERF_LABEL>.json com o resumo do renderer por fase,
// as linhas [perf] do main e o estado da GPU. Não há PASS/FAIL: é baseline.
//
// Env:
//   CM_PERF_GPU=on|off     fixa gpu.disabled na cópia (default on; a cópia do
//                          perfil real herdaria o que o app gravou sozinho)
//   CM_PERF_SESSIONS=N     sessões stub vivas (default 5, mínimo 2)
//   CM_PERF_LABEL=nome     nome do arquivo de saída (default gpu-<on|off>)
//   CM_PERF_TRANSCRIPT=p   JSONL real a usar como transcript de A (default:
//                          sintético, CM_PERF_TURNS turnos, default 300)
//   CM_PERF_DUMP_RAW=1     inclui a amostra bruta do coletor no JSON
// Rodar (depois de npm run rebuild:native && npm run build):
//   CM_PERF_GPU=on npx tsx e2e/scenarios/perf-chat-typing.ts

const GPU = process.env.CM_PERF_GPU === 'off' ? 'off' : 'on'
const SESSIONS = Math.max(2, Number(process.env.CM_PERF_SESSIONS) || 5)
const LABEL = process.env.CM_PERF_LABEL ?? `gpu-${GPU}`
const REAL_TRANSCRIPT = process.env.CM_PERF_TRANSCRIPT
const TURNS = Number(process.env.CM_PERF_TURNS) || 300
const OUT_DIR = join(REPO_ROOT, '.cm-drive', 'perf')
const OUT_FILE = join(OUT_DIR, `${LABEL}.json`)
mkdirSync(OUT_DIR, { recursive: true })

const TYPED = 'the quick brown fox jumps over the lazy dog '.repeat(5).slice(0, 200)
const KEY_DELAY_MS = 30
const APPEND_EVERY_MS = 100
const IDLE_MS = 20_000
const TAB_SWITCHES = 8
// Janela do main (10 s) mais folga: a última fase precisa caber numa linha [perf].
const MAIN_FLUSH_MS = 11_000

const log = (msg: string) => console.log(`[perf-typing] ${msg}`)
const fake = createFakeHome({ parentDir: tmpdir() })
const noiseFlag = join(fake.root, 'noise')

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub vivo: grava o session file como 'idle', ecoa o stdin e, enquanto o arquivo
// `noise` existir, emite ~5 linhas de saída por segundo (carga de pty:data sem
// passar por nenhum IPC do renderer, que sujaria a contagem de sessions:write).
function noisyStub(sessionsDir: string, logDir: string): string {
  const rule = '─'.repeat(50)
  const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(2)
  return `#!/usr/bin/env bash
SESSIONS_DIR=${shq(sessionsDir)}
LOG=${shq(logDir)}/claude-$$.log
NOISE=${shq(noiseFlag)}
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
printf '\\u23fa Fake Claude Code (stub perf) %s\\n' "$name"
box
n=0
while true; do
  if IFS= read -t 0.2 -r line; then
    printf '\\u23fa recebido: %s\\n' "$line"
    box
  elif [ $? -le 128 ]; then
    exit 0
  elif [ -e "$NOISE" ]; then
    n=$((n+1))
    printf '\\u23fa saida %s %s\\n' "$n" ${shq(filler)}
  fi
done
`
}
const stub = join(fake.root, 'bin', 'perf-claude.sh')
writeFileSync(stub, noisyStub(fake.sessionsDir, fake.logDir))
chmodSync(stub, 0o755)

// ---------- cópia do perfil, com a GPU fixada antes do boot ----------
const userData = copyRealUserData()
const repos = (
  await queryDb<{ id: string; label: string; path: string }>(
    userData,
    'SELECT id, label, path FROM repos ORDER BY position, label',
  )
).filter((r) => r.path?.startsWith('/') && existsSync(r.path))
const labelCount = new Map<string, number>()
for (const r of repos) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)
const repo = repos.find((r) => labelCount.get(r.label) === 1)
if (!repo) throw new Error('a cópia precisa de um repo com label único')
writeCopyPrefs(userData, {
  claude_command: stub,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'gpu.disabled': JSON.stringify(GPU === 'off'),
})
log(`repo ${repo.label} · ${SESSIONS} sessões · GPU ${GPU} · saída ${OUT_FILE}`)

const { app, page, mainOutput } = await launchApp({
  userDataDir: userData,
  env: { ...fake.env, CM_PERF: '1' },
})
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w?.unmaximize()
  w?.setSize(1600, 1000)
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  while (!(await fn().catch(() => false))) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout esperando: ${label}`)
    await page.waitForTimeout(250)
  }
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const visible = (selector: string) => page.locator(selector).filter({ visible: true }).first()
const toggleMode = (to: 'Chat' | 'Terminal') =>
  page.getByLabel(`Mudar para ${to}`, { exact: true }).filter({ visible: true }).first().click()
const gpuStatus = () => page.evaluate(() => window.api.gpu.status())

// Abre uma sessão pela UI (Ctrl+N) e devolve o session file que o stub gravou.
async function openSession(): Promise<FakeSessionEntry> {
  const before = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(repo!.label)
  await search.press('Enter')
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()
  let file: FakeSessionEntry | undefined
  await waitFor('session file da sessão aberta', async () => {
    file = files().find((f) => !before.has(f.data.pid))
    return !!file
  })
  await visible('.xterm-screen').waitFor({ timeout: 20_000 })
  return file!
}

const startedAt = new Date().toISOString()
const clock: Array<{ phase: string; at: string }> = []
async function phase(name: string): Promise<void> {
  log(`fase ${name}`)
  clock.push({ phase: name, at: new Date().toISOString() })
  await markPerf(page, name)
}

let fatal: unknown = null
let appendedLines = 0
const out: Record<string, unknown> = { label: LABEL, startedAt, sessions: SESSIONS }
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  if (!(await page.evaluate(() => window.api.perf.enabled))) {
    throw new Error('CM_PERF=1 não chegou ao renderer (window.api.perf.enabled é false)')
  }
  const gpuAtStart = await gpuStatus()
  out.gpu = { requested: GPU, atStart: gpuAtStart }
  await installPerfProbe(page)
  await goToArea(page, 'projects')

  // ---------- sessões: B e A com aba, o resto só vivo (carga) ----------
  await openSession()
  const fileA = await openSession()
  for (let i = 2; i < SESSIONS; i++) {
    await page.evaluate(({ repoId, name }) => window.api.sessions.spawn({ repoId, name }), {
      repoId: repo.id,
      name: `perf-carga-${i}`,
    })
  }
  await waitFor(`${SESSIONS} session files`, async () => files().length >= SESSIONS)

  // ---------- transcript de A, no disco antes de o chat abrir ----------
  const projectDir = join(fake.home, '.claude', 'projects', 'perf')
  mkdirSync(projectDir, { recursive: true })
  const transcript = join(projectDir, `${fileA.data.sessionId}.jsonl`)
  // As linhas do stream vêm do mesmo gerador: os uuids seguem a numeração do
  // transcript sintético e não colidem com os de um transcript real.
  const all = buildLongMotherLines(TURNS + 120)
  const baseCount = buildLongMotherLines(TURNS).length
  if (REAL_TRANSCRIPT) copyFileSync(REAL_TRANSCRIPT, transcript)
  else writeFileSync(transcript, all.slice(0, baseCount).join('\n') + '\n')
  out.transcript = {
    source: REAL_TRANSCRIPT ? 'real' : `sintético (${TURNS} turnos)`,
    bytes: statSync(transcript).size,
  }
  const stream = all.slice(baseCount)

  const pidA = fileA.data.pid
  function startLoad(): () => void {
    writeFileSync(noiseFlag, '')
    fake.setStatus(pidA, 'busy')
    const timer = setInterval(() => {
      const line = stream[appendedLines]
      if (!line) return
      appendFileSync(transcript, line + '\n')
      appendedLines += 1
    }, APPEND_EVERY_MS)
    return () => {
      clearInterval(timer)
      rmSync(noiseFlag, { force: true })
      fake.setStatus(pidA, 'idle')
    }
  }

  // ---------- open ----------
  await page.waitForTimeout(2000)
  await phase('open')
  const openStart = Date.now()
  await toggleMode('Chat')
  await visible('.markdown-body').waitFor({ timeout: 120_000 })
  // Inclui a ida e volta do Playwright (poucos ms): serve para comparar rodadas.
  out.openMs = Date.now() - openStart
  await page.waitForTimeout(2000)

  // ---------- chat-typing ----------
  await visible('textarea:not(.xterm-helper-textarea):not([disabled])').click()
  let stopLoad = startLoad()
  await phase('chat-typing')
  await page.keyboard.type(TYPED, { delay: KEY_DELAY_MS })
  await page.waitForTimeout(500)
  stopLoad()

  // ---------- terminal-typing ----------
  await phase('to-terminal')
  await toggleMode('Terminal')
  await visible('.xterm-screen').click()
  await page.waitForTimeout(1500)
  stopLoad = startLoad()
  await phase('terminal-typing')
  await page.keyboard.type(TYPED, { delay: KEY_DELAY_MS })
  await page.waitForTimeout(500)
  stopLoad()

  // ---------- idle ----------
  await phase('to-chat')
  await toggleMode('Chat')
  await visible('.markdown-body').waitFor({ timeout: 120_000 })
  // O que ainda está assentando (última rajada do transcript, batch de atividade)
  // não é "ocioso".
  await page.waitForTimeout(5000)
  await phase('idle')
  await page.waitForTimeout(IDLE_MS)

  // ---------- tab-switch ----------
  await phase('tab-switch')
  for (let i = 0; i < TAB_SWITCHES; i++) {
    await page.keyboard.press('Control+Tab')
    await page.waitForTimeout(700)
  }

  const raw = await collectPerf(page)
  out.gpu = {
    requested: GPU,
    atStart: gpuAtStart,
    atEnd: await gpuStatus(),
    features: await app.evaluate(({ app }) => app.getGPUFeatureStatus()),
  }
  out.phases = summarizePerf(raw).map((summary, i) => ({ startedAt: clock[i].at, ...summary }))
  if (process.env.CM_PERF_DUMP_RAW === '1') out.raw = raw
  await page.waitForTimeout(MAIN_FLUSH_MS)
} catch (err) {
  fatal = err
  console.error('[perf-typing] erro fatal:', err)
  await page.screenshot({ path: join(OUT_DIR, `${LABEL}-fatal.png`) }).catch(() => {})
}

const main = parsePerfLines(mainOutput())
const proc = app.process()
await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
try {
  proc.kill('SIGKILL')
} catch {
  // já saiu
}
fake.cleanup()

out.appendedLines = appendedLines
out.main = main
if (fatal) out.error = String(fatal)
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2))
log(`${main.length} linha(s) [perf] do main · JSON em ${OUT_FILE}`)
if (fatal) process.exit(1)
