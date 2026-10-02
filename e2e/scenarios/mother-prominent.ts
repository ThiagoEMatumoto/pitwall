import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// Fase B — a mãe em destaque, sobre a CÓPIA do perfil real com HOME fake e stubs
// vivos do `claude` (nunca tocam os repos, nenhuma API é chamada):
//   feature + M (mãe) + C1/C2 (filhas de handoff de M, PTYs vivas)
//   → Enquadrar: o cartão de M é >= 1.5x a largura das filhas, a saída ao vivo
//     dele tem >= 12px na tela e o zoom é o de leitura da mãe
//   → barra de prompt GRANDE da mãe: o texto chega ao stdin do stub de M
//   → Fixar: coluna à esquerda, xterm interativo (digitar chega ao PTY de M),
//     mapa navegável ao lado, enquadrar desconta a coluna, preferência gravada
//   → Ctrl+Shift+O com a mãe fixada: o foco vai para o xterm da coluna
//   → bastão pela UI (botão do cartão, briefing manual) → a coluna passa para S
//   → desafixar: coluna some; Ctrl+Shift+O abre a mãe na modal do mapa
// Rodar: MOTHER_SHOTS=<dir> npx tsx e2e/scenarios/mother-prominent.ts

const SHOTS =
  process.env.MOTHER_SHOTS ??
  '/tmp/claude-1000/-home-thiagoematumoto-projetos-pessoal-claude-manager/mc2/drive/W3-mother'
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0
const shotPath = (name: string) => join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub vivo (o mesmo de mother-baton.ts): caixa de input ociosa e eco do stdin,
// linha a linha, em claude-<pid>.log.
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
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf '\\u23fa linha %s da saida da mae para o tail\\n' "$i"; done
box
while true; do
  if IFS= read -r line; then
    line=\${line//$'\\e[200~'/}
    line=\${line//$'\\e[201~'/}
    line=\${line%$'\\r'}
    printf 'stdin: %s\\n' "$line" >> "$LOG"
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
  console.log(`[mother] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
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
console.log(`[mother] repo: ${repo.label}`)

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
      console.log(`[mother] timeout esperando: ${label}`)
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(400)
  }
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const pidOf = (cc: string) => files().find((f) => f.data.sessionId === cc)?.data.pid
const stdinOf = (pid: number | undefined) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return pid && existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const graph = () => page.evaluate(() => window.api.sessionGraph.get())
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const dock = () => page.getByTestId('mother-dock')
const fit = async () => {
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await page.waitForTimeout(600)
}
const zoomNow = () =>
  page.evaluate(() => {
    const t = getComputedStyle(document.querySelector('.react-flow__viewport')!).transform
    return t === 'none' ? 1 : new DOMMatrix(t).a
  })
const viewportNow = () =>
  page.evaluate(() => getComputedStyle(document.querySelector('.react-flow__viewport')!).transform)
// Tamanho de texto NA TELA: font-size × escala do viewport do React Flow.
const effectivePx = (selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    const vp = document.querySelector('.react-flow__viewport')
    if (!el || !vp) return 0
    const t = getComputedStyle(vp).transform
    const scale = t === 'none' ? 1 : new DOMMatrix(t).a
    return parseFloat(getComputedStyle(el).fontSize) * scale
  }, selector)
const dockPref = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('cm:mother-dock') ?? 'null') as {
        pinnedId: string | null
        width: number
      } | null
    } catch {
      return null
    }
  })

const BRIEFING_MANUAL =
  '## Estado atual\nBriefing escrito à mão no e2e (destilação indisponível).\n## Próximo passo\nSupervisionar as filhas.'

let fatal: unknown = null
try {
  await waitReady(page)

  // ---------- feature + M + C1/C2 (PTYs vivas) ----------
  const mcp = await connectMcp(userData)
  const { feature } = await mcp.call<{ feature: { id: string } }>('feature_create', {
    projectId: repo.project_id,
    title: 'Mae em destaque E2E',
    status: 'in-progress',
    repos: [{ repoId: repo.id, branch: 'feat/mae-destaque-e2e' }],
  })
  check(!!feature.id, `feature criada (${feature.id})`)
  const spawned = await page.evaluate(
    async ({ repoId, featureId }) => {
      const m = await window.api.sessions.spawn({ repoId, name: 'mae-destaque-e2e', featureId })
      const kids: Array<{ id: string; cc: string | null; handoffId: string }> = []
      for (const [name, task] of [
        ['filha-um-e2e', 'Ajustar o checkout'],
        ['filha-dois-e2e', 'Revisar o estorno'],
      ] as const) {
        const c = await window.api.sessions.spawn({ repoId, name, handoffChild: true, featureId })
        const { handoff } = await window.api.handoffs.createManual({
          repoId,
          motherSessionId: m.id,
          task,
          featureId,
        })
        await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: c.id })
        kids.push({ id: c.id, cc: c.ccSessionId, handoffId: handoff.id })
      }
      return { m: { id: m.id, cc: m.ccSessionId }, kids }
    },
    { repoId: repo.id, featureId: feature.id },
  )
  const idM = spawned.m.id
  const [c1, c2] = spawned.kids
  check(
    await waitFor('session files de M, C1, C2', async () =>
      [spawned.m.cc, c1.cc, c2.cc].every((cc) => !!cc && pidOf(cc) !== undefined),
    ),
    'M, C1 e C2 com PTYs vivas (stub)',
  )
  const mPid = pidOf(spawned.m.cc!)

  // ---------- mapa + Enquadrar ----------
  await goToArea(page, 'projects')
  await page.keyboard.press('Control+Shift+KeyG')
  check(
    await waitFor('mapa', async () => page.getByTestId('session-map').isVisible(), 10_000),
    'Ctrl+Shift+G abre o mapa',
  )
  await waitFor(
    'cartões',
    async () =>
      (await card(idM).count()) > 0 &&
      (await card(c1.id).count()) > 0 &&
      (await card(c2.id).count()) > 0,
  )
  check(
    await waitFor(
      'variante mãe',
      async () => (await card(idM).getAttribute('data-variant')) === 'mother',
    ),
    'M desenhada na variante mãe (data-variant=mother)',
  )
  await fit()
  await shot('enquadrar')

  const [bm, b1, b2] = await Promise.all([idM, c1.id, c2.id].map((id) => card(id).boundingBox()))
  const ratio = bm && b1 && b2 ? bm.width / Math.max(b1.width, b2.width) : 0
  check(ratio >= 1.5, `cartão da mãe ${ratio.toFixed(2)}x a largura das filhas (>= 1.5)`)
  check(
    !!bm && !!b1 && !!b2 && bm.x <= b1.x + 1 && bm.x <= b2.x + 1 && bm.y <= b1.y && bm.y <= b2.y,
    'mãe no topo à esquerda do card da feature',
  )
  const zoom = await zoomNow()
  check(zoom >= 0.88 - 1e-3, `zoom do Enquadrar ${zoom.toFixed(3)} (>= 0.88, leitura da mãe)`)
  const mapBox = await page.getByTestId('session-map').boundingBox()
  check(
    !!bm && !!mapBox && bm.x >= mapBox.x && bm.x + bm.width <= mapBox.x + mapBox.width + 1,
    'cartão da mãe inteiro na largura do mapa',
  )

  // ---------- barra de prompt grande da mãe ----------
  const bar = card(idM).locator('[data-testid="card-prompt"][data-size="large"]')
  check((await bar.count()) === 1, 'barra de prompt GRANDE no cartão da mãe')
  await bar.click()
  await bar.fill('ola-mae-pela-barra')
  await bar.press('Enter')
  check(
    await waitFor(
      'stdin de M (barra)',
      async () => stdinOf(mPid).includes('stdin: ola-mae-pela-barra'),
      15_000,
    ),
    'texto da barra da mãe chegou ao stdin do stub de M',
  )
  const tailSel = `[data-testid="session-card"][data-session-id="${idM}"] [data-testid="card-live-tail"] pre`
  check(
    await waitFor(
      'tail da mãe com linhas',
      async () => (await page.locator(tailSel).count()) > 0,
      15_000,
    ),
    'saída ao vivo da mãe desenhada',
  )
  const tailLines = await page
    .locator(`${tailSel} > div`)
    .count()
    .catch(() => 0)
  const tailPx = await effectivePx(tailSel)
  check(tailPx >= 12, `saída ao vivo da mãe com ${tailPx.toFixed(1)}px efetivos (>= 12)`)
  check(tailLines >= 12, `saída ao vivo da mãe com ${tailLines} linhas (>= 12)`)
  await shot('barra-da-mae')

  // ---------- Fixar a mãe ----------
  await card(idM).getByTestId('mother-pin').click()
  check(
    await waitFor('coluna da mãe', async () => dock().isVisible(), 10_000),
    'Fixar: a coluna da mãe aparece',
  )
  check((await dock().getAttribute('data-session-id')) === idM, 'a coluna mostra M')
  const dockBox = await dock().boundingBox()
  const mapBox2 = await page.getByTestId('session-map').boundingBox()
  check(
    !!dockBox &&
      !!mapBox2 &&
      dockBox.x + dockBox.width <= mapBox2.x + 1 &&
      dockBox.height >= mapBox2.height - 2,
    `coluna à esquerda do mapa, altura total (dock ${dockBox?.x}+${dockBox?.width}, mapa ${mapBox2?.x})`,
  )
  check(
    await waitFor(
      'xterm na coluna',
      async () => (await dock().locator('.xterm').count()) === 1,
      15_000,
    ),
    'um xterm real na coluna',
  )
  check(
    (await page
      .locator(`[data-testid="session-card"][data-session-id="${idM}"] .xterm`)
      .count()) === 0,
    'o cartão não monta um segundo xterm da mesma PTY',
  )
  const pref = await dockPref()
  check(pref?.pinnedId === idM, `preferência gravada (cm:mother-dock.pinnedId = ${pref?.pinnedId})`)

  await dock().locator('.xterm').click()
  await page.keyboard.type('ola-pela-coluna')
  await page.keyboard.press('Enter')
  check(
    await waitFor(
      'stdin de M (coluna)',
      async () => stdinOf(mPid).includes('stdin: ola-pela-coluna'),
      15_000,
    ),
    'digitar no xterm da coluna chega ao PTY de M',
  )
  await shot('mae-fixada')

  // ---------- C1 despacha uma neta: mãe intermediária + toast fora da mãe ----------
  const neta = await page.evaluate(
    async ({ repoId, featureId, mother }) => {
      const c = await window.api.sessions.spawn({ repoId, name: 'neta-e2e', handoffChild: true, featureId })
      const { handoff } = await window.api.handoffs.createManual({
        repoId,
        motherSessionId: mother,
        task: 'Conferir o recibo',
        featureId,
      })
      await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: c.id })
      return { id: c.id }
    },
    { repoId: repo.id, featureId: feature.id, mother: c1.id },
  )
  const toastCard = page.locator('[data-testid="toast-card"]:visible', { hasText: 'neta-e2e' })
  const toastAt = Date.now()
  check(
    await waitFor('toast de despacho', async () => (await toastCard.count()) > 0, 10_000),
    'toast "neta-e2e despachada → …" apareceu',
  )
  check(
    await waitFor('C1 vira mãe', async () => (await card(c1.id).getAttribute('data-mother')) === 'true', 10_000),
    'C1 (filha que delegou) marcada como mãe',
  )
  check(
    (await card(c1.id).getAttribute('data-variant')) !== 'mother' &&
      (await card(c1.id).getByTestId('card-mother-badge').count()) > 0,
    `mãe intermediária C1 no cartão comum com o selo MÃE (variant=${await card(c1.id).getAttribute('data-variant')})`,
  )
  check(
    (await card(idM).getAttribute('data-variant')) === 'mother',
    'a raiz M segue no cartão grande',
  )
  // A pilha relê os obstáculos a cada 500ms: espera assentar antes de medir.
  await page.waitForTimeout(900)
  await shot('toast-fora-da-mae')
  const overlapsBox = (
    a: { x: number; y: number; width: number; height: number } | null,
    b: { x: number; y: number; width: number; height: number } | null,
  ) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  // Toda a pilha visível (o "+N" esconde os excedentes com hidden).
  const stack = page.locator('[data-testid="toast-card"]:visible, [data-testid="toast-overflow"]')
  const tbs = await Promise.all((await stack.all()).map((l) => l.boundingBox()))
  const mb = await card(idM).boundingBox()
  const db = await dock().boundingBox()
  check(
    tbs.length > 0 && tbs.every((tb) => !!tb && !overlapsBox(tb, mb) && !overlapsBox(tb, db)),
    `pilha de toasts fora do cartão da mãe e da coluna fixada (${tbs.length} itens · mãe ${JSON.stringify(mb)} · coluna ${JSON.stringify(db)})`,
  )
  const gone = await waitFor('toast some', async () => (await toastCard.count()) === 0, 8_000)
  const lived = Date.now() - toastAt
  check(gone && lived <= 6_500, `toast de despacho sumiu sozinho em ${lived}ms (~5s)`)
  check(!!neta.id, `neta subiu (${neta.id})`)

  // O mapa segue navegável ao lado: arrastar o fundo move a câmera.
  const before = await viewportNow()
  const pane = page.locator('.react-flow__pane')
  const pb = (await pane.boundingBox())!
  // Começa num ponto que é o PRÓPRIO pane (no card da feature o arrasto move o
  // card; no canto há minimapa e toasts).
  const start = await page.evaluate(
    ({ l, t, w, h }) => {
      for (let y = t + 40; y < t + h - 140; y += 30)
        for (let x = l + 40; x < l + w - 220; x += 30)
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
      return null
    },
    { l: pb.x, t: pb.y, w: pb.width, h: pb.height },
  )
  const sx = start?.x ?? pb.x + 140
  const sy = start?.y ?? pb.y + pb.height * 0.7
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 180, sy + 100, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  check((await viewportNow()) !== before, 'mapa navegável ao lado da coluna (pan mudou a câmera)')

  // Enquadrar desconta a coluna: nenhum cartão sob ela.
  await fit()
  const cardsBoxes = await page.locator('[data-testid="session-card"]').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }),
  )
  const under = dockBox
    ? cardsBoxes.filter((c) => c.x < dockBox.x + dockBox.width - 1 && c.w > 0)
    : cardsBoxes
  check(under.length === 0, `enquadrar desconta a coluna (${under.length} cartões sob ela)`)
  await shot('enquadrar-com-coluna')

  // Ctrl+Shift+O com a mãe fixada: foco no xterm da coluna.
  await page
    .getByTestId('session-map')
    .click({ position: { x: 20, y: 200 } })
    .catch(() => {})
  await page.keyboard.press('Control+Shift+KeyO')
  check(
    await waitFor(
      'foco no xterm da coluna',
      async () =>
        page.evaluate(
          () => !!document.activeElement?.closest('[data-testid="mother-dock-terminal"]'),
        ),
      5000,
    ),
    'Ctrl+Shift+O leva o foco ao xterm da coluna',
  )

  // Ctrl+Shift+O na visão Terminais: abre o mapa e vai à mãe (antes o ^O caía no
  // xterm e alternava o transcript do claude).
  await page.getByTestId('projects-view-terminals').click()
  check(
    await waitFor(
      'mapa fechado',
      async () => (await page.getByTestId('session-map').count()) === 0,
      5000,
    ),
    'visão Terminais sem o mapa',
  )
  await page.keyboard.press('Control+Shift+KeyO')
  check(
    await waitFor(
      'mapa + foco na coluna',
      async () =>
        (await page.getByTestId('session-map').isVisible().catch(() => false)) &&
        (await page.evaluate(
          () => !!document.activeElement?.closest('[data-testid="mother-dock-terminal"]'),
        )),
      8000,
    ),
    'Ctrl+Shift+O fora do mapa abre o mapa e foca a mãe',
  )

  // ---------- bastão pela UI: a coluna passa para a sucessora ----------
  const beforeIds = new Set((await graph()).nodes.map((n) => n.sessionId))
  await card(idM).getByTestId('mother-baton').click()
  check(
    await waitFor(
      'modo mãe',
      async () => (await page.getByTestId('baton-mother-mode').count()) > 0,
      10_000,
    ),
    'botão "Passar o bastão" do cartão abre o diálogo em modo mãe',
  )
  const manual = page.getByTestId('baton-write-manual')
  if (await manual.isVisible().catch(() => false)) await manual.click()
  const textarea = page.getByTestId('baton-briefing')
  check(
    await waitFor('textarea do briefing', async () => textarea.isVisible(), 95_000),
    'briefing manual disponível',
  )
  await textarea.fill(BRIEFING_MANUAL)
  await page.getByTestId('baton-confirm').click()
  let idS = ''
  await waitFor('sucessora no grafo', async () => {
    idS =
      (await graph()).nodes.find((n) => !beforeIds.has(n.sessionId) && n.status !== 'ended')
        ?.sessionId ?? ''
    return idS !== ''
  })
  check(!!idS, `sucessora S subiu (${idS})`)
  // Bastão passado do mapa fica no mapa: a coluna segue sozinha, sem trocar de vista.
  check(
    await page
      .getByTestId('session-map')
      .isVisible()
      .catch(() => false),
    'o mapa continua na frente depois do bastão (sem ir para a aba da sucessora)',
  )
  check(
    await waitFor(
      'coluna em S',
      async () =>
        (await dock()
          .getAttribute('data-session-id')
          .catch(() => null)) === idS,
      30_000,
    ),
    'a coluna passou para a sucessora S',
  )
  check((await dockPref())?.pinnedId === idS, 'preferência da coluna aponta para S')
  check(
    await waitFor(
      'xterm de S na coluna',
      async () => (await dock().locator('.xterm').count()) === 1,
      15_000,
    ),
    'xterm de S na coluna',
  )
  await shot('coluna-na-sucessora')

  // ---------- desafixar ----------
  await page.getByTestId('mother-dock-unpin').click()
  check(
    await waitFor('coluna some', async () => (await dock().count()) === 0, 5000),
    'Desafixar: a coluna some',
  )
  check((await dockPref())?.pinnedId === null, 'preferência desafixada (pinnedId null)')
  await fit()
  await shot('desafixada')

  // Sem coluna, Ctrl+Shift+O abre a mãe (S) na modal do mapa.
  await page
    .getByTestId('session-map')
    .click({ position: { x: 20, y: 200 } })
    .catch(() => {})
  await page.keyboard.press('Control+Shift+KeyO')
  const modal = page.locator('[role="dialog"][data-peek-mode="terminal"]')
  check(
    await waitFor('modal da mãe', async () => modal.isVisible(), 10_000),
    'Ctrl+Shift+O sem coluna abre a mãe na modal do mapa',
  )
  await shot('atalho-modal')
  await page.keyboard.press('Escape')
} catch (err) {
  fatal = err
  console.error('[mother] erro fatal:', err)
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
console.log('\n[mother] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(
  `[mother] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS} · log ${logs.logFile}`,
)
if (fatal || failed.length) process.exit(1)
