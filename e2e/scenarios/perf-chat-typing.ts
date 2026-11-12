import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator } from 'playwright'
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
  typeOpenLoop,
  withMainLines,
  type OpenLoopTyping,
  type PerfPhaseSummary,
} from '../driver/perf'

// Medição de desempenho antes/depois (plano A1), sobre a CÓPIA do perfil real com
// HOME fake e stubs do `claude`. Uma sessão A recebe um transcript grande e passa
// pelas fases; B divide o grupo com ela como ABA (só uma das duas aparece) e as
// demais só existem para dar carga (saída de PTY e batch de atividade), como no
// uso real com várias sessões vivas.
//   open             alterna A para o chat com o transcript já no disco
//   chat-typing      transcript crescendo a cada 100 ms + PTYs emitindo saída,
//                    enquanto 200 caracteres entram no composer a 30 ms
//   to-terminal      alterna A para o terminal (sem carga)
//   terminal-typing  a mesma carga, digitando no xterm de A
//   to-chat          volta A para o chat e deixa assentar (sem carga)
//   idle             20 s sem nada acontecendo, com o chat de A montado
//   tab-switch       clique alternado nas abas de B e de A
// Todo seletor é preso ao pane de A (ou de B): com mais de uma sessão na tela, o
// "primeiro visível da página" é de quem vier antes no DOM. A digitação é em laço
// aberto (ver typeOpenLoop). Cada marca de fase fecha a janela da sonda do main,
// então as linhas [perf] dele saem dentro da fase.
// Saída: .cm-drive/perf/<CM_PERF_LABEL>.json. Não há PASS/FAIL de desempenho: é
// baseline. O cenário só falha quando a medida não valeria (pane ou foco errado,
// GPU diferente da pedida, aba que não trocou).
//
// Env:
//   CM_PERF_GPU=on|off         fixa gpu.disabled na cópia (default on; a cópia do
//                              perfil real herdaria o que o app gravou sozinho)
//   CM_PERF_SESSIONS=N         sessões stub vivas (default 5, mínimo 2)
//   CM_PERF_LABEL=nome         nome do arquivo de saída (default gpu-<on|off>)
//   CM_PERF_TRANSCRIPT_MB=N    tamanho do transcript sintético de A (default 60,
//                              a ordem de grandeza do sintoma)
//   CM_PERF_TRANSCRIPT=p       JSONL real a usar no lugar do sintético
//   CM_PERF_DUMP_RAW=1         inclui a amostra bruta do coletor no JSON
// Rodar (depois de npm run rebuild:native && npm run build):
//   CM_PERF_GPU=on npx tsx e2e/scenarios/perf-chat-typing.ts

const GPU = process.env.CM_PERF_GPU === 'off' ? 'off' : 'on'
const SESSIONS = Math.max(2, Number(process.env.CM_PERF_SESSIONS) || 5)
const LABEL = process.env.CM_PERF_LABEL ?? `gpu-${GPU}`
const REAL_TRANSCRIPT = process.env.CM_PERF_TRANSCRIPT
const TRANSCRIPT_MB = Number(process.env.CM_PERF_TRANSCRIPT_MB) || 60
const OUT_DIR = join(REPO_ROOT, '.cm-drive', 'perf')
const OUT_FILE = join(OUT_DIR, `${LABEL}.json`)
mkdirSync(OUT_DIR, { recursive: true })

const TYPED = 'the quick brown fox jumps over the lazy dog '.repeat(5).slice(0, 200)
const KEY_DELAY_MS = 30
const APPEND_EVERY_MS = 100
// Turnos a mais do gerador, gravados aos poucos enquanto as fases de digitação rodam.
const STREAM_TURNS = 120
const IDLE_MS = 20_000
const TAB_SWITCHES = 8
const CHAT_READY_TIMEOUT_MS = 180_000

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

// Herdado do shell, desligaria a GPU por baixo do modo pedido: o main olha esta
// variável antes da pref. O launchApp repassa o process.env de quem o chama.
delete process.env.CM_DISABLE_GPU
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
const gpuStatus = () => page.evaluate(() => window.api.gpu.status())
const live = () =>
  page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<
    Array<{ id: string; ccSessionId: string }>
  >

// Uma sessão com aba: o session file do stub, o pane dela e a aba no dockview.
interface Opened {
  label: 'A' | 'B'
  file: FakeSessionEntry
  pane: Locator
  tab: Locator
}

// O pane de UMA sessão, pelo id (data-session-id na raiz do Terminal). Sem
// `.first()`: se dois elementos casarem, o Playwright falha em vez de escolher.
const paneOf = (sessionId: string): Locator =>
  page.locator(`[data-testid="session-pane"][data-session-id="${sessionId}"]`)

async function opened(label: Opened['label'], before: Set<number>, tabIndex: number) {
  let file: FakeSessionEntry | undefined
  let sessionId = ''
  await waitFor(`session file e sessão viva de ${label}`, async () => {
    file = files().find((f) => !before.has(f.data.pid))
    if (!file) return false
    sessionId = (await live()).find((s) => s.ccSessionId === file!.data.sessionId)?.id ?? ''
    return sessionId !== ''
  })
  const pane = paneOf(sessionId)
  await pane.locator('.xterm-screen').waitFor({ state: 'visible', timeout: 20_000 })
  const session: Opened = { label, file: file!, pane, tab: page.locator('.dv-tab').nth(tabIndex) }
  return session
}

// Primeira sessão, pela UI (Ctrl+N): é o primeiro painel do dockview.
async function openFirstSession(): Promise<Opened> {
  const before = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(repo!.label)
  await search.press('Enter')
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()
  return opened('B', before, 0)
}

// Segunda sessão como ABA no mesmo grupo da ativa (Ctrl+T, pane.newTab). Sem isto
// as duas ficariam em split e "trocar de aba" só moveria o foco.
async function openTabSession(): Promise<Opened> {
  const before = new Set(files().map((f) => f.data.pid))
  // O atalho é ouvido no window; com o foco no xterm a tecla pode nem chegar lá.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+t')
  return opened('A', before, 1)
}

// `shown` é o painel ativo do grupo e `hidden` saiu da tela (o dockview mantém o
// painel inativo montado, com visibility: hidden).
async function expectShown(shown: Opened, hidden: Opened): Promise<void> {
  try {
    await shown.pane.waitFor({ state: 'visible', timeout: 5000 })
    await hidden.pane.waitFor({ state: 'hidden', timeout: 5000 })
  } catch {
    throw new Error(
      `troca de aba não aconteceu: esperava o pane de ${shown.label} visível e o de ${hidden.label} oculto (as duas sessões estão no mesmo grupo?)`,
    )
  }
  const active = await shown.tab.evaluate((el) => el.classList.contains('dv-active-tab'))
  if (!active) throw new Error(`a aba de ${shown.label} não ficou ativa no dockview`)
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
let summaries: Array<PerfPhaseSummary & { startedAt: string; typing?: OpenLoopTyping }> | null =
  null
const out: Record<string, unknown> = { label: LABEL, startedAt, sessions: SESSIONS }
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  if (!(await page.evaluate(() => window.api.perf.enabled))) {
    throw new Error('CM_PERF=1 não chegou ao renderer (window.api.perf.enabled é false)')
  }
  const gpuAtStart = await gpuStatus()
  if (gpuAtStart.hwAccelDisabled !== (GPU === 'off')) {
    throw new Error(
      `GPU pedida "${GPU}", mas o app subiu com hwAccelDisabled=${gpuAtStart.hwAccelDisabled}: o arquivo ${LABEL}.json mediria o modo errado`,
    )
  }
  const gpu = {
    requested: GPU,
    atStart: gpuAtStart,
    // O que está em vigor: o pedido do app ao Chromium e a sessão gráfica que ele
    // encontrou (com o hint `auto`, é ela que decide entre Wayland e X11).
    ozone: {
      waylandHint: gpuAtStart.ozoneWayland,
      ...(await app.evaluate(({ app }) => ({
        platformHintSwitch: app.commandLine.getSwitchValue('ozone-platform-hint'),
        platformSwitch: app.commandLine.getSwitchValue('ozone-platform'),
      }))),
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
    },
  }
  out.gpu = gpu
  await installPerfProbe(page)
  await goToArea(page, 'projects')

  // ---------- sessões: B e A como abas do mesmo grupo, o resto só vivo (carga) ----------
  const B = await openFirstSession()
  const A = await openTabSession()
  const tabs = await page.locator('.dv-tab').count()
  if (tabs !== 2) throw new Error(`esperava 2 abas no dockview (B e A), achei ${tabs}`)
  await expectShown(A, B)
  for (let i = 2; i < SESSIONS; i++) {
    await page.evaluate(({ repoId, name }) => window.api.sessions.spawn({ repoId, name }), {
      repoId: repo.id,
      name: `perf-carga-${i}`,
    })
  }
  await waitFor(`${SESSIONS} session files`, async () => files().length >= SESSIONS)

  // ---------- A: seletores presos ao pane dela ----------
  const composerA = A.pane.locator('textarea:not(.xterm-helper-textarea):not([disabled])')
  const FOCUS = {
    composer: 'textarea:not(.xterm-helper-textarea)',
    xterm: '.xterm-helper-textarea',
  }

  // A no modo esperado E o foco no composer/xterm DELA. Uma tecla que caísse em
  // outro pane ainda produziria um JSON sem erro nenhum.
  async function expectA(mode: 'chat' | 'terminal', focus: keyof typeof FOCUS): Promise<void> {
    const read = () =>
      A.pane.evaluate((root, selector) => {
        const active = document.activeElement
        return {
          mode: root.getAttribute('data-pane-mode'),
          focused: !!active && root.contains(active) && active.matches(selector),
          active: active ? `${active.tagName.toLowerCase()}.${active.getAttribute('class')}` : '-',
        }
      }, FOCUS[focus])
    const started = Date.now()
    let state = await read()
    while (state.mode !== mode || !state.focused) {
      if (Date.now() - started > 5000) {
        throw new Error(
          `pane de A fora do esperado: modo "${state.mode}" (esperado "${mode}"), foco em <${state.active}> (esperado o ${focus} de A)`,
        )
      }
      await page.waitForTimeout(100)
      state = await read()
    }
  }

  async function toggleA(to: 'Chat' | 'Terminal'): Promise<void> {
    await A.pane.getByLabel(`Mudar para ${to}`, { exact: true }).click()
    const mode = to.toLowerCase()
    await waitFor(
      `pane de A em modo ${mode}`,
      async () => (await A.pane.getAttribute('data-pane-mode')) === mode,
      10_000,
    )
  }

  // Pronto = a última mensagem do transcript pintada e o esqueleto de carregamento
  // fora da tela. Sem saber qual é a última (transcript real, ou depois de a carga
  // ter acrescentado linhas), vale o último bloco de markdown.
  async function waitChatReady(lastMessage: string | null): Promise<void> {
    const body = A.pane.locator('.markdown-body')
    const painted = lastMessage ? body.filter({ hasText: lastMessage }) : body
    await painted.last().waitFor({ state: 'visible', timeout: CHAT_READY_TIMEOUT_MS })
    await A.pane
      .getByTestId('chat-loading')
      .waitFor({ state: 'hidden', timeout: CHAT_READY_TIMEOUT_MS })
  }

  const cdp = await page.context().newCDPSession(page)
  const typing: Record<string, OpenLoopTyping> = {}
  async function typeIntoA(
    phaseName: string,
    mode: 'chat' | 'terminal',
    focus: keyof typeof FOCUS,
  ): Promise<void> {
    await expectA(mode, focus)
    const result = await typeOpenLoop(
      (method, params) => cdp.send(method, params as never),
      TYPED,
      KEY_DELAY_MS,
    )
    if (result.failed > 0) {
      throw new Error(`${phaseName}: o CDP recusou ${result.failed} de ${result.keys} teclas`)
    }
    // O foco não pode ter saído de A no meio da digitação.
    await expectA(mode, focus)
    typing[phaseName] = result
  }

  // ---------- transcript de A, no disco antes de o chat abrir ----------
  const projectDir = join(fake.home, '.claude', 'projects', 'perf')
  mkdirSync(projectDir, { recursive: true })
  const transcript = join(projectDir, `${A.file.data.sessionId}.jsonl`)
  // As linhas que a carga acrescenta vêm do mesmo gerador: no sintético os uuids
  // continuam a numeração do transcript; num real, não colidem com os dele.
  let stream: string[]
  let lastMessage: string | null = null
  if (REAL_TRANSCRIPT) {
    copyFileSync(REAL_TRANSCRIPT, transcript)
    stream = buildLongMotherLines(STREAM_TURNS)
    out.transcript = {
      source: 'real',
      bytes: statSync(transcript).size,
      messages: readFileSync(transcript, 'utf8').split('\n').filter(Boolean).length,
    }
  } else {
    const turnBytes = Buffer.byteLength(buildLongMotherLines(1).join('\n')) + 1
    const turns = Math.ceil((TRANSCRIPT_MB * 1024 * 1024) / turnBytes)
    const all = buildLongMotherLines(turns + STREAM_TURNS)
    const baseCount = (all.length / (turns + STREAM_TURNS)) * turns
    writeFileSync(transcript, all.slice(0, baseCount).join('\n') + '\n')
    stream = all.slice(baseCount)
    // Texto final do último turno do gerador (buildLongMotherLines).
    lastMessage = `pronto ${turns - 1}.`
    out.transcript = {
      source: 'sintético',
      targetMb: TRANSCRIPT_MB,
      turns,
      bytes: statSync(transcript).size,
      messages: baseCount,
    }
  }
  log(`transcript de A: ${JSON.stringify(out.transcript)}`)

  const pidA = A.file.data.pid
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
  await toggleA('Chat')
  await waitChatReady(lastMessage)
  // Inclui a ida e volta do Playwright (poucos ms): serve para comparar rodadas.
  out.openMs = Date.now() - openStart
  await page.waitForTimeout(2000)

  // ---------- chat-typing ----------
  await composerA.click()
  let stopLoad = startLoad()
  await phase('chat-typing')
  await typeIntoA('chat-typing', 'chat', 'composer')
  await page.waitForTimeout(500)
  stopLoad()
  const typedInComposer = await composerA.inputValue()
  if (typedInComposer !== TYPED) {
    throw new Error(
      `o composer de A ficou com ${typedInComposer.length} de ${TYPED.length} caracteres digitados`,
    )
  }

  // ---------- terminal-typing ----------
  await phase('to-terminal')
  await toggleA('Terminal')
  await A.pane.locator('.xterm-screen').click()
  await page.waitForTimeout(1500)
  stopLoad = startLoad()
  await phase('terminal-typing')
  await typeIntoA('terminal-typing', 'terminal', 'xterm')
  await page.waitForTimeout(500)
  stopLoad()

  // ---------- idle ----------
  await phase('to-chat')
  await toggleA('Chat')
  await waitChatReady(null)
  // O que ainda está assentando (última rajada do transcript, batch de atividade)
  // não é "ocioso".
  await page.waitForTimeout(5000)
  await phase('idle')
  await page.waitForTimeout(IDLE_MS)

  // ---------- tab-switch ----------
  // Clique na aba, como o usuário: A sai da tela e volta a cada par de trocas.
  await expectShown(A, B)
  await phase('tab-switch')
  for (let i = 0; i < TAB_SWITCHES; i++) {
    const [to, from] = i % 2 === 0 ? [B, A] : [A, B]
    await to.tab.locator('.dv-default-tab-content').click()
    await expectShown(to, from)
    await page.waitForTimeout(700)
  }

  const raw = await collectPerf(page)
  out.gpu = {
    ...gpu,
    atEnd: await gpuStatus(),
    features: await app.evaluate(({ app }) => app.getGPUFeatureStatus()),
  }
  summaries = summarizePerf(raw).map((summary, i) => ({
    startedAt: clock[i].at,
    ...summary,
    ...(typing[summary.phase] ? { typing: typing[summary.phase] } : {}),
  }))
  if (process.env.CM_PERF_DUMP_RAW === '1') out.raw = raw
  // O drain de cada marca já foi confirmado pelo main; falta o stdout dele chegar.
  await page.waitForTimeout(1000)
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
if (summaries) {
  // Cada linha do main vai para a fase que a etiquetou (drain do markPerf).
  out.phases = withMainLines(summaries, main)
  const phaseNames = new Set(summaries.map((s) => s.phase))
  // Boot e abertura das sessões (sem etiqueta) e o que saiu depois do fim.
  out.mainOutsidePhases = main.filter((line) => !line.phase || !phaseNames.has(line.phase))
} else {
  // Morreu antes do resumo: as linhas ficam soltas, cada uma com a fase dela.
  out.main = main
}
if (fatal) out.error = String(fatal)
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2))
log(`${main.length} linha(s) [perf] do main · JSON em ${OUT_FILE}`)
if (fatal) process.exit(1)
