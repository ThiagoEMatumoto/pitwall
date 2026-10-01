import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import type { Page } from 'playwright'
import { launchApp } from '../driver/launch'
import { createFakeHome, type FakeHome } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'
import { PERMISSION_FIXTURE, attentionClaudeStub } from './attention-reason'

// Mapa de sessões (P8) com cartões VIVOS, de ponta a ponta no app buildado:
//   - o mapa mostra só as sessões em uso (encerrada some; bastão → "continua de")
//   - criar sessão pelo "+" da lane; filha pelo cartão (fio mãe→filha); filha
//     pelo session_handoff do MCP aparece ligada
//   - cartão recolher/abrir persiste (reload e relaunch)
//   - saída ao vivo atualiza quando a CLI imprime; barra de prompt entrega no stdin
//   - aprovação inline com o menu REAL de permissão do claude 2.1.286 (fixture)
//   - modo terminal: digitar no xterm do cartão chega ao stdin; um terminal por
//     vez; o zoom vai a 1.0
//   - indicadores trabalhando / precisa de você / pronto por status da sessão
//
// HOME fake + stubs do `claude` (pref claude_command): nenhuma API é chamada e o
// ~/.claude real não é tocado. Os repos seedados apontam pra pastas vazias no
// scratch. Rodar: MAP_SCRATCH=<dir> npx tsx e2e/scenarios/session-canvas.ts
// (depois de `npm run rebuild:native && npm run build`).

const require = createRequire(import.meta.url)
const SCRATCH = process.env.MAP_SCRATCH ?? mkdtempSync(join(tmpdir(), 'session-canvas-'))
const SHOTS = process.env.MAP_SHOTS ?? SCRATCH
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: SCRATCH })

const PROJECTS = [
  { id: 'map-alpha', name: 'Mapa Alpha', color: '#9d8cff' },
  { id: 'map-beta', name: 'Mapa Beta', color: '#6fd695' },
]
const REPOS = [
  { id: 'map-alpha-api', projectId: 'map-alpha', label: 'alpha-api' },
  { id: 'map-alpha-web', projectId: 'map-alpha', label: 'alpha-web' },
  { id: 'map-beta-site', projectId: 'map-beta', label: 'beta-site' },
  { id: 'map-beta-ops', projectId: 'map-beta', label: 'beta-ops' },
]

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub "vivo": grava sessions/<pid>.json (busy), desenha a caixa de input ociosa
// do 2.1.286 (a prova que a fila de envio exige), ecoa cada linha do stdin e
// imprime o que o cenário largar em tick-<pid>.txt — é a "saída ao vivo".
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

// Um só claude_command: o nome da sessão decide o stub. "perm-*" desenha o menu
// REAL de permissão (fixture do 2.1.286); o resto é o stub vivo.
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

// ---------- resultado: tabela de asserções ----------
const results: Array<{ ok: boolean; label: string }> = []
function check(cond: boolean, label: string): boolean {
  results.push({ ok: cond, label })
  console.log(`[map] ${cond ? 'ok  ' : 'FAIL'} — ${label}`)
  return cond
}
const shot = (name: string) => join(SHOTS, `${name}.png`)

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
{
  const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
  const now = Date.now()
  // Handoffs ativos herdados do perfil real barrariam o dedup do session_handoff.
  db.run(
    "UPDATE handoffs SET status = 'done' WHERE status IN ('pending','approved','running','needs_input')",
  )
  db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
  db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('claude_command', ?)", [
    dispatchStub,
  ])
  db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
  for (const [i, p] of PROJECTS.entries()) {
    db.run(
      'INSERT INTO projects (id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [p.id, p.name, p.color, -10 + i, now, now],
    )
  }
  for (const [i, r] of REPOS.entries()) {
    const path = join(SCRATCH, 'repos', r.label)
    mkdirSync(path, { recursive: true })
    db.run(
      'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [r.id, r.projectId, r.label, path, i, now],
    )
  }
  writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
  db.close()
}

type Api = {
  sessions: {
    spawn(i: unknown): Promise<{ id: string; ccSessionId: string }>
    kill(id: string): Promise<unknown>
    listLiveGlobal(): Promise<Array<{ id: string; status: string; attentionReason?: string }>>
  }
  handoffs: {
    createManual(i: unknown): Promise<{ handoff: { id: string } }>
    markRunning(i: unknown): Promise<unknown>
  }
  baton: { pass(i: unknown): Promise<{ session: { id: string } }> }
  sessionGraph: {
    get(): Promise<{
      nodes: Array<Record<string, unknown>>
      edges: Array<{ kind: string; from: string; to: string; handoffId?: string }>
    }>
  }
}

const pageErrors: string[] = []
function attachErrors(page: Page): void {
  page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
  })
}

let { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
attachErrors(page)

async function dismissIntro(): Promise<void> {
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 30; i++) {
    if (await skip.count()) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await skip.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
      return
    }
    await page.waitForTimeout(500)
  }
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      console.log(`[map] timeout esperando: ${label}`)
      return false
    }
    await page.waitForTimeout(400)
  }
}

// page.evaluate com funções explícitas: a CSP do renderer barra eval.
const graph = () =>
  page.evaluate(async () => (window as unknown as { api: Api }).api.sessionGraph.get())
const liveIds = async () =>
  new Set(
    (
      await page.evaluate(async () =>
        (window as unknown as { api: Api }).api.sessions.listLiveGlobal(),
      )
    ).map((s) => s.id),
  )

const card = (sessionId: string) =>
  page.locator(`[data-testid="session-card"][data-session-id="${sessionId}"]`)
const mapCardIds = async () =>
  page
    .getByTestId('session-card')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id') ?? ''))
const viewportScale = () =>
  page
    .locator('.react-flow__viewport')
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
const pidOf = (cc: string) => fake.readSessionFiles().find((f) => f.data.sessionId === cc)?.data.pid
const stdinLog = () => fake.readCliLog('claude')
const permLog = () =>
  readdirSync(fake.logDir)
    .filter((f) => f.startsWith('attention-claude-'))
    .map((f) => readFileSync(join(fake.logDir, f), 'utf8'))
    .join('')

async function fit(): Promise<void> {
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForTimeout(500)
}
async function zoom100(): Promise<void> {
  await page.getByTestId('map-zoom-100').click()
  await page.waitForTimeout(500)
}
// Seleciona sem abrir nada: clique no título (no cartão aberto, clique só seleciona).
async function select(sessionId: string): Promise<void> {
  await bringIntoView(card(sessionId))
  await card(sessionId).getByTestId('card-title').click()
  await page.waitForTimeout(250)
}
// O fit para no zoom mínimo legível (0.6), então parte do conteúdo pode ficar
// fora do canvas: arrasta o fundo do mapa até o alvo ficar inteiro à vista.
async function bringIntoView(target: ReturnType<typeof page.locator>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const box = await target.boundingBox()
    const mapBox = await page.getByTestId('session-map').boundingBox()
    const bar = await page.getByTestId('map-top-bar').boundingBox()
    if (!box || !mapBox) return
    // O mapa corre por baixo da sidebar: a área útil começa na borda direita dela.
    const asideRight = await page.evaluate(
      () => document.querySelector('aside')?.getBoundingClientRect().right ?? 0,
    )
    const left = Math.max(mapBox.x, asideRight) + 12
    const right = mapBox.x + mapBox.width - 12
    const top = (bar ? bar.y + bar.height : mapBox.y) + 12
    const bottom = mapBox.y + mapBox.height - 12
    const inside =
      box.x >= left && box.x + box.width <= right && box.y >= top && box.y + Math.min(box.height, 200) <= bottom
    if (inside) return
    const dx = (left + right) / 2 - (box.x + box.width / 2)
    const dy = top + 40 - box.y
    // Começa do lado oposto ao movimento, pra caber o arrasto inteiro na área útil.
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
            if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
        return null
      },
      { l: left, r: right, t: top, b: bottom, dx, dy },
    )
    if (!start) return
    const toX = Math.max(left, Math.min(right, start.x + dx))
    const toY = Math.max(top, Math.min(bottom, start.y + dy))
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(toX, toY, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
}

function mcpAs(motherSessionId: string) {
  const cfg = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8'))
  const url = new URL(cfg.url)
  url.searchParams.set('s', motherSessionId)
  const dir = join(SCRATCH, 'mcp-as-mother')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ ...cfg, url: url.toString() }))
  return connectMcp(dir)
}

let fatal: unknown = null
try {
  await waitReady(page)
  await dismissIntro()

  // ---------- seed ao vivo ----------
  const ids = await page.evaluate(async () => {
    const a = (window as unknown as { api: Api }).api
    const mae = await a.sessions.spawn({ repoId: 'map-alpha-api', name: 'mae-alpha' })
    const filha = await a.sessions.spawn({
      repoId: 'map-alpha-web',
      name: 'renata-auth',
      handoffChild: true,
    })
    const { handoff } = await a.handoffs.createManual({
      repoId: 'map-alpha-web',
      motherSessionId: mae.id,
      task: 'Refatorar o auth para tokens rotativos',
    })
    await a.handoffs.markRunning({ id: handoff.id, childSessionId: filha.id })
    const solta = await a.sessions.spawn({ repoId: 'map-beta-site', name: 'solta-beta' })
    const perm = await a.sessions.spawn({ repoId: 'map-beta-ops', name: 'perm-ops' })
    const morta = await a.sessions.spawn({ repoId: 'map-beta-ops', name: 'morta-ops' })
    return {
      mae: mae.id,
      maeCc: mae.ccSessionId,
      filha: filha.id,
      filhaCc: filha.ccSessionId,
      solta: solta.id,
      soltaCc: solta.ccSessionId,
      perm: perm.id,
      permCc: perm.ccSessionId,
      morta: morta.id,
    }
  })
  console.log('[map] seed:', ids)
  await waitFor('filha viva', async () =>
    (await graph()).nodes.some((n) => n.sessionId === ids.filha && n.status !== 'ended'),
  )
  // Bastão: a filha passa pra uma sucessora; a antecessora encerra.
  const passed = await page.evaluate(
    (cc) =>
      (window as unknown as { api: Api }).api.baton.pass({
        ccSessionId: cc,
        briefing: 'Continue o auth.',
      }),
    ids.filhaCc,
  )
  const heirId = passed.session.id
  // O bastão não mata a antecessora: com a PTY viva ela segue "em uso". Encerra
  // como a CLI real faria ao sair, e mata uma 2ª pra ter uma encerrada solta.
  await page.evaluate((id) => (window as unknown as { api: Api }).api.sessions.kill(id), ids.filha)
  await page.evaluate((id) => (window as unknown as { api: Api }).api.sessions.kill(id), ids.morta)

  // ---------- Projetos → Mapa ----------
  await goToArea(page, 'projects')
  await page.getByTestId('projects-view-map').click()
  await waitFor(
    'cartões no mapa',
    async () => (await page.getByTestId('session-card').count()) >= 4,
  )
  await waitFor(
    'filha (antecessora) sai do mapa',
    async () => (await card(ids.filha).count()) === 0,
    20_000,
  )
  await waitFor('morta sai do mapa', async () => (await card(ids.morta).count()) === 0, 20_000)
  await fit()

  {
    const g = await graph()
    const live = await liveIds()
    const st = Object.fromEntries(
      Object.entries(ids)
        .filter(([k]) => !k.endsWith('Cc'))
        .map(([k, id]) => [k, `${g.nodes.find((n) => n.sessionId === id)?.status ?? 'ausente'}/${live.has(id) ? 'pty' : 'sem-pty'}`]),
    )
    console.log('[map] status do seed:', JSON.stringify(st), 'heir:', g.nodes.find((n) => n.sessionId === heirId)?.status, live.has(heirId))
  }
  // ---------- 1. só sessões em uso ----------
  {
    const onMap = await mapCardIds()
    const live = await liveIds()
    const notLive = onMap.filter((id) => !live.has(id))
    check(
      notLive.length === 0,
      `mapa só com sessões vivas (${onMap.length} cartões, fora do conjunto: ${notLive.join(',') || 'nenhum'})`,
    )
    check(!onMap.includes(ids.morta), 'sessão encerrada (PTY morta) some do mapa')
    check(!onMap.includes(ids.filha), 'antecessora do bastão (encerrada) some do mapa')
    const tones = await page
      .getByTestId('session-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-tone')))
    check(!tones.includes('ended'), 'nenhum cartão com tom "encerrada"')
    {
      const g = await graph()
      const pred = g.nodes.find((n) => n.sessionId === ids.filha)
      console.log('[map] bastão: antecessora no grafo =', pred ? pred.status : 'ausente', '| aresta =',
        g.edges.some((e) => e.kind === 'baton' && e.from === ids.filha && e.to === heirId),
        '| sucessora =', heirId, '| cartões =', JSON.stringify(await mapCardIds()))
      await bringIntoView(card(heirId))
    }
    const cont = await card(heirId)
      .getByTestId('card-continues-from')
      .innerText()
      .catch(() => '')
    check(/continua de/.test(cont), `sucessora mostra "continua de" (${cont.trim()})`)
    check(
      (await page.getByText(/encerradas? ocultas|\+\d+ encerradas/).count()) === 0,
      'sem chip/contador de encerradas',
    )
  }
  await page.screenshot({ path: shot('01-fit-only-live') })

  // ---------- 2. criar sessão pelo "+" da lane ----------
  {
    const before = new Set(await mapCardIds())
    const laneTabsBefore = await page.locator('.dv-tab').count()
    const lane = page.locator('[data-testid="lane-repo"]', { hasText: 'alpha-web' }).first()
    await bringIntoView(lane)
    await lane.getByTestId('lane-new-session').click()
    const openBtn = page.getByRole('button', { name: 'Abrir', exact: true })
    const dialogUp = await waitFor(
      'diálogo de spawn com o repo da lane',
      async () => openBtn.isVisible(),
      10_000,
    )
    const dialogText = dialogUp
      ? ((await page.getByText(/Nova sessão · alpha-web/).count()) > 0 ? 'alpha-web' : '')
      : ''
    check(dialogUp && dialogText.includes('alpha-web'), `"+" da lane abre o spawn já em alpha-web`)
    await page.screenshot({ path: shot('02-lane-new-session-dialog') })
    if (dialogUp) await openBtn.click()
    const ok = await waitFor('cartão novo em alpha-web', async () => {
      const g = await graph()
      return g.nodes.some(
        (n) =>
          !before.has(String(n.sessionId)) &&
          n.repoId === 'map-alpha-web' &&
          n.status !== 'ended' &&
          n.sessionId !== heirId,
      )
    })
    let newId: string | undefined
    if (ok) {
      const g = await graph()
      newId = String(
        g.nodes.find(
          (n) =>
            !before.has(String(n.sessionId)) &&
            n.repoId === 'map-alpha-web' &&
            n.status !== 'ended' &&
            n.sessionId !== heirId,
        )?.sessionId,
      )
    }
    // Com o mapa na frente a sessão nasce SEM aba e vira cartão em modo terminal
    // ali mesmo: o usuário não sai do mapa.
    const onMap = newId
      ? await waitFor('cartão aparece', async () => (await card(newId!).count()) === 1, 15_000)
      : false
    check(ok && onMap, 'sessão criada pelo "+" da lane aparece no mapa')
    check(
      (await page.getByTestId('session-map').count()) === 1,
      'criar pela lane não tira o usuário do mapa',
    )
    const inTerminal = newId
      ? await waitFor(
          'cartão novo em modo terminal',
          async () => (await card(newId!).getAttribute('data-view')) === 'terminal',
          15_000,
        )
      : false
    check(inTerminal, 'sessão nova abre como cartão em modo terminal')
    check(
      (await page.locator('[data-testid="session-card"][data-view="terminal"]').count()) === 1,
      'um terminal por vez no mapa',
    )
    const alive = await page.evaluate(
      (id) =>
        (window as unknown as { api: Api }).api.sessions
          .listLiveGlobal()
          .then((l) => l.some((s) => s.id === id)),
      newId ?? '',
    )
    check(alive, 'a sessão nova está viva')
    check(
      (await page.locator('.dv-tab').count()) === laneTabsBefore,
      'nenhuma aba nasceu (o terminal mora no cartão)',
    )
    await page.screenshot({ path: shot('02b-lane-new-session-terminal') })
    // Os passos seguintes partem do cartão aberto, não do terminal.
    if (inTerminal) {
      await card(newId!).getByTestId('card-leave-terminal').click()
      await waitFor(
        'cartão novo sai do terminal',
        async () => (await card(newId!).getAttribute('data-view')) === 'open',
        10_000,
      )
    }
  }

  // ---------- 3. filha pelo cartão (Nova filha) e o fio ----------
  let cardChildId: string | null = null
  {
    await fit()
    await select(ids.mae)
    const btn = page.getByTestId('map-action-child')
    const has = await btn.isVisible().catch(() => false)
    check(has, 'barra do cartão tem "Nova filha"')
    if (has) {
      await btn.click()
      const sel = page.getByTestId('delegate-repo')
      await sel.waitFor({ timeout: 8000 }).catch(() => {})
      check(
        (await sel.inputValue().catch(() => '')) === 'map-alpha-api',
        'Nova filha abre com o repo da mãe',
      )
      await sel.selectOption('map-beta-site').catch(() => {})
      await page.getByPlaceholder('O que a filha deve fazer?').fill('Medir o TTFB do checkout')
      await page.screenshot({ path: shot('03-new-child-dialog') })
      await page.getByTestId('delegate-submit').click()
      await page.waitForTimeout(6000)
      const betaSite = (await graph()).nodes
        .filter((n) => n.repoId === 'map-beta-site' && n.status !== 'ended')
        .map((n) => ({ title: n.title, handoff: n.childOfHandoffId, id: n.sessionId }))
      console.log('[map] sessões vivas em beta-site após Nova filha:', JSON.stringify(betaSite))
      check(
        betaSite.filter((n) => n.title !== 'solta-beta').length === 1,
        `Nova filha spawna UMA sessão (${betaSite.map((n) => n.title).join(', ')})`,
      )
      const ok = await waitFor('handoff mãe→filha no grafo', async () => {
        const g = await graph()
        const n = g.nodes.find(
          (x) => x.repoId === 'map-beta-site' && x.childOfHandoffId != null && x.status !== 'ended',
        )
        if (!n) return false
        cardChildId = String(n.sessionId)
        return g.edges.some(
          (e) => e.kind === 'handoff' && e.from === ids.mae && e.to === cardChildId,
        )
      })
      const hid = ok
        ? String((await graph()).nodes.find((n) => n.sessionId === cardChildId)?.childOfHandoffId)
        : ''
      const wired =
        ok &&
        (await waitFor(
          'fio no DOM',
          async () => (await page.locator(`.react-flow__edge[data-id="e:h:${hid}"]`).count()) === 1,
          10_000,
        ))
      check(ok, 'filha criada pelo cartão nasce ligada à mãe (aresta handoff)')
      check(
        wired && (await card(cardChildId ?? '').count()) === 1,
        'cartão da filha aparece no mapa com fio',
      )
    }
    await fit()
    await page.screenshot({ path: shot('04-child-wired') })
  }

  // ---------- 4. filha via MCP session_handoff ----------
  {
    const mcp = await mcpAs(ids.mae)
    const res = await mcp.call<{ handoffId?: string; alias?: string; error?: string }>(
      'session_handoff',
      {
        targetRepo: 'beta-ops',
        task: 'Investigar o alerta de disco do worker',
        mode: 'plan',
        force: true,
      },
    )
    console.log('[map] session_handoff:', res)
    let mcpChild: string | null = null
    const ok = await waitFor(
      'filha MCP no mapa',
      async () => {
        const g = await graph()
        const n = g.nodes.find((x) => x.childOfHandoffId === res.handoffId && x.status !== 'ended')
        if (!n) return false
        mcpChild = String(n.sessionId)
        return (
          g.edges.some((e) => e.kind === 'handoff' && e.from === ids.mae && e.to === mcpChild) &&
          (await card(mcpChild).count()) === 1
        )
      },
      40_000,
    )
    check(
      !!res.handoffId && ok,
      `filha via session_handoff aparece ligada à mãe (${res.alias ?? res.error})`,
    )
  }

  // ---------- 5. saída ao vivo + barra de prompt ----------
  {
    await zoom100()
    const soltaPid = pidOf(ids.soltaCc)
    check(soltaPid != null, 'stub da solta gravou o session file')
    await waitFor(
      'tail da solta',
      async () => (await card(ids.solta).getByTestId('card-live-tail').count()) === 1,
      20_000,
    )
    // O tail só é assinado para cartões abertos E visíveis: traz a solta à vista.
    await bringIntoView(card(ids.solta))
    await page.waitForTimeout(800)
    if (soltaPid)
      writeFileSync(join(fake.logDir, `tick-${soltaPid}.txt`), 'compilando modulo checkout 42/42\n')
    const live = await waitFor(
      'saída ao vivo atualiza',
      async () =>
        (await card(ids.solta).getByTestId('card-live-tail').innerText()).includes(
          'compilando modulo checkout',
        ),
      20_000,
    )
    check(live, 'saída ao vivo do cartão mostra o que a CLI acabou de imprimir')
    if (!live) {
      const backlog = await page.evaluate(
        (id) => (window as unknown as { api: { sessions: { getBacklog(i: string): Promise<string> } } }).api.sessions.getBacklog(id),
        ids.solta,
      )
      console.log('[map] tick no backlog da PTY:', String(backlog).includes('compilando modulo checkout'))
    }
    const tailText = await card(ids.solta)
      .getByTestId('card-live-tail')
      .innerText()
      .catch(() => '')
    // O stub empilha caixas (a TUI real redesenha no lugar): só a do fim é a ativa.
    const lastLines = tailText.split('\n').filter((l) => l.trim()).slice(-2)
    check(
      lastLines.at(-1)?.includes('compilando modulo checkout') === true,
      `fim do tail sem a caixa de input ativa (${JSON.stringify(lastLines)})`,
    )
    await card(ids.solta).screenshot({ path: shot('05-card-live-tail') })

    await bringIntoView(card(ids.solta))
    const prompt = card(ids.solta).getByTestId('card-prompt')
    await prompt.click()
    await prompt.fill('rode os testes do checkout')
    await page.keyboard.press('Enter')
    // Ela está trabalhando: o default é "ao terminar" — fica na fila até o idle.
    await page.waitForTimeout(1500)
    const queuedNotice = await card(ids.solta).getByTestId('card-prompt-notice').innerText().catch(() => '')
    const notYet = !stdinLog().includes('stdin: rode os testes do checkout')
    check(notYet && /fila/i.test(queuedNotice), `trabalhando → prompt vai pra fila (${queuedNotice})`)
    const soltaPidQ = pidOf(ids.soltaCc)
    if (soltaPidQ) fake.setStatus(soltaPidQ, 'idle')
    const delivered = await waitFor(
      'prompt no stdin do stub',
      async () => stdinLog().includes('stdin: rode os testes do checkout'),
      20_000,
    )
    const notice = await card(ids.solta)
      .getByTestId('card-prompt-notice')
      .innerText()
      .catch(() => '')
    check(delivered, `fila entrega no stdin quando ela fica ociosa (aviso: ${notice})`)
    if (soltaPidQ) fake.setStatus(soltaPidQ, 'busy')
    const echoed = await waitFor(
      'eco no tail',
      async () =>
        (await card(ids.solta).getByTestId('card-live-tail').innerText()).includes(
          'recebido: rode os testes',
        ),
      10_000,
    )
    check(echoed, 'eco da CLI aparece na saída ao vivo')
    await card(ids.solta).screenshot({ path: shot('06-card-after-prompt') })
  }

  // ---------- 6. aprovação inline com o menu REAL ----------
  {
    const ok = await waitFor(
      'cartão perm precisa de você',
      async () => (await card(ids.perm).getAttribute('data-tone')) === 'needs-you',
      40_000,
    )
    const reason = await card(ids.perm)
      .getByTestId('card-attention-reason')
      .innerText()
      .catch(() => '')
    check(
      ok && reason.includes('Permissão'),
      `menu real de permissão → "precisa de você · ${reason}"`,
    )
    await bringIntoView(card(ids.perm))
    const approve = card(ids.perm).getByTestId('attention-action-approve')
    const hasBtn = await waitFor('botão Aprovar no cartão', async () => approve.isVisible(), 15_000)
    check(hasBtn, 'cartão mostra Aprovar/Sempre/Negar do menu real')
    await card(ids.perm).screenshot({ path: shot('07-card-permission-inline') })
    // Enquadrar com alguém pedindo você: o cartão dela entra inteiro na tela.
    await fit()
    await page.waitForTimeout(300)
    const mapBox = await page.getByTestId('session-map').boundingBox()
    const permBox = await card(ids.perm).boundingBox()
    check(
      !!mapBox &&
        !!permBox &&
        permBox.x >= mapBox.x &&
        permBox.y >= mapBox.y &&
        permBox.x + permBox.width <= mapBox.x + mapBox.width &&
        permBox.y + permBox.height <= mapBox.y + mapBox.height,
      `enquadrar mostra inteiro quem precisa de você (${JSON.stringify(permBox)} em ${JSON.stringify(mapBox)})`,
    )
    await page.screenshot({ path: shot('07b-fit-needs-you') })
    if (hasBtn) {
      await approve.click()
      const key = await waitFor('tecla 1 no stub', async () => permLog().includes('key:31'), 15_000)
      const keys = permLog()
        .split('\n')
        .filter((l) => l.startsWith('key:'))
      check(key && keys.at(-1) === 'key:31', `Aprovar envia a tecla "1" (${keys.join(' ')})`)
      const back = await waitFor(
        'perm volta a trabalhando',
        async () => (await card(ids.perm).getAttribute('data-tone')) === 'working',
        20_000,
      )
      check(back, 'após aprovar o cartão sai de "precisa de você"')
    }
  }

  // ---------- 7. indicadores por status ----------
  {
    const soltaPid = pidOf(ids.soltaCc)
    const maePid = pidOf(ids.maeCc)
    if (soltaPid) fake.setStatus(soltaPid, 'idle')
    if (maePid) fake.setStatus(maePid, 'busy')
    const heirCc = (await graph()).nodes.find((n) => n.sessionId === heirId)?.ccSessionId as
      string | undefined
    const heirPid = heirCc ? pidOf(heirCc) : undefined
    if (heirPid) fake.setStatus(heirPid, 'waiting')
    const idleOk = await waitFor(
      'solta pronta',
      async () => (await card(ids.solta).getAttribute('data-tone')) === 'done',
      20_000,
    )
    const busyOk = await waitFor(
      'mãe trabalhando',
      async () => (await card(ids.mae).getAttribute('data-tone')) === 'working',
      20_000,
    )
    const waitOk = await waitFor(
      'sucessora waiting',
      async () => {
        const t = await card(heirId).getAttribute('data-tone')
        return t === 'done' || t === 'needs-you'
      },
      20_000,
    )
    const soltaTxt = await card(ids.solta)
      .getByTestId('card-status')
      .innerText()
      .catch(() => '')
    const maeTxt = await card(ids.mae)
      .getByTestId('card-status')
      .innerText()
      .catch(() => '')
    const heirTone = await card(heirId).getAttribute('data-tone')
    const heirTxt = await card(heirId)
      .getByTestId('card-status')
      .innerText()
      .catch(() => '')
    check(idleOk && /pronto/.test(soltaTxt), `idle → "${soltaTxt}"`)
    check(busyOk && /trabalhando/.test(maeTxt), `busy → "${maeTxt}"`)
    check(
      waitOk && heirTone === 'done',
      `waiting com caixa de input ociosa → fim de turno (tom ${heirTone}, "${heirTxt}")`,
    )
    const counters = await page
      .getByTestId('map-status-counters')
      .innerText()
      .catch(() => '')
    check(counters.length > 0, `contadores do mapa: ${counters.replace(/\s+/g, ' ')}`)
    await fit()
    await page.screenshot({ path: shot('08-indicators-fit') })
  }

  // ---------- 8. modo terminal ----------
  {
    await fit()
    const tabsBefore = await page.locator('.dv-tab').count()
    await bringIntoView(card(ids.solta))
    await card(ids.solta).getByTestId('card-interact').click()
    const inTerm = await waitFor(
      'solta em terminal',
      async () => (await card(ids.solta).getAttribute('data-view')) === 'terminal',
      10_000,
    )
    const samples: string[] = []
    for (let i = 0; i < 12; i++) {
      samples.push((await viewportScale()).toFixed(2))
      await page.waitForTimeout(150)
    }
    console.log('[map] zoom após Interagir (150ms):', samples.join(' '))
    const scale = await viewportScale()
    check(inTerm, 'Interagir põe o cartão em modo terminal')
    check(
      (await card(ids.solta).getAttribute('data-dimmed')) == null,
      'cartão em terminal não esmaece pelo foco de outra seleção',
    )
    check(Math.abs(scale - 1) < 0.03, `zoom vai a 1.0 ao interagir (veio ${scale.toFixed(2)})`)
    check((await page.locator('.dv-tab').count()) === tabsBefore, 'terminal no cartão não cria aba')
    const xterm = card(ids.solta).locator('.xterm')
    await waitFor('xterm montado', async () => (await xterm.count()) === 1, 10_000)
    await page.waitForTimeout(800)
    await card(ids.solta).screenshot({ path: shot('09-card-terminal') })
    await xterm.click()
    await page.keyboard.type('ola do terminal do cartao')
    await page.keyboard.press('Enter')
    const typed = await waitFor(
      'digitação no stdin',
      async () => stdinLog().includes('stdin: ola do terminal do cartao'),
      10_000,
    )
    check(typed, 'digitar no xterm do cartão chega ao stdin')
    await page.waitForTimeout(500)
    await card(ids.solta).screenshot({ path: shot('10-card-terminal-typed') })

    // Um terminal por vez: Interagir em outro devolve o anterior a 'aberto'.
    // Em 1.0 o terminal cobre o mapa; o enquadrar é programático e não o derruba.
    await fit()
    check(
      (await card(ids.solta).getAttribute('data-view')) === 'terminal',
      'enquadrar (sem gesto) mantém o terminal do cartão',
    )
    await bringIntoView(card(ids.mae).getByTestId('card-interact'))
    await card(ids.mae).getByTestId('card-interact').click()
    const swapped = await waitFor(
      'troca de terminal',
      async () =>
        (await card(ids.mae).getAttribute('data-view')) === 'terminal' &&
        (await card(ids.solta).getAttribute('data-view')) === 'open',
      10_000,
    )
    const terms = await page.locator('[data-testid="session-card"][data-view="terminal"]').count()
    check(swapped && terms === 1, `só um terminal por vez (${terms} em terminal)`)
    await page.screenshot({ path: shot('11-one-terminal') })
    await card(ids.mae).getByTestId('card-leave-terminal').click()
    await waitFor(
      'mãe volta a aberto',
      async () => (await card(ids.mae).getAttribute('data-view')) === 'open',
      5000,
    )
  }

  // ---------- 9. recolher/abrir persiste (reload e relaunch) ----------
  {
    await fit()
    await bringIntoView(card(ids.solta).getByTestId('card-toggle'))
    await card(ids.solta).getByTestId('card-toggle').click()
    const collapsed = await waitFor(
      'solta recolhida',
      async () => (await card(ids.solta).getAttribute('data-view')) === 'collapsed',
      5000,
    )
    check(collapsed, 'chevron recolhe o cartão')
    await page.waitForTimeout(800)
    // Pelo main (o app.db sozinho não tem o que ainda está no -wal).
    const views = (
      await page.evaluate(() =>
        (window as unknown as { api: { canvas: { get(i: unknown): Promise<{ views: Array<{ sessionId: string; viewState: string }> }> } } }).api.canvas.get({ scope: 'all' }),
      )
    ).views
    const mine = views.filter((v) => v.sessionId === ids.solta)
    check(
      mine.some((v) => v.viewState === 'collapsed'),
      `view_state gravado (${JSON.stringify(mine)})`,
    )
    await page.screenshot({ path: shot('12-collapsed') })

    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await waitReady(page)
    await dismissIntro()
    await goToArea(page, 'projects')
    await page
      .getByTestId('projects-view-map')
      .click()
      .catch(() => {})
    await waitFor('mapa após reload', async () => (await card(ids.solta).count()) === 1, 30_000)
    check(
      (await card(ids.solta).getAttribute('data-view')) === 'collapsed',
      'recolhido persiste após reload',
    )

    // Relaunch: o processo inteiro sai; as PTYs morrem com ele.
    await app.close()
    ;({ app, page } = await launchApp({ userDataDir: userData, env: fake.env }))
    attachErrors(page)
    await waitReady(page)
    await dismissIntro()
    const row2 = (await queryDb(
      userData,
      `SELECT view_state FROM canvas_positions WHERE kind='session' AND entity_id='${ids.solta}'`,
    )) as Array<{ view_state: string }>
    check(
      row2.some((r) => r.view_state === 'collapsed'),
      'view_state sobrevive ao relaunch no banco',
    )
    await goToArea(page, 'projects')
    await page
      .getByTestId('projects-view-map')
      .click()
      .catch(() => {})
    await page.waitForTimeout(2500)
    // Aba restaurada no boot = `claude --resume` numa linha NOVA de sessions.
    const resumed = (await graph()).nodes.find(
      (n) => n.ccSessionId === ids.soltaCc && n.status !== 'ended',
    )
    if (resumed) {
      const v = await card(String(resumed.sessionId)).getAttribute('data-view').catch(() => null)
      check(v === 'collapsed', `solta retomada no relaunch volta recolhida (id novo ${resumed.sessionId === ids.solta ? 'não' : 'sim'}, view ${v})`)
    } else console.log('[map] solta não foi retomada no relaunch (sem aba restaurada)')
    const cardsAfter = await page.getByTestId('session-card').count()
    console.log(`[map] após relaunch: ${cardsAfter} cartões (PTYs do run anterior morreram)`)
    await page.screenshot({ path: shot('13-after-relaunch') })
  }
} catch (err) {
  fatal = err
  console.error('[map] erro fatal:', err)
  await page.screenshot({ path: shot('zz-fatal') }).catch(() => {})
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
  fake.cleanup()
}

check(pageErrors.length === 0, `sem erros no renderer (${pageErrors.slice(0, 5).join(' | ')})`)
const failed = results.filter((r) => !r.ok)
console.log('\n[map] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(
  `[map] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS}`,
)
if (fatal || failed.length) process.exit(1)
