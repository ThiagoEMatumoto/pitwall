import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// F5 — seletor rápido de features (Ctrl+`, o "Alt+Tab" do Pitwall), sobre a CÓPIA
// do perfil real com HOME fake e stubs vivos do `claude`:
//   3 features (F1, F2, F3), cada uma com mãe Mi + filha Ci (PTYs vivas)
//   → depois do reload (nada em foco), o toque rápido vai a F3, a mais recente
//   → segurar Ctrl + `: overlay com as 3 em ordem MRU, a 2ª pré-selecionada
//   → soltar o Ctrl confirma a 2ª: o mapa enquadra o card dela e o painel da mãe
//     mostra a mãe dela; o foco fica fora do xterm
//   → toque rápido (Ctrl+` e soltar) volta para a anterior, sem overlay
//   → Esc cancela: nada muda
//   → com o foco no xterm do painel, o combo e as teclas do seletor não chegam
//     ao stdin do stub (e o digitado depois chega)
//   → fora do mapa (Terminais), confirmar leva ao mapa
// Rodar: SWITCHER_SHOTS=<dir> npx tsx e2e/scenarios/feature-switcher.ts

const SHOTS =
  process.env.SWITCHER_SHOTS ??
  '/home/thiagoematumoto/projetos/pessoal/claude-manager/.worktrees/feat-mother-panel/.cm-drive/mp/drive/MP-switcher'
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0
const shotPath = (name: string) => join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub vivo (o de mother-prominent.ts): caixa de input ociosa e eco do stdin,
// linha a linha, em claude-<pid>.log. O eco grava a linha crua (com controles).
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
    printf 'stdin: %q\\n' "$line" >> "$LOG"
    printf '\\u23fa recebido: %s\\n' "$line"
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
  console.log(`[switcher] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const repo = (
  await queryDb<{ id: string; label: string; path: string; project_id: string }>(
    userData,
    'SELECT id, label, path, project_id FROM repos ORDER BY position',
  )
).find((r) => r.path?.startsWith('/') && existsSync(r.path))
if (!repo) throw new Error('a cópia precisa de 1 repo com path absoluto existente')
console.log(`[switcher] repo: ${repo.label}`)

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
      console.log(`[switcher] timeout esperando: ${label}`)
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(300)
  }
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const pidOf = (cc: string) => files().find((f) => f.data.sessionId === cc)?.data.pid
const stdinOf = (pid: number | undefined) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return pid && existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const overlay = () => page.getByTestId('feature-switcher')
const dock = () => page.getByTestId('mother-dock')
const dockShows = () =>
  dock()
    .getAttribute('data-session-id')
    .catch(() => null)
const mru = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('cm:feature-mru') ?? '[]') as string[]
    } catch {
      return [] as string[]
    }
  })
const optionKeys = () =>
  page.locator('[data-testid="feature-switcher"] [role="option"]').evaluateAll((els) =>
    els.map((e) => ({
      key: e.getAttribute('data-key') ?? '',
      selected: e.getAttribute('aria-selected') === 'true',
      id: e.id,
    })),
  )
const activeInXterm = () => page.evaluate(() => !!document.activeElement?.closest('.xterm'))
// O card da feature enquadrado: inteiro (ou pelo menos o topo e o centro) dentro do mapa.
const framed = async (featureId: string) => {
  const lane = await page.locator(`.react-flow__node[data-id="lane:f:${featureId}"]`).boundingBox()
  const map = await page.getByTestId('session-map').boundingBox()
  if (!lane || !map) return false
  const cx = lane.x + lane.width / 2
  return (
    cx >= map.x && cx <= map.x + map.width && lane.y >= map.y - 1 && lane.y < map.y + map.height
  )
}
// Segura o Ctrl, aperta ` (n vezes) e só então decide.
async function hold(presses = 1, shift = false) {
  await page.keyboard.down('Control')
  if (shift) await page.keyboard.down('Shift')
  for (let i = 0; i < presses; i++) await page.keyboard.press('Backquote')
  if (shift) await page.keyboard.up('Shift')
}

// Spy no main de TODO sessions:write: o stub lê com `read -r` (que descarta NUL e
// só loga linhas completas), então o log do stub não prova que o Ctrl+` (NUL num
// terminal) não vazou. O que o renderer manda pra PTY, byte a byte, prova.
async function installWriteSpy(): Promise<boolean> {
  return app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Function> })
      ._invokeHandlers
    const original = handlers?.get('sessions:write')
    if (!original) return false
    const log: Array<{ id: string; data: string }> = []
    ;(globalThis as unknown as { __writeLog: typeof log }).__writeLog = log
    ipcMain.removeHandler('sessions:write')
    ipcMain.handle('sessions:write', (e, id: string, data: string) => {
      log.push({ id, data })
      return original(e, id, data)
    })
    return true
  })
}
const writesTo = (id: string | null) =>
  app.evaluate(
    (_e, sid) =>
      (
        (globalThis as unknown as { __writeLog?: Array<{ id: string; data: string }> })
          .__writeLog ?? []
      )
        .filter((w) => w.id === sid)
        .map((w) => w.data),
    id,
  )

let fatal: unknown = null
try {
  await waitReady(page)
  check(await installWriteSpy(), 'spy do IPC sessions:write instalado no main')

  // ---------- 3 features, cada uma com mãe + filha (PTYs vivas) ----------
  const mcp = await connectMcp(userData)
  const feats: Array<{
    id: string
    mother: { id: string; cc: string | null }
    childCc: string | null
  }> = []
  for (const n of [1, 2, 3]) {
    const { feature } = await mcp.call<{ feature: { id: string } }>('feature_create', {
      projectId: repo.project_id,
      title: `Seletor E2E ${n}`,
      status: 'in-progress',
      repos: [{ repoId: repo.id, branch: `feat/seletor-e2e-${n}` }],
    })
    const spawned = await page.evaluate(
      async ({ repoId, featureId, n }) => {
        const m = await window.api.sessions.spawn({ repoId, name: `mae-seletor-${n}`, featureId })
        const c = await window.api.sessions.spawn({
          repoId,
          name: `filha-seletor-${n}`,
          handoffChild: true,
          featureId,
        })
        const { handoff } = await window.api.handoffs.createManual({
          repoId,
          motherSessionId: m.id,
          task: `Tarefa ${n}`,
          featureId,
        })
        await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: c.id })
        return { mother: { id: m.id, cc: m.ccSessionId }, childCc: c.ccSessionId }
      },
      { repoId: repo.id, featureId: feature.id, n },
    )
    feats.push({ id: feature.id, ...spawned })
  }
  check(feats.length === 3, `3 features criadas (${feats.map((f) => f.id).join(', ')})`)
  check(
    await waitFor('PTYs das 6 sessões', async () =>
      feats.every((f) => [f.mother.cc, f.childCc].every((cc) => !!cc && pidOf(cc) !== undefined)),
    ),
    'mães e filhas com PTYs vivas (stub)',
  )
  const motherOf = new Map(feats.map((f) => [f.id, f.mother.id]))
  const ours = new Set(feats.map((f) => f.id))

  // MRU semeado: F3 (mais recente), F2, F1.
  await page.evaluate(
    (order) => localStorage.setItem('cm:feature-mru', JSON.stringify(order)),
    [feats[2].id, feats[1].id, feats[0].id],
  )
  await page.reload()
  await waitReady(page)
  await goToArea(page, 'projects')
  await page
    .getByTestId('projects-view-map')
    .click()
    .catch(() => {})
  check(
    await waitFor('mapa', async () => page.getByTestId('session-map').isVisible(), 15_000),
    'mapa aberto',
  )
  await waitFor('cards das 3 features', async () => {
    for (const f of feats)
      if ((await page.locator(`.react-flow__node[data-id="lane:f:${f.id}"]`).count()) === 0)
        return false
    return true
  })
  await page.waitForTimeout(800)
  // ---------- boot: nenhuma feature em foco, o toque rápido vai à mais recente ----------
  // (Regressão: abria sempre na 2ª e pulava F3, a última usada antes do reload.)
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  await page.keyboard.up('Control')
  check(
    await waitFor('toque no boot', async () => (await mru())[0] === feats[2].id, 3000),
    `sem feature em foco, o toque rápido vai à mais recente do MRU (F3; MRU ${(await mru()).slice(0, 3).join(',')})`,
  )
  await page.waitForTimeout(800)

  // ---------- segurar: overlay em ordem MRU ----------
  const mruBefore = (await mru()).filter((k) => ours.has(k))
  await hold(1)
  check(
    await waitFor('overlay', async () => overlay().isVisible(), 3000),
    'Ctrl+` segurado mostra o overlay',
  )
  const opts = (await optionKeys()).filter((o) => ours.has(o.key))
  check(
    JSON.stringify(opts.map((o) => o.key)) === JSON.stringify(mruBefore),
    `overlay na ordem MRU (${opts.map((o) => o.key).join(',')} vs ${mruBefore.join(',')})`,
  )
  const all = await optionKeys()
  check(all[1]?.selected === true, `a 2ª opção pré-selecionada (${all[1]?.key})`)
  check(
    (await page.getByRole('listbox').getAttribute('aria-activedescendant')) === all[1]?.id,
    'listbox com aria-activedescendant na selecionada',
  )
  check(
    (await overlay().locator('[data-testid="feature-switcher-mother"]').count()) >= 3,
    'cada feature mostra a mãe',
  )
  await shot('overlay-mru')
  const target = all[1].key
  const previous = all[0].key

  // ---------- soltar confirma a 2ª ----------
  await page.keyboard.up('Control')
  check(
    await waitFor('overlay some', async () => (await overlay().count()) === 0, 3000),
    'soltar o Ctrl fecha o overlay',
  )
  check((await mru())[0] === target, `MRU agora começa pela escolhida (${target})`)
  if (ours.has(target)) {
    check(
      await waitFor('card enquadrado', async () => framed(target), 5000),
      'o mapa enquadra o card da feature escolhida',
    )
    check(
      await waitFor(
        'painel com a mãe',
        async () => (await dockShows()) === motherOf.get(target),
        8000,
      ),
      `o painel mostra a mãe dela (${await dockShows()} vs ${motherOf.get(target)})`,
    )
  }
  check(!(await activeInXterm()), 'confirmar deixa o foco fora do xterm')
  await shot('confirmou-2a')

  // ---------- toque rápido volta ----------
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  await page.keyboard.up('Control')
  check((await overlay().count()) === 0, 'toque rápido não mostra o overlay')
  check(
    await waitFor('volta à anterior', async () => (await mru())[0] === previous, 3000),
    `toque rápido volta à anterior (${previous})`,
  )
  if (ours.has(previous)) {
    check(
      await waitFor(
        'painel volta',
        async () => (await dockShows()) === motherOf.get(previous),
        8000,
      ),
      'o painel volta para a mãe da anterior',
    )
  }
  await shot('toque-rapido')

  // ---------- Esc cancela ----------
  const mruBeforeEsc = await mru()
  const dockBeforeEsc = await dockShows()
  await hold(2)
  await waitFor('overlay (esc)', async () => overlay().isVisible(), 3000)
  await page.keyboard.press('Escape')
  await page.keyboard.up('Control')
  await page.waitForTimeout(600)
  check((await overlay().count()) === 0, 'Esc fecha o overlay')
  check(JSON.stringify(await mru()) === JSON.stringify(mruBeforeEsc), 'Esc não muda o MRU')
  check((await dockShows()) === dockBeforeEsc, 'Esc não troca a mãe do painel')

  // ---------- foco no xterm: o combo não chega ao stdin ----------
  const shownMother = await dockShows()
  const mPid = pidOf(feats.find((f) => f.mother.id === shownMother)?.mother.cc ?? '')
  const xterm = dock().locator('.xterm')
  if (check((await xterm.count()) === 1, 'xterm real no painel da mãe')) {
    await xterm.click()
    check(await activeInXterm(), 'foco no xterm do painel')
    const before = stdinOf(mPid)
    const writesBefore = (await writesTo(shownMother)).length
    await hold(1)
    await waitFor('overlay (xterm)', async () => overlay().isVisible(), 3000)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')
    await page.keyboard.up('Control')
    await page.waitForTimeout(300)
    const leakedWrites = (await writesTo(shownMother)).slice(writesBefore)
    check(
      leakedWrites.length === 0,
      `nenhum byte do seletor (Ctrl+\`, Tab, Esc) foi escrito na PTY (${JSON.stringify(leakedWrites)})`,
    )
    await xterm.click()
    await page.keyboard.type('depois-do-seletor')
    await page.keyboard.press('Enter')
    check(
      await waitFor(
        'stdin depois',
        async () => stdinOf(mPid).includes('depois-do-seletor'),
        10_000,
      ),
      'texto digitado depois do seletor chega ao PTY',
    )
    const added = stdinOf(mPid).slice(before.length)
    // %q do bash: NUL/Tab/ESC viram $'\000', $'\t', $'\E'; o ` sairia como \`.
    const leaked = /\$'|\\`|`/.test(added)
    check(!leaked, `Ctrl+\`/Tab/Esc do seletor não chegaram ao stdin (${JSON.stringify(added)})`)
  }

  // ---------- fora do mapa: confirmar leva ao mapa ----------
  await page.getByTestId('projects-view-terminals').click()
  check(
    await waitFor(
      'mapa fechado',
      async () => (await page.getByTestId('session-map').count()) === 0,
      5000,
    ),
    'visão Terminais sem o mapa',
  )
  await hold(1)
  await waitFor('overlay (terminais)', async () => overlay().isVisible(), 3000)
  const fromTerminals = (await optionKeys()).find((o) => o.selected)?.key ?? ''
  await shot('overlay-nos-terminais')
  await page.keyboard.up('Control')
  check(
    await waitFor('mapa de volta', async () => page.getByTestId('session-map').isVisible(), 8000),
    'confirmar fora do mapa leva ao mapa',
  )
  if (ours.has(fromTerminals)) {
    check(
      await waitFor(
        'painel (terminais)',
        async () => (await dockShows()) === motherOf.get(fromTerminals),
        8000,
      ),
      'e o painel mostra a mãe da escolhida',
    )
    check(
      await waitFor('card (terminais)', async () => framed(fromTerminals), 5000),
      'e o card dela enquadrado',
    )
  }
  await shot('fora-do-mapa')
} catch (err) {
  fatal = err
  console.error('[switcher] erro fatal:', err)
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
const logText = readFileSync(logs.logFile, 'utf8') + mainOutput()
check(logText.includes('[drive-safe]'), '[drive-safe] no log')
fake.cleanup()

const failed = results.filter((r) => !r.ok)
console.log('\n[switcher] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(
  `[switcher] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS} · log ${logs.logFile}`,
)
if (fatal || failed.length) process.exit(1)
