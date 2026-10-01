import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Locator } from 'playwright'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'
import { PERMISSION_FIXTURE, attentionClaudeStub } from './attention-reason'

// Jornada do Mission Control sobre a CÓPIA do perfil real (projetos, repos e
// prefs reais), com HOME fake + stubs do `claude` para as sessões:
//   A (projeto 1, Ctrl+N, com aba) · B (projeto 2, sem aba, menu REAL de
//   permissão) · C (filha de A via MCP session_handoff, no repo de B).
// Passos: Alt+A → B e Aprovar inline · Ctrl+Shift+Enter → @A + #arquivo ·
// Alt+. de A → C · Ctrl+Shift+G mapa (lanes, cartões vivos, fio, indicadores) ·
// recolher B, terminal em C · nota e grupo · agent_ask C → repo de A em Conversas
// e no mapa · zero erros de console · [drive-safe] no log e zero git pull.
// Os stubs só escrevem no HOME fake; nunca tocam os repos. Nenhuma API é chamada.
// Rodar: JOURNEY_SHOTS=<dir> npx tsx e2e/scenarios/mission-control-journey.ts

const SHOTS = process.env.JOURNEY_SHOTS ?? join(tmpdir(), `journey-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0
const shotPath = (name: string) => join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub "vivo" (o mesmo de session-canvas.ts): caixa de input ociosa, eco do
// stdin e o que o cenário largar em tick-<pid>.txt vira saída ao vivo.
function liveStub(sessionsDir: string, logDir: string): string {
  const rule = '─'.repeat(50)
  return `#!/usr/bin/env bash
SESSIONS_DIR=${shq(sessionsDir)}
LOGDIR=${shq(logDir)}
LOG="$LOGDIR/claude-$$.log"
TRIG="$LOGDIR/tick-$$.txt"
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
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"busy","name":"%s","startedAt":%s,"updatedAt":%s}' \\
  "$$" "$session_id" "$PWD" "$name" "$now" "$now" > "$SESSIONS_DIR/$$.json"
box() { printf '\\n%s\\n\\u276f \\n%s\\n' ${shq(rule)} ${shq(rule)}; }
printf '\\u256d\\u2500 Fake Claude Code (stub e2e)\\n'
printf '\\u2502  sessao: %s\\n' "$session_id"
printf '\\u2502  nome:   %s\\n' "$name"
printf '\\u2570\\u2500\\n'
box
( while sleep 0.4; do
    if [ -f "$TRIG" ]; then cat "$TRIG"; rm -f "$TRIG"; box; fi
  done ) &
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

// Um só claude_command: "perm-*" desenha o menu REAL de permissão; o resto é vivo.
function installStubs(f: FakeHome): string {
  const bin = join(f.root, 'bin')
  const live = join(bin, 'live-claude.sh')
  const perm = join(bin, 'attention-claude.sh')
  const dispatch = join(bin, 'dispatch-claude.sh')
  writeFileSync(live, liveStub(f.sessionsDir, f.logDir))
  writeFileSync(perm, attentionClaudeStub(f.sessionsDir, f.logDir, PERMISSION_FIXTURE))
  writeFileSync(
    dispatch,
    `#!/usr/bin/env bash
name=''
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[$i]}" in -n|--name) name="\${args[$((i+1))]}" ;; esac
done
case "$name" in
  perm-*) exec ${shq(perm)} "$@" ;;
  *) exec ${shq(live)} "$@" ;;
esac
`,
  )
  for (const p of [live, perm, dispatch]) chmodSync(p, 0o755)
  return dispatch
}
const dispatchStub = installStubs(fake)

const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[journey] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
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
  project_id: string
  project: string
}
const repos = (
  await queryDb<RepoRow>(
    userData,
    `SELECT r.id, r.label, r.path, r.project_id, p.name AS project
       FROM repos r JOIN projects p ON p.id = r.project_id ORDER BY p.position, r.position`,
  )
).filter((r) => r.path?.startsWith('/') && existsSync(r.path))
const labelCount = new Map<string, number>()
for (const r of repos) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)
const unique = repos.filter((r) => labelCount.get(r.label) === 1)
const repo1 = unique[0]
const repo2 = unique.find((r) => r.project_id !== repo1?.project_id)
if (!repo1 || !repo2)
  throw new Error('a cópia precisa de 2 repos (labels únicos) em projetos diferentes')
console.log(
  `[journey] projeto 1: ${repo1.project}/${repo1.label} · projeto 2: ${repo2.project}/${repo2.label}`,
)
// Um arquivo real do repo de A para o #arquivo (só o nome é lido, nada é escrito).
const fileInRepo1 =
  ['README.md', 'package.json', 'CLAUDE.md'].find((f) => existsSync(join(repo1.path, f))) ??
  readdirSync(repo1.path).find(
    (f) => !f.startsWith('.') && statSync(join(repo1.path, f)).isFile(),
  ) ??
  'README.md'
const pullRunsBefore = (
  await queryDb<{ n: number }>(userData, 'SELECT COUNT(*) AS n FROM repo_pull_runs')
)[0]?.n

writeCopyPrefs(userData, {
  claude_command: dispatchStub,
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
      console.log(`[journey] timeout esperando: ${label}`)
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(400)
  }
}

async function dismissIntro(): Promise<void> {
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 10; i++) {
    if (await skip.count()) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await skip.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
      return
    }
    await page.waitForTimeout(300)
  }
}

async function closeOverlays(): Promise<void> {
  for (let i = 0; i < 4 && (await page.getByRole('dialog').count()) > 0; i++) {
    await page.keyboard.press('Escape')
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

interface Live {
  id: string
  ccSessionId: string
  status: string
  attentionReason?: string
}
const live = () => page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<Live[]>
const graph = () => page.evaluate(() => window.api.sessionGraph.get())
const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const fileOf = (cc: string) => files().find((f) => f.data.sessionId === cc)
const stdinOf = (pid: number | undefined) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return pid && existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const permLog = () =>
  readdirSync(fake.logDir)
    .filter((f) => f.startsWith('attention-claude-'))
    .map((f) => readFileSync(join(fake.logDir, f), 'utf8'))
    .join('')
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)

async function sessionIdOf(cc: string): Promise<string> {
  let id = ''
  await waitFor(`sessions.id de ${cc}`, async () => {
    id = (await live()).find((s) => s.ccSessionId === cc)?.id ?? ''
    return id !== ''
  })
  return id
}

async function newSessionFile(
  before: Set<number>,
  label: string,
): Promise<FakeSessionEntry | undefined> {
  let created: FakeSessionEntry | undefined
  await waitFor(label, async () => {
    created = files().find((f) => !before.has(f.data.pid))
    return !!created
  })
  return created
}

// O dockview monta o conteúdo das panes num overlay: a pane ativa é decidida pela
// geometria do grupo ativo.
async function activeXterm(): Promise<Locator | null> {
  const group = await page.locator('.dv-active-group').boundingBox()
  if (!group) return null
  const found = page.locator('.xterm:visible')
  for (let i = 0; i < (await found.count()); i++) {
    const box = await found.nth(i).boundingBox()
    if (!box) continue
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    if (cx > group.x && cx < group.x + group.width && cy > group.y && cy < group.y + group.height)
      return found.nth(i)
  }
  return null
}

async function bringIntoView(target: Locator): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const box = await target.boundingBox()
    const mapBox = await page.getByTestId('session-map').boundingBox()
    const bar = await page.getByTestId('map-top-bar').boundingBox()
    if (!box || !mapBox) return
    const asideRight = await page.evaluate(
      () => document.querySelector('aside')?.getBoundingClientRect().right ?? 0,
    )
    const left = Math.max(mapBox.x, asideRight) + 12
    // O dock da Equipe aberto é overlay sobre o mapa: a área útil termina nele.
    const dockLeft = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="crew-dock"][data-overlay="true"]')
      return d ? d.getBoundingClientRect().left : Number.POSITIVE_INFINITY
    })
    const right = Math.min(mapBox.x + mapBox.width, dockLeft) - 12
    const top = (bar ? bar.y + bar.height : mapBox.y) + 12
    const bottom = mapBox.y + mapBox.height - 12
    if (
      box.x >= left &&
      box.x + box.width <= right &&
      box.y >= top &&
      box.y + Math.min(box.height, 200) <= bottom
    )
      return
    const dx = (left + right) / 2 - (box.x + box.width / 2)
    const dy = top + 40 - box.y
    const start = await page.evaluate(
      ({ l, r, t, b, dx, dy }) => {
        const xs: number[] = []
        const ys: number[] = []
        for (let x = l; x < r; x += 30) xs.push(x)
        for (let y = t; y < b; y += 30) ys.push(y)
        if (dx < 0) xs.reverse()
        if (dy < 0) ys.reverse()
        for (const x of xs)
          for (const y of ys)
            if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane'))
              return { x, y }
        return null
      },
      { l: left, r: right, t: top, b: bottom, dx, dy },
    )
    if (!start) return
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(
      Math.max(left, Math.min(right, start.x + dx)),
      Math.max(top, Math.min(bottom, start.y + dy)),
      { steps: 12 },
    )
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
}
const fit = async () => {
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await page.waitForTimeout(500)
}

let fatal: unknown = null
try {
  await waitReady(page)
  await dismissIntro()

  // ---------- A: Ctrl+N no projeto 1 (aba) ----------
  await goToArea(page, 'projects')
  const beforeA = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(repo1.label)
  await search.press('Enter')
  await page
    .locator('div.fixed.inset-0', { hasText: `Nova sessão · ${repo1.label}` })
    .getByRole('button', { name: 'Abrir', exact: true })
    .click()
  const fileA = await newSessionFile(beforeA, 'session file de A')
  const idA = fileA ? await sessionIdOf(fileA.data.sessionId) : ''
  check(
    !!idA && (await page.locator('.dv-tab').count()) >= 1,
    `A aberta por Ctrl+N em ${repo1.label} (com aba)`,
  )

  // ---------- C: filha de A via MCP session_handoff ----------
  const asA = await mcpAs(idA)
  const beforeC = new Set(files().map((f) => f.data.pid))
  const handoff = await asA.call<{ handoffId: string; alias: string }>('session_handoff', {
    targetRepo: repo2.label,
    task: 'Revisar o contrato do endpoint de pedidos',
    mode: 'plan',
    force: true,
  })
  const fileC = await newSessionFile(beforeC, 'session file de C')
  const idC = fileC ? await sessionIdOf(fileC.data.sessionId) : ''
  const linked = await waitFor('aresta handoff A→C no grafo', async () =>
    (await graph()).edges.some((e) => e.kind === 'handoff' && e.from === idA && e.to === idC),
  )
  check(!!handoff.handoffId && linked, `C (${handoff.alias}) nasce filha de A via session_handoff`)

  // ---------- B: filha de C no projeto 2, SEM aba (menu real de permissão) ----------
  // Filha do dock: vive no painel da Equipe, nunca vira aba (Alt+A abre o peek).
  const beforeB = new Set(files().map((f) => f.data.pid))
  const idB = await page.evaluate(
    async ({ repoId, mother }) => {
      const b = await window.api.sessions.spawn({ repoId, name: 'perm-jornada', handoffChild: true })
      const { handoff } = await window.api.handoffs.createManual({
        repoId,
        motherSessionId: mother,
        task: 'Criar o arquivo de fixture',
      })
      await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: b.id })
      return b.id
    },
    { repoId: repo2.id, mother: idC },
  )
  const fileB = await newSessionFile(beforeB, 'session file de B')
  check(!!fileB && (await page.locator('.dv-tab').count()) === 1, 'B nasce filha de C sem aba')
  const liveNow = await live()
  check(
    [idA, idB, idC].every((id) => id && liveNow.some((s) => s.id === id)),
    '3 sessões vivas em 2 projetos',
  )
  await shot('three-sessions')

  // ---------- Alt+A → B (sem aba) e Aprovar inline ----------
  const waiting = await waitFor(
    'B waiting com motivo permission',
    async () => (await live()).some((s) => s.id === idB && s.attentionReason === 'permission'),
    60_000,
  )
  check(waiting, 'B espera com motivo "permissão" (fixture real do 2.1.286)')
  const tabsBefore = await page.locator('.dv-tab').count()
  await page.keyboard.press('Alt+a')
  const pinned = page.locator('[data-testid="attention-popover"][role="dialog"]')
  const popUp = await waitFor(
    'popover fixado',
    async () => (await pinned.getByText('Quer continuar?').count()) > 0,
    10_000,
  )
  const peekB = await waitFor(
    'peek de B',
    async () => (await page.locator('[data-peek-mode]').count()) > 0,
    5000,
  )
  check(popUp && peekB, 'Alt+A leva a B (peek, sem aba nova) com o popover do motivo')
  check((await page.locator('.dv-tab').count()) === tabsBefore, 'Alt+A não criou aba')
  await shot('alt-a-permission')
  if (popUp) {
    await pinned.getByTestId('attention-action-approve').click()
    const key = await waitFor(
      'tecla 1 no stdin de B',
      async () => permLog().includes('key:31'),
      15_000,
    )
    const keys = permLog()
      .split('\n')
      .filter((l) => l.startsWith('key:'))
    check(key && keys.at(-1) === 'key:31', `Aprovar inline envia "1" (${keys.join(' ')})`)
  }
  const outOfQueue = await waitFor(
    'B sai da fila',
    async () => (await live()).find((s) => s.id === idB)?.attentionReason == null,
    20_000,
  )
  check(outOfQueue, 'B sai da fila de atenção após aprovar')
  await closeOverlays()

  // ---------- Ctrl+Shift+Enter → @A + #arquivo ----------
  // O @ lista as sessões da área Projetos; filhas da Equipe (B, C) falam pelo canal
  // do handoff (dock/peek), então o destino aqui é A, a sessão comum.
  if (fileA) fake.setStatus(fileA.data.pid, 'idle')
  await page.waitForTimeout(2500)
  await page.keyboard.press('Control+Shift+Enter')
  const input = page.getByTestId('quick-input')
  const composerUp = await waitFor(
    'compositor',
    async () => page.getByTestId('quick-composer').isVisible(),
    10_000,
  )
  check(composerUp, 'Ctrl+Shift+Enter abre o compositor flutuante')
  if (composerUp) {
    await input.click()
    await input.pressSequentially(`@${repo1.label.slice(0, 6)}`)
    let aliasA = ''
    let options: string[] = []
    const menuOk = await waitFor(
      'menu de @ com A',
      async () => {
        options = await page
          .getByTestId('mention-menu')
          .getByTestId('mention-session')
          .allInnerTexts()
        aliasA = options[0]?.match(/@([\w-]+)/)?.[1] ?? ''
        return aliasA.includes(repo1.label.toLowerCase().slice(0, 6))
      },
      5000,
    )
    check(menuOk, `menu de @ lista A (${options.map((o) => o.split('\n')[0]).join(' | ')})`)
    const crewListed = options.some((o) => o.includes(handoff.alias) || o.includes('perm-jornada'))
    console.log('[journey] filhas da Equipe no @:', crewListed)
    await input.press('Tab')
    // #arquivo escolhido no menu (o caminho digitado à mão só converte com pasta).
    await input.pressSequentially(`revise o contrato #${fileInRepo1.slice(0, 4)}`)
    const fileOpt = page.getByTestId('mention-menu').getByTestId('mention-file')
    const fileMenu = await waitFor(
      'menu de # com o arquivo',
      async () => (await fileOpt.allInnerTexts()).some((t) => t.includes(fileInRepo1)),
      10_000,
    )
    check(fileMenu, `menu de # lista ${fileInRepo1} do repo de A`)
    await fileOpt.filter({ hasText: fileInRepo1 }).first().click()
    await input.press('End')
    await input.pressSequentially(' ')
    const pillOk = await waitFor(
      'pílula de A',
      async () =>
        (await page
          .getByTestId('quick-target')
          .getByTestId('session-pill')
          .getAttribute('data-alias')) === aliasA,
      5000,
    )
    check(pillOk, `destino fixado em @${aliasA} pela @menção`)
    await shot('quick-composer')
    await input.press('Enter')
    const delivered = await waitFor(
      'stdin de A com @arquivo',
      async () => stdinOf(fileA?.data.pid).includes(`stdin: revise o contrato @${fileInRepo1}`),
      15_000,
    )
    check(delivered, `entrega em A com #${fileInRepo1} → @${fileInRepo1}`)
    check(!stdinOf(fileC?.data.pid).includes('revise o contrato'), 'C não recebeu a mensagem de A')
  }
  await closeOverlays()

  // ---------- Alt+. de A → filha C ----------
  const xterm = await activeXterm()
  if (xterm) await xterm.click()
  const hud = page.locator('[data-testid="session-link-hud"]')
  await page.keyboard.press('Alt+Period')
  const toChild = await waitFor(
    'HUD na filha',
    async () =>
      (await hud.getAttribute('data-node')) === idC &&
      (await page.locator('[data-peek-mode]').count()) > 0,
    10_000,
  )
  check(!!xterm && toChild, 'Alt+. na mãe navega para a filha (peek)')
  await shot('alt-dot-child')
  await closeOverlays()

  // ---------- Ctrl+Shift+G → mapa ----------
  if (fileC) fake.setStatus(fileC.data.pid, 'idle')
  if (fileA) fake.setStatus(fileA.data.pid, 'busy')
  await page.keyboard.press('Control+Shift+KeyG')
  const mapUp = await waitFor(
    'mapa',
    async () => page.getByTestId('session-map').isVisible(),
    10_000,
  )
  check(mapUp, 'Ctrl+Shift+G abre o mapa')
  await fit()
  const lanes = await page.getByTestId('lane-repo').allInnerTexts()
  check(
    lanes.some((t) => t.toLowerCase().includes(repo1.label.toLowerCase())) &&
      lanes.some((t) => t.toLowerCase().includes(repo2.label.toLowerCase())),
    `lanes dos 2 repos (${lanes.map((t) => t.split('\n')[0]).join(' | ')})`,
  )
  const cardsOk = await waitFor(
    'cartões de A, B, C',
    async () =>
      (await card(idA).count()) + (await card(idB).count()) + (await card(idC).count()) === 3,
  )
  check(cardsOk, 'cartões das 3 sessões no mapa')
  const views = await Promise.all([idA, idB, idC].map((id) => card(id).getAttribute('data-view')))
  check(
    views.every((v) => v === 'open'),
    `cartões abertos (${views.join(',')})`,
  )
  const edgeOk = await waitFor(
    'fio mãe→filha',
    async () =>
      (await page.locator(`.react-flow__edge[data-id="e:h:${handoff.handoffId}"]`).count()) === 1,
    10_000,
  )
  check(edgeOk, 'fio mãe→filha (A→C) desenhado')
  // Saída ao vivo: o stub de A imprime o tick.
  await bringIntoView(card(idA))
  await page.waitForTimeout(800)
  if (fileA)
    writeFileSync(join(fake.logDir, `tick-${fileA.data.pid}.txt`), 'jornada: migrando schema 7/9\n')
  const tailOk = await waitFor(
    'tail de A',
    async () =>
      (await card(idA).getByTestId('card-live-tail').innerText()).includes('migrando schema 7/9'),
    20_000,
  )
  check(tailOk, 'saída ao vivo no cartão de A')
  const tones = await waitFor(
    'indicadores',
    async () =>
      (await card(idA).getAttribute('data-tone')) === 'working' &&
      (await card(idB).getAttribute('data-tone')) === 'working' &&
      (await card(idC).getAttribute('data-tone')) === 'done',
    20_000,
  )
  const statusTxt = await Promise.all(
    [idA, idB, idC].map((id) =>
      card(id)
        .getByTestId('card-status')
        .innerText()
        .catch(() => '?'),
    ),
  )
  check(tones, `indicadores A/B/C = trabalhando/trabalhando/pronto (${statusTxt.join(' · ')})`)
  await fit()
  await shot('map-fit')

  // ---------- recolher B, terminal em C ----------
  await bringIntoView(card(idB).getByTestId('card-toggle'))
  await card(idB).getByTestId('card-toggle').click()
  const collapsed = await waitFor(
    'B recolhido',
    async () => (await card(idB).getAttribute('data-view')) === 'collapsed',
    5000,
  )
  check(collapsed, 'recolher o cartão de B')
  await fit()
  await bringIntoView(card(idC).getByTestId('card-interact'))
  await card(idC).getByTestId('card-interact').click()
  const inTerm = await waitFor(
    'C em terminal',
    async () => (await card(idC).getAttribute('data-view')) === 'terminal',
    10_000,
  )
  check(inTerm, 'abrir C em modo terminal no cartão')
  const cx = card(idC).locator('.xterm')
  await waitFor('xterm de C', async () => (await cx.count()) === 1, 10_000)
  await page.waitForTimeout(800)
  await cx.click().catch(() => {})
  await page.keyboard.type('ola da jornada')
  await page.keyboard.press('Enter')
  const typed = await waitFor(
    'digitação em C',
    async () => stdinOf(fileC?.data.pid).includes('stdin: ola da jornada'),
    10_000,
  )
  check(typed, 'digitar no terminal do cartão chega ao stdin de C')
  await shot('card-terminal-typed')
  await card(idC)
    .getByTestId('card-leave-terminal')
    .click()
    .catch(() => {})
  await waitFor(
    'C volta a aberto',
    async () => (await card(idC).getAttribute('data-view')) === 'open',
    5000,
  )

  // ---------- nota e grupo ----------
  await fit()
  const notesBefore = await page.getByTestId('canvas-note').count()
  await page.getByTitle('Nova nota solta').click()
  const noteOk = await waitFor(
    'nota nova',
    async () => (await page.getByTestId('canvas-note').count()) === notesBefore + 1,
    10_000,
  )
  const textarea = page.getByTestId('canvas-note').locator('textarea')
  if (await textarea.count()) {
    await textarea.first().fill('jornada: revisar contrato antes do deploy')
    await page.keyboard.press('Control+Enter').catch(() => {})
    await page.waitForTimeout(400)
    if (await textarea.count()) await textarea.first().blur()
  }
  await page.waitForTimeout(600)
  const noteText = (await page.getByTestId('canvas-note').allInnerTexts()).join(' | ')
  check(noteOk && noteText.includes('revisar contrato'), `criar nota (${noteText.slice(0, 60)})`)
  const groupsBefore = await page.getByTestId('user-group').count()
  await page.getByTitle('Novo grupo de sessões').click()
  const groupOk = await waitFor(
    'grupo novo',
    async () => (await page.getByTestId('user-group').count()) === groupsBefore + 1,
    10_000,
  )
  check(groupOk, 'criar grupo')
  await page.keyboard.press('Escape').catch(() => {})
  await fit()
  await shot('note-and-group')

  // ---------- agent_ask de C para o repo de A ----------
  const asC = await mcpAs(idC)
  const asked = await asC.call<{
    askId: string
    mode: string
    routedTo: { sessionId: string } | null
  }>('agent_ask', { repo: repo1.label, text: 'O schema de pedidos já tem o campo status?' })
  check(
    asked.routedTo?.sessionId === idA,
    `agent_ask de C por repo=${repo1.label} roteado para A (${asked.mode})`,
  )
  const balloon = await waitFor(
    'balão do ask no mapa',
    async () => (await page.getByTestId('edge-ask-balloon').count()) === 1,
    20_000,
  )
  check(balloon, 'mapa mostra o fio temporário com balão C→A')
  const dock = page.getByTestId('crew-dock')
  await dock.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  if ((await dock.getAttribute('data-expanded').catch(() => null)) !== 'true') {
    await page
      .getByTestId('crew-rail-conversations')
      .click()
      .catch(() => {})
  }
  await page
    .getByTestId('conversations-tab-button')
    .click()
    .catch(() => {})
  const row = page.locator(`[data-testid="conversation-row"][data-ask-id="${asked.askId}"]`)
  const rowOk = await waitFor('linha em Conversas', async () => row.isVisible(), 10_000)
  const pair = rowOk ? await row.getByTestId('conversation-pair').innerText() : ''
  check(rowOk, `Conversas mostra o ask (${pair.replace(/\s+/g, ' ')})`)
  await shot('conversations-and-map')
  if (fileA) fake.setStatus(fileA.data.pid, 'idle')
  const askDelivered = await waitFor(
    'envelope no stdin de A',
    async () => stdinOf(fileA?.data.pid).includes(`id="${asked.askId}"`),
    20_000,
  )
  check(askDelivered, 'A ociosa recebe o <pitwall-ask> no stdin')
  await mcpAs(idA).then((c) =>
    c.call('agent_reply', { askId: asked.askId, text: 'Sim, desde a v3.' }),
  )
  const gone = await waitFor(
    'balão some',
    async () => (await page.getByTestId('edge-ask-balloon').count()) === 0,
    10_000,
  )
  check(gone, 'resposta de A fecha o fio no mapa')
  await shot('answered')
} catch (err) {
  fatal = err
  console.error('[journey] erro fatal:', err)
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
await new Promise((r) => setTimeout(r, 500))
const logText = readFileSync(logs.logFile, 'utf8') + mainOutput()
check(
  logText.includes('[drive-safe]'),
  `[drive-safe] no log (${(logText.match(/\[drive-safe\][^\n]*/g) ?? []).join('; ')})`,
)
const pullRunsAfter = (
  await queryDb<{ n: number }>(userData, 'SELECT COUNT(*) AS n FROM repo_pull_runs')
)[0]?.n
check(
  pullRunsAfter === pullRunsBefore && !/pull --ff-only|Atualizando repositórios/.test(logText),
  `zero git pull (repo_pull_runs ${pullRunsBefore} → ${pullRunsAfter})`,
)
fake.cleanup()

const failed = results.filter((r) => !r.ok)
console.log('\n[journey] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(
  `[journey] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS} · log ${logs.logFile}`,
)
if (fatal || failed.length) process.exit(1)
