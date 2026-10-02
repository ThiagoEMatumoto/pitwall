import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// Redimensionar as janelas de terminal, sobre a CÓPIA do perfil real com HOME
// fake e PTYs vivas de um stub `claude` que registra cada SIGWINCH (stty size).
//   M = mãe (Ctrl+N, com aba) · F, G = filhas de M (sem aba, handoff)
// Asserções (evidência positiva):
//   1. modal de F: arrastar o canto → durante o arrasto só a moldura (ghost)
//      anda, a modal fica e ZERO IPC resize; ao soltar o tamanho muda, EXATAMENTE
//      1 IPC sessions:resize de F e o stub de F vê 1 SIGWINCH com cols/rows novos
//   2. fechar e reabrir F → o mesmo tamanho; G → tamanho padrão
//   3. "Tamanho padrão" volta F ao padrão
//   4. cartão de G no mapa: alça do canto → w/h maiores no nó, mais linhas no tail,
//      e w/h no canvas (IPC canvas:get); recarregar a janela → o mesmo tamanho e
//      nenhum cartão sobreposto
//   5. separador do painel da mãe: 1 resize de M ao soltar, largura persistida
//      (cm:mother-dock); duplo clique volta a 55%
//   6. relaunch com o mesmo userData → canvas_positions de G com w/h (app.db) e o
//      tamanho de F em pitwall.liftSizes
// Rodar: MP2_SHOTS=<dir> npx tsx e2e/scenarios/terminal-resize.ts

const SHOTS =
  process.env.MP2_SHOTS ??
  '/home/thiagoematumoto/projetos/pessoal/claude-manager/.worktrees/feat-mother-panel/.cm-drive/mp2/drive/MP2-resize'
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub vivo: banner, 12 linhas de saída, caixa de input e eco do stdin. O trap de
// WINCH grava o tamanho que a PTY passou a ter — é o que o "agente" vê.
function liveStub(sessionsDir: string, logDir: string): string {
  const rule = '─'.repeat(50)
  return `#!/usr/bin/env bash
SESSIONS_DIR=${shq(sessionsDir)}
LOGDIR=${shq(logDir)}
LOG="$LOGDIR/claude-$$.log"
printf 'argv:' >> "$LOG"; for a in "$@"; do printf ' %q' "$a" >> "$LOG"; done; printf '\\n' >> "$LOG"
trap 'printf "winch: %s\\n" "$(stty size 2>/dev/null)" >> "$LOG"' WINCH
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
for i in $(seq 1 24); do printf '\\u23fa linha %s da saida para o tail\\n' "$i"; done
box
while true; do
  if IFS= read -t 0.2 -r line; then
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
  console.log(`[resize] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
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
console.log(`[resize] repo: ${repo.label}`)
writeCopyPrefs(userData, {
  claude_command: stub,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

// ---------- 2ª subida: app real, HOME fake ----------
let { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
async function sizeWindow() {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w?.unmaximize()
    w?.setSize(1600, 1000)
  })
  await page.waitForTimeout(500)
}
await sizeWindow()
const consoleErrors: string[] = []
const watchConsole = () => {
  page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
  })
}
watchConsole()
const shot = (name: string) =>
  page
    .screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
    .catch(() => {})

// Recarregar volta à Home e o atalho do mapa só vale em Projetos; o mapa pode já
// voltar aberto (aí a tecla o fecharia), então só aperta enquanto ele não aparece.
async function ensureMap() {
  await goToArea(page, 'projects')
  for (let i = 0; i < 8; i++) {
    if (await page.getByTestId('session-map').isVisible().catch(() => false)) return
    await page.keyboard.press('Control+Shift+KeyG')
    await page.waitForTimeout(1500)
  }
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[resize] timeout esperando: ${label}`)
      await shot(`timeout-${label.replace(/\W+/g, '-')}`)
      return false
    }
    await page.waitForTimeout(250)
  }
}

interface Live {
  id: string
  ccSessionId: string
  pid?: number
}
const live = () => page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<Live[]>
const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const stubLog = (pid: number | undefined) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return pid && existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const winches = (pid: number | undefined) =>
  stubLog(pid)
    .split('\n')
    .filter((l) => l.startsWith('winch: '))
    .map((l) => l.slice(7).trim())
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const flowNode = (id: string) => page.locator(`.react-flow__node[data-id="s:${id}"]`)
const lift = page.locator('[role="dialog"][data-peek-lift]')
const liftTerminal = page.locator('[role="dialog"][data-peek-lift][data-peek-mode="terminal"]')
const liftXterm = liftTerminal.locator('.xterm')
const mapVisible = () => page.getByTestId('session-map').isVisible()
const liftSize = async () => ({
  w: Number(await lift.getAttribute('data-lift-w')),
  h: Number(await lift.getAttribute('data-lift-h')),
})

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

async function openModal(id: string): Promise<boolean> {
  await card(id).getByTestId('card-interact').click()
  const ok = await waitFor(`modal de ${id}`, async () => (await liftTerminal.count()) === 1)
  await waitFor('xterm da modal', async () => (await liftXterm.count()) === 1)
  // O fit inicial da modal (replay + fonte) assenta antes de medir qualquer coisa.
  await page.waitForTimeout(1500)
  return ok
}
async function closeModal() {
  await page.getByRole('dialog').getByLabel('Fechar').click()
  await waitFor('modal fecha', async () => (await lift.count()) === 0, 5000)
  await page.waitForTimeout(400)
}

// Arrasto em passos (o ponteiro passa por pontos intermediários, como a mão).
async function drag(
  from: { x: number; y: number },
  dx: number,
  dy: number,
  mid?: () => Promise<void>,
) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10)
    await page.waitForTimeout(30)
  }
  if (mid) await mid()
  await page.mouse.up()
}

const overlapping = async () =>
  page.evaluate(() => {
    const rects = [...document.querySelectorAll<HTMLElement>('.react-flow__node-session')].map(
      (el) => ({ id: el.dataset.id, r: el.getBoundingClientRect() }),
    )
    const hits: string[] = []
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].r
        const b = rects[j].r
        if (
          a.left < b.right - 1 &&
          a.right > b.left + 1 &&
          a.top < b.bottom - 1 &&
          a.bottom > b.top + 1
        )
          hits.push(`${rects[i].id}×${rects[j].id}`)
      }
    return { n: rects.length, hits }
  })

let fatal: unknown = null
let idF = ''
let idG = ''
let liftF = { w: 0, h: 0 }
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  check(await installResizeSpy(), 'spy do IPC sessions:resize instalado no main')

  // ---------- M (Ctrl+N), F e G (filhas sem aba) ----------
  await goToArea(page, 'projects')
  const beforeM = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(repo.label)
  await search.press('Enter')
  await page
    .locator('div.fixed.inset-0', { hasText: `Nova sessão · ${repo.label}` })
    .getByRole('button', { name: 'Abrir', exact: true })
    .click()
  let fileM: FakeSessionEntry | undefined
  await waitFor('session file de M', async () => {
    fileM = files().find((f) => !beforeM.has(f.data.pid))
    return !!fileM
  })
  let idM = ''
  await waitFor('sessions.id de M', async () => {
    idM = (await live()).find((s) => s.ccSessionId === fileM?.data.sessionId)?.id ?? ''
    return idM !== ''
  })
  check(!!idM, `M aberta por Ctrl+N em ${repo.label}`)

  const spawnChild = async (name: string, task: string) => {
    const before = new Set(files().map((f) => f.data.pid))
    const id = await page.evaluate(
      async ({ repoId, mother, name, task }) => {
        const b = await window.api.sessions.spawn({ repoId, name, handoffChild: true })
        const { handoff } = await window.api.handoffs.createManual({
          repoId,
          motherSessionId: mother,
          task,
        })
        await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: b.id })
        return b.id
      },
      { repoId: repo.id, mother: idM, name, task },
    )
    let file: FakeSessionEntry | undefined
    await waitFor(`session file de ${name}`, async () => {
      file = files().find((f) => !before.has(f.data.pid))
      return !!file
    })
    return { id, pid: file?.data.pid }
  }
  const childF = await spawnChild('filha-resize-f', 'Conferir o redimensionar da modal')
  const childG = await spawnChild('filha-resize-g', 'Conferir o redimensionar do cartão')
  idF = childF.id
  idG = childG.id

  await page.keyboard.press('Control+Shift+KeyG')
  check(await waitFor('mapa', mapVisible), 'Ctrl+Shift+G abre o mapa')
  check(
    await waitFor(
      'cartões de M, F e G',
      async () =>
        (await card(idM).count()) + (await card(idF).count()) + (await card(idG).count()) === 3,
    ),
    'cartões de M, F e G no mapa',
  )
  // O painel da mãe abre sozinho; nas partes 1-4 ele fica escondido (a parte 5 o usa).
  if (
    await waitFor(
      'painel automático',
      async () => (await page.getByTestId('mother-dock').count()) > 0,
      5000,
    )
  ) {
    await page.keyboard.press('Control+Shift+KeyP')
  }
  await waitFor(
    'painel escondido',
    async () => (await page.getByTestId('mother-dock').count()) === 0,
    5000,
  )
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await page.waitForTimeout(700)
  await shot('mapa')

  // ---------- 1. modal de F: arrastar o canto ----------
  check(await openModal(idF), 'botão Terminal abre a modal de F')
  const win = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  const defaultSize = {
    w: Math.round(Math.min(win.w - 48, Math.max(520, Math.min(1400, win.w * 0.94)))),
    h: Math.round(Math.min(win.h - 48, Math.max(320, win.h * 0.9))),
  }
  const s0 = await liftSize()
  check(
    s0.w === defaultSize.w && s0.h === defaultSize.h,
    `F abre no tamanho padrão (${s0.w}x${s0.h}; esperado ${defaultSize.w}x${defaultSize.h})`,
  )
  await lift.hover()
  const handle = page.getByTestId('peek-resize-se')
  check(await handle.isVisible(), 'alça do canto visível no hover da modal')
  const cursor = await handle.evaluate((el) => getComputedStyle(el).cursor)
  check(cursor === 'nwse-resize', `cursor da alça do canto = ${cursor}`)
  const hb = (await handle.boundingBox())!
  const logBefore = (await resizeLog()).length
  const winchBefore = winches(childF.pid)
  let midResizes = -1
  let midSize = { w: 0, h: 0 }
  let ghostSeen = false
  await drag({ x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, -150, -100, async () => {
    midResizes = (await resizeLog()).length - logBefore
    midSize = await liftSize()
    ghostSeen = await page.getByTestId('peek-resize-ghost').isVisible()
    await shot('modal-arrastando')
  })
  check(
    ghostSeen && midSize.w === s0.w && midSize.h === s0.h && midResizes === 0,
    `durante o arrasto só a moldura anda (modal ${midSize.w}x${midSize.h}, ghost ${ghostSeen}, ${midResizes} resizes)`,
  )
  await page.waitForTimeout(1500)
  const s1 = await liftSize()
  const box1 = await lift.boundingBox()
  check(
    Math.abs(s1.w - (s0.w - 300)) <= 2 && Math.abs(s1.h - (s0.h - 200)) <= 2,
    `soltar aplica o tamanho, centrado (${s0.w}x${s0.h} → ${s1.w}x${s1.h})`,
  )
  check(
    !!box1 &&
      Math.abs(box1.x + box1.width / 2 - win.w / 2) <= 2 &&
      Math.abs(box1.y + box1.height / 2 - win.h / 2) <= 2,
    'a modal continua centrada',
  )
  const dragResizes = (await resizeLog()).slice(logBefore).filter((r) => r.id === idF)
  check(
    dragResizes.length === 1,
    `exatamente 1 IPC sessions:resize de F ao soltar (${JSON.stringify(dragResizes)})`,
  )
  const winchAfter = winches(childF.pid)
  const newWinch = winchAfter.slice(winchBefore.length)
  const [rows, cols] = (newWinch[0] ?? '').split(' ').map(Number)
  check(
    newWinch.length === 1 &&
      cols === dragResizes[0]?.cols &&
      rows === dragResizes[0]?.rows &&
      newWinch[0] !== winchBefore.at(-1),
    `o stub de F viu 1 SIGWINCH com o tamanho novo (${winchBefore.at(-1)} → ${newWinch.join(' | ')})`,
  )
  check(await page.getByTestId('peek-size-reset').isVisible(), '"Tamanho padrão" aparece no header')
  await shot('modal-redimensionada')
  liftF = s1

  // ---------- 2. fechar e reabrir F; G no padrão ----------
  await closeModal()
  await openModal(idF)
  const s2 = await liftSize()
  check(s2.w === s1.w && s2.h === s1.h, `reabrir F mantém ${s1.w}x${s1.h} (veio ${s2.w}x${s2.h})`)
  await closeModal()
  await openModal(idG)
  const sG = await liftSize()
  check(
    sG.w === defaultSize.w &&
      sG.h === defaultSize.h &&
      (await page.getByTestId('peek-size-reset').count()) === 0,
    `G (outra sessão) abre no padrão ${sG.w}x${sG.h}, sem "Tamanho padrão"`,
  )
  await closeModal()

  // ---------- 3. "Tamanho padrão" em F (e o duplo clique na alça) ----------
  await openModal(idF)
  await page.getByTestId('peek-size-reset').click()
  await page.waitForTimeout(800)
  const s3 = await liftSize()
  check(
    s3.w === defaultSize.w && s3.h === defaultSize.h,
    `"Tamanho padrão" volta F a ${s3.w}x${s3.h}`,
  )
  // Redimensiona de novo (para a persistência no relaunch) e confere o duplo clique.
  await lift.hover()
  const hb2 = (await page.getByTestId('peek-resize-se').boundingBox())!
  await drag({ x: hb2.x + hb2.width / 2, y: hb2.y + hb2.height / 2 }, -150, -100)
  await page.waitForTimeout(800)
  liftF = await liftSize()
  await page.getByTestId('peek-resize-e').dblclick()
  await page.waitForTimeout(800)
  const s4 = await liftSize()
  check(
    s4.w === defaultSize.w && s4.h === defaultSize.h,
    `duplo clique na borda volta ao padrão (${s4.w}x${s4.h})`,
  )
  await drag({ x: hb2.x + hb2.width / 2, y: hb2.y + hb2.height / 2 }, -150, -100)
  await page.waitForTimeout(800)
  liftF = await liftSize()
  await closeModal()

  // ---------- 4. cartão de G no mapa ----------
  // F e G nascem em ordem variável: com G embaixo, a alça fica fora da tela. Puxa
  // o mapa pelo fundo até G caber com folga para crescer.
  {
    const bG = await flowNode(idG).boundingBox()
    const need = bG ? bG.y + bG.height + 320 - (win.h - 60) : 0
    if (need > 0) {
      const pane = (await page.locator('.react-flow__pane').boundingBox())!
      const px = pane.x + pane.width - 120
      const py = pane.y + pane.height - 80
      await page.mouse.move(px, py)
      await page.mouse.down()
      await page.mouse.move(px, py - need, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(500)
    }
  }
  const zoom = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.react-flow__viewport')
    return new DOMMatrix(el ? getComputedStyle(el).transform : 'none').a
  })
  const nodeSize = async () => {
    const b = await flowNode(idG).boundingBox()
    return { w: (b?.width ?? 0) / zoom, h: (b?.height ?? 0) / zoom }
  }
  const tailLines = () => card(idG).locator('[data-testid="card-live-tail"] pre > div').count()
  await waitFor('tail de G', async () => (await tailLines()) > 0)
  const n0 = await nodeSize()
  const lines0 = await tailLines()
  await flowNode(idG).hover()
  const resizer = flowNode(idG).getByTestId('card-resize')
  check(await resizer.isVisible(), 'alça do cartão visível no hover')
  const rb = (await resizer.boundingBox())!
  const logCard = (await resizeLog()).length
  await drag({ x: rb.x + rb.width / 2, y: rb.y + rb.height / 2 }, 160 * zoom, 260 * zoom)
  await page.waitForTimeout(1200)
  const n1 = await nodeSize()
  const lines1 = await tailLines()
  check(
    n1.w > n0.w + 100 && n1.h > n0.h + 150,
    `o cartão de G cresce (${n0.w.toFixed(0)}x${n0.h.toFixed(0)} → ${n1.w.toFixed(0)}x${n1.h.toFixed(0)} no fluxo)`,
  )
  check(lines1 > lines0, `o tail ao vivo mostra mais linhas (${lines0} → ${lines1})`)
  check(
    (await card(idG).getAttribute('data-sized')) === 'true',
    'o cartão marca data-sized (preenche a vaga do usuário)',
  )
  check(
    (await resizeLog()).length === logCard,
    'redimensionar o cartão não manda resize a nenhuma PTY',
  )
  const savedG = await page.evaluate(async (id) => {
    const scopes = [
      'all',
      ...new Set(
        (await window.api.sessions.listLiveGlobal()).map((s) => s.projectId).filter(Boolean),
      ),
    ]
    for (const scope of scopes) {
      const c = await window.api.canvas.get({ scope: scope as string })
      const p = c.positions.find((x) => x.kind === 'session' && x.entityId === id)
      if (p?.w && p?.h) return { scope, w: p.w, h: p.h }
    }
    return null
  }, idG)
  check(
    !!savedG && Math.abs(savedG.w - n1.w) <= 3 && Math.abs(savedG.h - n1.h) <= 3,
    `w/h de G gravados no canvas (${JSON.stringify(savedG)})`,
  )
  const ov1 = await overlapping()
  check(
    ov1.hits.length === 0,
    `nenhum cartão sobreposto após redimensionar (${ov1.n} cartões; ${ov1.hits.join(', ')})`,
  )
  // Regressão: gravar só G fazia o layout re-empilhar a mãe (sem posição salva)
  // abaixo dele, deixando um vão no topo da raia.
  const yM = (await flowNode(idM).boundingBox())?.y ?? Infinity
  const yG = (await flowNode(idG).boundingBox())?.y ?? -Infinity
  check(yM < yG, `a mãe segue acima de G após redimensionar (M y=${yM.toFixed(0)}, G y=${yG.toFixed(0)})`)
  await shot('cartao-redimensionado')

  await page.reload()
  await waitReady(page)
  await ensureMap()
  await waitFor('mapa após recarregar', mapVisible)
  await waitFor('cartão de G após recarregar', async () => (await card(idG).count()) === 1)
  await page.waitForTimeout(1200)
  const zoomR = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.react-flow__viewport')
    return new DOMMatrix(el ? getComputedStyle(el).transform : 'none').a
  })
  const bR = await flowNode(idG).boundingBox()
  const nR = { w: (bR?.width ?? 0) / zoomR, h: (bR?.height ?? 0) / zoomR }
  check(
    Math.abs(nR.w - n1.w) <= 3 && Math.abs(nR.h - n1.h) <= 3,
    `recarregar mantém o tamanho do cartão (${nR.w.toFixed(0)}x${nR.h.toFixed(0)})`,
  )
  const ov2 = await overlapping()
  check(ov2.hits.length === 0, `após recarregar, nenhum cartão sobreposto (${ov2.hits.join(', ')})`)
  await shot('mapa-recarregado')

  // ---------- 5. separador do painel da mãe ----------
  await page.keyboard.press('Control+Shift+KeyP')
  const dock = page.getByTestId('mother-dock')
  await waitFor('painel visível', async () => (await dock.count()) === 1)
  await page.waitForTimeout(1500)
  const sep = page.getByTestId('mother-dock-resize')
  const sb = (await sep.boundingBox())!
  const w0 = (await dock.boundingBox())!.width
  const logSep = (await resizeLog()).length
  let sepMid = -1
  await drag({ x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 }, -150, 0, async () => {
    sepMid = (await resizeLog()).length - logSep
  })
  await page.waitForTimeout(1200)
  const w1 = (await dock.boundingBox())!.width
  const sepResizes = (await resizeLog()).slice(logSep).filter((r) => r.id === idM)
  check(sepMid === 0, `separador: zero resize durante o arrasto (${sepMid})`)
  check(
    w1 < w0 - 100 && sepResizes.length === 1,
    `separador: ${w0.toFixed(0)}→${w1.toFixed(0)}px e exatamente 1 resize de M (${sepResizes.length})`,
  )
  const share = () =>
    page.evaluate(() => {
      try {
        return (
          (JSON.parse(localStorage.getItem('cm:mother-dock') ?? '{}') as { share?: number })
            .share ?? null
        )
      } catch {
        return null
      }
    })
  const share1 = await share()
  check(share1 !== null && share1 < 0.55, `largura persistida em cm:mother-dock (share ${share1})`)
  await page.reload()
  await waitReady(page)
  await ensureMap()
  await waitFor('painel após recarregar', async () => (await dock.count()) === 1)
  await page.waitForTimeout(1000)
  const wR = (await dock.boundingBox())!.width
  check(
    Math.abs(wR - w1) <= 3,
    `recarregar mantém a largura do painel (${w1.toFixed(0)} → ${wR.toFixed(0)})`,
  )
  await sep.dblclick()
  await page.waitForTimeout(800)
  const share2 = await share()
  check(share2 === 0.55, `duplo clique no separador volta a 55% (share ${share2})`)
  await shot('painel-55')

  check(consoleErrors.length === 0, `zero erros de console (${consoleErrors.length})`)
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 5).join('\n---\n'))
} catch (err) {
  fatal = err
  console.error('[resize] erro fatal:', err)
  await shot('fatal')
}

// ---------- 6. relaunch com o mesmo userData ----------
async function closeApp() {
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
}
await closeApp()
if (!fatal) {
  try {
    const rowsG = await queryDb<{ w: number | null; h: number | null }>(
      userData,
      `SELECT w, h FROM canvas_positions WHERE kind = 'session' AND entity_id = '${idG}'`,
    )
    check(
      rowsG.some((r) => r.w != null && r.h != null),
      `app.db após fechar: canvas_positions de G com w/h (${JSON.stringify(rowsG)})`,
    )
    ;({ app, page } = await launchApp({ userDataDir: userData, env: fake.env }))
    await waitReady(page)
    const saved = await page.evaluate((id) => {
      try {
        return (
          (
            JSON.parse(localStorage.getItem('pitwall.liftSizes') ?? '{}') as Record<
              string,
              { w: number; h: number }
            >
          )[id] ?? null
        )
      } catch {
        return null
      }
    }, idF)
    check(
      !!saved && saved.w === liftF.w && saved.h === liftF.h,
      `relaunch: tamanho da modal de F lembrado (${JSON.stringify(saved)} = ${liftF.w}x${liftF.h})`,
    )
    await shot('relaunch')
  } catch (err) {
    fatal = err
    console.error('[resize] erro no relaunch:', err)
  } finally {
    await closeApp()
  }
}
fake.cleanup()

const failed = results.filter((r) => !r.ok)
console.log(
  `\n[resize] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS}`,
)
if (fatal || failed.length) process.exit(1)
