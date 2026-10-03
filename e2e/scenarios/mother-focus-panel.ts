import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// F1 + F2 do painel da mãe, sobre a CÓPIA do perfil real com HOME fake e stubs
// vivos do `claude` (nunca tocam os repos, nenhuma API é chamada):
//   F1 (M1 + C1, C2) e F2 (M2 + C3), todas com PTYs vivas
//   → selecionar C1: o painel abre SOZINHO com M1 (sem Fixar), sem roubar o foco
//   → painel 0.50–0.60 da linha, à esquerda do mapa; xterm com cols >= 100,
//     fonte >= 14px e nenhum transform nos ancestrais; 1 xterm da PTY de M1
//   → digitar no painel chega ao stdin do stub de M1
//   → zoom 0.3–1.5 e pan: zero IPC sessions:resize
//   → arrastar o separador: exatamente 1 resize de M1, só ao soltar
//   → selecionar S3 (F3, sem mãe) e voltar a C1: o painel fica em M1, sem fechar
//     nem mexer na câmera
//   → com o foco no xterm de M1, Ctrl+` até F2: o painel troca para M2 (debounce)
//     e o foco NÃO vai para o xterm de M2;
//     o cartão de M2 diz "está no painel", o de M1 volta ao tail
//   → "Fixar esta" trava M2 ao focar F1; "Soltar" volta para M1
//   → Ctrl+Shift+P esconde/mostra o painel; Ctrl+Shift+O foca o xterm dele
//   → pílulas: 1 por filha com o tom; clique centraliza o cartão; duplo clique
//     e Enter abrem o lift; fechar devolve ao painel o MESMO xterm com o buffer
// Rodar: MP_SHOTS=<dir> npx tsx e2e/scenarios/mother-focus-panel.ts

const SHOTS =
  process.env.MP_SHOTS ??
  '/home/thiagoematumoto/projetos/pessoal/claude-manager/.worktrees/feat-mother-panel/.cm-drive/mp/drive/MP-panel'
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
  console.log(`[panel] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
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
console.log(`[panel] repo: ${repo.label}`)

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
// 100+ colunas a 14px pedem ~860px de painel: numa janela de 1400px com a
// sidebar aberta a linha tem ~1050px e 55% dá ~65 colunas (medido na rodada 1).
// O critério é medido numa janela larga (monitor 1080p).
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w?.unmaximize()
  w?.setSize(1920, 1080)
})
await page.waitForTimeout(500)
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
      console.log(`[panel] timeout esperando: ${label}`)
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(250)
  }
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const pidOf = (cc: string) => files().find((f) => f.data.sessionId === cc)?.data.pid
const stdinOf = (pid: number | undefined) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return pid && existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const dock = () => page.getByTestId('mother-dock')
const dockId = () =>
  dock()
    .getAttribute('data-session-id', { timeout: 1000 })
    .catch(() => null)
const viewportNow = () =>
  page.evaluate(() => {
    const t = getComputedStyle(document.querySelector('.react-flow__viewport')!).transform
    const m = t === 'none' ? new DOMMatrix() : new DOMMatrix(t)
    return { x: m.e, y: m.f, zoom: m.a }
  })
const focusInDock = () =>
  page.evaluate(() => !!document.activeElement?.closest('[data-testid="mother-dock-terminal"]'))
const dockPref = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('cm:mother-dock') ?? 'null') as {
        pinnedId: string | null
        mode: string
        share: number
      } | null
    } catch {
      return null
    }
  })
// Clique no cabeçalho do cartão: seleciona sem abrir nada.
const selectCard = async (id: string) => {
  // Depois de zoom/pan/separador o cartão pode estar fora da câmera (o enquadrar
  // segue a feature em foco): a pílula "N fora da vista" enquadra tudo.
  const inMap = async () => {
    const b = await card(id)
      .boundingBox()
      .catch(() => null)
    const m = await page.getByTestId('session-map').boundingBox()
    return (
      !!b &&
      !!m &&
      b.x >= m.x &&
      b.x + b.width <= m.x + m.width &&
      b.y >= m.y &&
      b.y < m.y + m.height - 40
    )
  }
  // O "N fora da vista" usa o enquadrar legível (não tudo): arrasta o fundo até ele.
  for (let i = 0; i < 3 && !(await inMap()); i++) {
    const b = await card(id).boundingBox()
    const m = await page.getByTestId('session-map').boundingBox()
    const from = await freePanePoint()
    if (!b || !m || !from) break
    const dx = m.x + m.width / 2 - (b.x + b.width / 2)
    const dy = m.y + m.height / 2 - (b.y + b.height / 2)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
  await card(id).getByTestId('card-title').first().click()
  await page.waitForTimeout(150)
}

// Um ponto do pane sem cartão por cima (cartões com nowheel engolem a roda).
const freePanePoint = async () => {
  const pb = (await page.locator('.react-flow__pane').boundingBox())!
  return page.evaluate(
    ({ l, t, w, h }) => {
      for (let y = t + 40; y < t + h - 140; y += 30)
        for (let x = l + 40; x < l + w - 220; x += 30)
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane'))
            return { x, y }
      return null
    },
    { l: pb.x, t: pb.y, w: pb.width, h: pb.height },
  )
}

// Spy do IPC sessions:resize no main (o mesmo de map-terminal-modal.ts).
async function installResizeSpy(): Promise<boolean> {
  return app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Function> })
      ._invokeHandlers
    const original = handlers?.get('sessions:resize')
    if (!original) return false
    const log: Array<{ id: string; cols: number; rows: number; t: number }> = []
    ;(globalThis as unknown as { __resizeLog: typeof log }).__resizeLog = log
    ipcMain.removeHandler('sessions:resize')
    ipcMain.handle('sessions:resize', (e, id: string, cols: number, rows: number) => {
      log.push({ id, cols, rows, t: Date.now() })
      return original(e, id, cols, rows)
    })
    return true
  })
}
const resizeLog = () =>
  app.evaluate(
    () =>
      (
        globalThis as unknown as {
          __resizeLog?: Array<{ id: string; cols: number; rows: number; t: number }>
        }
      ).__resizeLog ?? [],
  )

let fatal: unknown = null
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  // Preferência do painel limpa (a cópia traz a do perfil real): nasce no padrão.
  await page.evaluate(() => localStorage.removeItem('cm:mother-dock'))
  await page.reload()
  await waitReady(page)
  check(await installResizeSpy(), 'spy do IPC sessions:resize instalado no main')

  // ---------- F1 (M1 + C1, C2) e F2 (M2 + C3), PTYs vivas ----------
  const mcp = await connectMcp(userData)
  const mk = async (title: string, branch: string) =>
    (
      await mcp.call<{ feature: { id: string } }>('feature_create', {
        projectId: repo.project_id,
        title,
        status: 'in-progress',
        repos: [{ repoId: repo.id, branch }],
      })
    ).feature.id
  const f1 = await mk('Painel F1 E2E', 'feat/painel-f1-e2e')
  const f2 = await mk('Painel F2 E2E', 'feat/painel-f2-e2e')
  const f3 = await mk('Painel F3 E2E', 'feat/painel-f3-e2e')
  check(!!f1 && !!f2 && !!f3, `features F1 (${f1}), F2 (${f2}) e F3 (${f3}, sem mãe) criadas`)
  const spawn = (featureId: string, mother: string, kids: Array<[string, string]>) =>
    page.evaluate(
      async ({ repoId, featureId, mother, kids }) => {
        const m = await window.api.sessions.spawn({ repoId, name: mother, featureId })
        const out: Array<{ id: string; cc: string | null }> = []
        for (const [name, task] of kids) {
          const c = await window.api.sessions.spawn({ repoId, name, handoffChild: true, featureId })
          const { handoff } = await window.api.handoffs.createManual({
            repoId,
            motherSessionId: m.id,
            task,
            featureId,
          })
          await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: c.id })
          out.push({ id: c.id, cc: c.ccSessionId })
        }
        return { m: { id: m.id, cc: m.ccSessionId }, kids: out }
      },
      { repoId: repo.id, featureId, mother, kids },
    )
  const s1 = await spawn(f1, 'mae-um-e2e', [
    ['filha-c1-e2e', 'Ajustar o checkout'],
    ['filha-c2-e2e', 'Revisar o estorno'],
  ])
  const s2 = await spawn(f2, 'mae-dois-e2e', [['filha-c3-e2e', 'Conferir o recibo']])
  // F3: uma sessão solta, sem filhas — a feature não tem mãe.
  const s3 = (await spawn(f3, 'solo-f3-e2e', [])).m
  const idM1 = s1.m.id
  const idM2 = s2.m.id
  const [c1, c2] = s1.kids
  const [c3] = s2.kids
  check(
    await waitFor('PTYs vivas', async () =>
      [s1.m.cc, s2.m.cc, c1.cc, c2.cc, c3.cc, s3.cc].every((cc) => !!cc && pidOf(cc) !== undefined),
    ),
    'M1, C1, C2, M2, C3 e S3 com PTYs vivas (stub)',
  )
  const m1Pid = pidOf(s1.m.cc!)
  const m2Pid = pidOf(s2.m.cc!)

  // ---------- mapa ----------
  await goToArea(page, 'projects')
  await page.keyboard.press('Control+Shift+KeyG')
  check(
    await waitFor('mapa', async () => page.getByTestId('session-map').isVisible(), 10_000),
    'Ctrl+Shift+G abre o mapa',
  )
  await waitFor('cartões', async () => {
    const counts = await Promise.all(
      [idM1, idM2, c1.id, c2.id, c3.id, s3.id].map((id) => card(id).count()),
    )
    return counts.every((n) => n > 0)
  })

  // ---------- F1: o painel abre sozinho com M1 ----------
  await selectCard(c1.id)
  check(
    await waitFor('painel com M1', async () => (await dockId()) === idM1, 10_000),
    'selecionar C1 (F1): o painel mostra M1 sem Fixar',
  )
  check((await dock().getAttribute('data-mode')) === 'focus', 'painel em modo "segue a feature"')
  check((await dockPref())?.pinnedId == null, 'nenhuma trava gravada (pinnedId null)')
  check(
    await waitFor(
      'xterm no painel',
      async () => (await dock().locator('.xterm').count()) === 1,
      15_000,
    ),
    'um xterm real no painel',
  )
  await page.waitForTimeout(800)
  // Depois do xterm montado (um focus() no mount apareceria aqui), não logo após o clique.
  check(!(await focusInDock()), 'abrir o painel não roubou o foco (xterm montado + 800ms)')
  await shot('painel-m1')

  // ---------- F3 sem mãe: o painel fica em M1, sem fechar nem reenquadrar ----------
  // (Regressão: ir a uma feature sem mãe fechava o painel na hora e o voltar
  // reabria — cada um reenquadrava a câmera e remontava o xterm.)
  const steadyDock = async (label: string) => {
    const v0 = await viewportNow()
    let closed = 0
    let other = 0
    for (let i = 0; i < 20; i++) {
      const id = await dockId()
      if (id === null) closed++
      else if (id !== idM1) other++
      await page.waitForTimeout(50)
    }
    const v1 = await viewportNow()
    const still =
      Math.abs(v0.x - v1.x) <= 0.5 &&
      Math.abs(v0.y - v1.y) <= 0.5 &&
      Math.abs(v0.zoom - v1.zoom) < 1e-3
    check(
      closed === 0 && other === 0 && still,
      `${label}: painel em M1 o tempo todo (${closed} fechado, ${other} outra) e câmera parada (${v0.zoom.toFixed(3)}→${v1.zoom.toFixed(3)})`,
    )
  }
  await selectCard(s3.id)
  await steadyDock('selecionar S3 (F3, sem mãe)')
  check(
    (await dock().locator('.xterm').count()) === 1,
    'o xterm de M1 segue montado com F3 em foco',
  )
  await selectCard(c1.id)
  await steadyDock('voltar a C1 (F1)')

  const dockBox = (await dock().boundingBox())!
  const mapBox = (await page.getByTestId('session-map').boundingBox())!
  const share = dockBox.width / (dockBox.width + mapBox.width)
  check(
    share >= 0.5 && share <= 0.6,
    `painel com ${(share * 100).toFixed(1)}% da linha (0.50–0.60)`,
  )
  check(mapBox.width >= 480, `mapa ao lado com ${mapBox.width.toFixed(0)}px (>= 480)`)
  check(dockBox.x + dockBox.width <= mapBox.x + 1, 'painel à esquerda do mapa')
  const m1Resizes = (await resizeLog()).filter((r) => r.id === idM1)
  const lastM1 = m1Resizes.at(-1)
  check(!!lastM1 && lastM1.cols >= 100, `xterm do painel com ${lastM1?.cols} colunas (>= 100)`)
  const typo = await page.evaluate(() => {
    const x = document.querySelector('[data-testid="mother-dock"] .xterm')
    const rows = x?.querySelector('.xterm-rows') ?? x
    const px = rows ? parseFloat(getComputedStyle(rows).fontSize) : 0
    const transformed: string[] = []
    for (let el = x?.parentElement; el; el = el.parentElement) {
      const t = getComputedStyle(el).transform
      if (t && t !== 'none') transformed.push(el.className.toString().slice(0, 40))
    }
    return { px, transformed }
  })
  check(typo.px >= 14, `fonte efetiva do xterm ${typo.px}px (>= 14)`)
  check(
    typo.transformed.length === 0,
    `nenhum transform nos ancestrais do xterm (${typo.transformed.join(' | ') || 'nenhum'})`,
  )
  const mapXterms = await page
    .locator('[data-testid="mother-dock"] .xterm, [data-testid="session-map"] .xterm')
    .count()
  check(
    mapXterms === 1,
    `exatamente 1 xterm no Mapa (${mapXterms}) — o cartão de M1 não monta outro`,
  )
  check(
    (await card(idM1).getByTestId('mother-pinned-here').count()) === 1 &&
      (await card(idM1).getAttribute('data-in-panel')) === 'true',
    'o cartão de M1 diz "está no painel" em vez do tail',
  )

  await dock().locator('.xterm').click()
  await page.keyboard.type('ola-pelo-painel')
  await page.keyboard.press('Enter')
  check(
    await waitFor(
      'stdin de M1',
      async () => stdinOf(m1Pid).includes('stdin: ola-pelo-painel'),
      15_000,
    ),
    'digitar no painel chega ao stdin do stub de M1',
  )

  // ---------- zoom 0.3–1.5 e pan: zero resize ----------
  await page
    .getByTestId('session-map')
    .click({ position: { x: 30, y: 300 } })
    .catch(() => {})
  await page.waitForTimeout(400)
  const before = (await resizeLog()).length
  const zooms: number[] = []
  const mb = (await page.getByTestId('session-map').boundingBox())!
  const wheelAt = (await freePanePoint()) ?? { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 }
  await page.mouse.move(wheelAt.x, wheelAt.y)
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(60)
    zooms.push((await viewportNow()).zoom)
  }
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(60)
    zooms.push((await viewportNow()).zoom)
  }
  const zMin = Math.min(...zooms)
  const zMax = Math.max(...zooms)
  // Em zoom 2 os cartões cobrem o pane inteiro: enquadra para achar fundo livre.
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await page.waitForTimeout(500)
  const start = await freePanePoint()
  const vpBeforePan = await viewportNow()
  if (start) {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 160, start.y + 90, { steps: 8 })
    await page.mouse.up()
  }
  await page.waitForTimeout(500)
  const vpAfterPan = await viewportNow()
  check(
    zMin <= 0.31 && zMax >= 1.49,
    `zoom percorreu ${zMin.toFixed(2)}–${zMax.toFixed(2)} (0.3–1.5)`,
  )
  check(
    vpAfterPan.x !== vpBeforePan.x || vpAfterPan.y !== vpBeforePan.y,
    `pan moveu a câmera (start ${JSON.stringify(start)} ${JSON.stringify(vpBeforePan)}→${JSON.stringify(vpAfterPan)})`,
  )
  const zoomPanResizes = (await resizeLog()).slice(before)
  check(
    zoomPanResizes.length === 0,
    `zero IPC resize no zoom/pan (${zoomPanResizes.length}: ${JSON.stringify(zoomPanResizes.slice(0, 3))})`,
  )
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await page.waitForTimeout(600)
  await shot('zoom-pan')

  // ---------- separador: 1 resize, só ao soltar ----------
  const sep = page.getByTestId('mother-dock-resize')
  const sb = (await sep.boundingBox())!
  const widthBefore = (await dock().boundingBox())!.width
  const beforeDrag = (await resizeLog()).length
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(sb.x + sb.width / 2 - i * 15, sb.y + sb.height / 2)
    await page.waitForTimeout(30)
  }
  const midResizes = (await resizeLog()).length - beforeDrag
  const widthMid = (await dock().boundingBox())!.width
  await shot('separador-arrastando')
  await page.mouse.up()
  await page.waitForTimeout(900)
  const widthAfter = (await dock().boundingBox())!.width
  const dragResizes = (await resizeLog()).slice(beforeDrag).filter((r) => r.id === idM1)
  check(
    midResizes === 0 && Math.abs(widthMid - widthBefore) < 1,
    `durante o arrasto o painel não muda (${widthBefore.toFixed(0)}→${widthMid.toFixed(0)}px, ${midResizes} resizes)`,
  )
  check(
    widthAfter < widthBefore - 100,
    `soltar aplica a largura (${widthBefore.toFixed(0)}→${widthAfter.toFixed(0)}px)`,
  )
  check(
    dragResizes.length === 1,
    `arrastar o separador gerou ${dragResizes.length} resize de M1 (=1) ${JSON.stringify(dragResizes)}`,
  )
  const pref = await dockPref()
  check(!!pref && pref.share < 0.55, `fração gravada em cm:mother-dock (share ${pref?.share})`)

  // ---------- F2: troca para M2 sem roubar o foco ----------
  // O foco começa NO xterm de M1 e a feature muda sem clique no mapa (seletor
  // Ctrl+`): é o caso em que o remount de M2 poderia puxar o foco para ela.
  await dock().locator('.xterm').click()
  check(await focusInDock(), 'foco no xterm de M1 antes da troca')
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  const picked = () =>
    page
      .locator('[data-testid="feature-switcher"] [role="option"][aria-selected="true"]')
      .getAttribute('data-key', { timeout: 1000 })
      .catch(() => null)
  await waitFor('seletor aberto', async () => (await picked()) !== null, 3000)
  for (let i = 0; i < 40 && (await picked()) !== f2; i++) await page.keyboard.press('Tab')
  const onF2 = (await picked()) === f2
  await page.keyboard.up('Control')
  check(onF2, 'seletor com F2 selecionada')
  const switchedAt = Date.now()
  check(
    await waitFor('painel com M2', async () => (await dockId()) === idM2, 10_000),
    `confirmar F2 no seletor: o painel troca para M2 (${Date.now() - switchedAt}ms, debounce ~300)`,
  )
  check(
    await waitFor(
      'xterm de M2',
      async () => (await dock().locator('.xterm').count()) === 1,
      15_000,
    ),
    'um xterm (de M2) no painel',
  )
  await page.waitForTimeout(500)
  check(
    !(await focusInDock()),
    `a troca de feature não puxou o foco para M2 (foco em ${await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName,
    )})`,
  )
  check(
    (await card(idM2).getByTestId('mother-pinned-here').count()) === 1 &&
      (await card(idM1).getByTestId('mother-pinned-here').count()) === 0,
    'o cartão de M2 diz "está no painel" e o de M1 voltou ao normal',
  )
  await page.waitForTimeout(500)
  await shot('painel-m2')

  // ---------- Fixar esta / Soltar ----------
  await dock().getByTestId('mother-dock-pin').click()
  check(
    await waitFor('trava', async () => (await dock().getAttribute('data-mode')) === 'pinned', 5000),
    '"Fixar esta" trava M2',
  )
  check((await dockPref())?.pinnedId === idM2, 'trava gravada (pinnedId = M2)')
  await selectCard(c1.id)
  await page.waitForTimeout(900)
  check((await dockId()) === idM2, 'com a trava, focar F1 mantém M2 no painel')
  check(
    (await card(idM2).getByTestId('mother-pin').innerText()).includes('Soltar'),
    'o cartão de M2 oferece "Soltar"',
  )
  await dock().getByTestId('mother-dock-unpin').click()
  check(
    await waitFor('volta para M1', async () => (await dockId()) === idM1, 5000),
    '"Soltar": o painel volta a seguir F1 (M1)',
  )

  // ---------- Ctrl+Shift+P / Ctrl+Shift+O ----------
  await page
    .getByTestId('session-map')
    .click({ position: { x: 30, y: 300 } })
    .catch(() => {})
  await page.keyboard.press('Control+Shift+KeyP')
  check(
    await waitFor('painel some', async () => (await dock().count()) === 0, 5000),
    'Ctrl+Shift+P esconde o painel',
  )
  check((await dockPref())?.mode === 'off', 'modo escondido gravado')
  await shot('painel-escondido')
  await page.keyboard.press('Control+Shift+KeyP')
  check(
    await waitFor('painel volta', async () => (await dockId()) === idM1, 5000),
    'Ctrl+Shift+P mostra o painel de novo (M1)',
  )
  await page.keyboard.press('Control+Shift+KeyO')
  check(
    await waitFor('foco no painel', focusInDock, 5000),
    'Ctrl+Shift+O leva o foco ao xterm do painel',
  )
  // Com o foco no xterm, o atalho do painel não vira ^P na PTY.
  const stdinBeforeP = stdinOf(m1Pid).length
  await page.keyboard.press('Control+Shift+KeyP')
  check(
    await waitFor('painel some (xterm)', async () => (await dock().count()) === 0, 5000),
    'Ctrl+Shift+P funciona com o foco no xterm',
  )
  await page.waitForTimeout(400)
  check(stdinOf(m1Pid).length === stdinBeforeP, 'nada chegou ao stdin de M1 pelo atalho')
  await page.keyboard.press('Control+Shift+KeyP')
  await waitFor('painel volta 2', async () => (await dockId()) === idM1, 5000)

  // ---------- F2 do plano: pílulas das filhas ----------
  const pills = dock().getByTestId('child-pill')
  check(
    await waitFor('pílulas', async () => (await pills.count()) === 2, 5000),
    'duas pílulas (C1, C2) no rodapé do painel',
  )
  const pillIds = await pills.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-session-id')),
  )
  const tones = await pills.evaluateAll((els) => els.map((e) => e.getAttribute('data-tone')))
  check(
    pillIds.includes(c1.id) && pillIds.includes(c2.id) && tones.every(Boolean),
    `pílulas de C1 e C2 com tom (${tones.join(', ')})`,
  )
  await shot('pilulas')
  await dock().locator(`[data-testid="child-pill"][data-session-id="${c2.id}"]`).click()
  await page.waitForTimeout(700)
  const c2Box = await card(c2.id).boundingBox()
  const mapB = (await page.getByTestId('session-map').boundingBox())!
  const dx = c2Box ? Math.abs(c2Box.x + c2Box.width / 2 - (mapB.x + mapB.width / 2)) : 1e9
  const dy = c2Box ? Math.abs(c2Box.y + c2Box.height / 2 - (mapB.y + mapB.height / 2)) : 1e9
  check(
    dx <= 40 && dy <= 40,
    `clique na pílula centraliza o cartão de C2 (Δ ${dx.toFixed(0)},${dy.toFixed(0)}px)`,
  )

  // Marca o xterm do painel: depois do lift ele tem de ser o MESMO nó, com o buffer.
  await page.evaluate(() => {
    const x = document.querySelector<HTMLElement>('[data-testid="mother-dock"] .xterm')
    if (x) x.dataset.e2eMark = 'painel'
  })
  const modal = page.locator('[role="dialog"][data-peek-mode="terminal"]')
  await dock().locator(`[data-testid="child-pill"][data-session-id="${c1.id}"]`).dblclick()
  check(
    await waitFor('lift de C1', async () => modal.isVisible(), 10_000),
    'duplo clique na pílula abre o lift de C1',
  )
  await shot('lift-c1')
  await page.keyboard.press('Escape')
  check(await waitFor('lift fecha', async () => !(await modal.isVisible()), 5000), 'fechar o lift')
  await dock().locator(`[data-testid="child-pill"][data-session-id="${c2.id}"]`).focus()
  await page.keyboard.press('Enter')
  check(
    await waitFor('lift de C2', async () => modal.isVisible(), 10_000),
    'Enter na pílula abre o lift de C2',
  )
  await page.keyboard.press('Escape')
  await waitFor('lift fecha 2', async () => !(await modal.isVisible()), 5000)
  const kept = await page.evaluate(() => {
    const x = document.querySelector<HTMLElement>('[data-testid="mother-dock"] .xterm')
    return {
      same: x?.dataset.e2eMark === 'painel',
      text: x?.querySelector('.xterm-rows')?.textContent ?? '',
    }
  })
  check(kept.same, 'depois do lift o painel segue com o MESMO xterm (não remontou)')
  check(kept.text.includes('ola-pelo-painel'), 'o buffer do painel manteve o que foi digitado')
  await dock().locator('.xterm').click()
  await page.keyboard.type('depois-do-lift')
  await page.keyboard.press('Enter')
  check(
    await waitFor(
      'stdin de M1 pós-lift',
      async () => stdinOf(m1Pid).includes('stdin: depois-do-lift'),
      10_000,
    ),
    'o painel continua digitando em M1 depois do lift',
  )
  check(!stdinOf(m2Pid).includes('ola-pelo-painel'), 'nada digitado em M1 vazou para M2')
  await shot('final')
} catch (err) {
  fatal = err
  console.error('[panel] erro fatal:', err)
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
console.log('\n[panel] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(
  `[panel] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS} · log ${logs.logFile}`,
)
if (fatal || failed.length) process.exit(1)
