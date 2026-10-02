import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// F3 + F4 do painel da mãe, sobre a CÓPIA do perfil com HOME fake e stubs vivos:
//   M (Ctrl+N, com aba) + C1/C2 (filhas de handoff, PTYs vivas), M no painel
//   → F no cartão C1 selecionado: zoom = min(fit, 1) calculado à parte da área
//     livre do mapa (cabendo, 1.0 e largura na tela = layout ±2px), zero IPC resize
//   → 2º F restaura (x, y, zoom) exato; F + Esc também
//   → "f" digitado no xterm do painel vai ao stdin do stub e não dá zoom
//   → aba de M em "Aberta no Mapa"; o botão "Abrir na aba" do painel leva a PTY
//     para a aba (digitar chega ao stdin) e voltar ao mapa devolve ao painel
//   → modal por cima do painel: placeholder do painel (sem "Abrir aqui"); Esc
//     devolve a PTY ao painel e digitar chega ao stdin
//   → Mapa → Terminais: o Mapa desmonta, a lease sai e a aba monta o xterm
// Rodar: ZOOM_SHOTS=<dir> npx tsx e2e/scenarios/map-zoom-to-card.ts

const SHOTS =
  process.env.ZOOM_SHOTS ??
  '/home/thiagoematumoto/projetos/pessoal/claude-manager/.worktrees/feat-mother-panel/.cm-drive/mp/drive/MP-zoom'
mkdirSync(SHOTS, { recursive: true })
const fake = createFakeHome({ parentDir: tmpdir() })
let shotN = 0

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Stub vivo (o mesmo de mother-prominent.ts): caixa de input ociosa e eco do
// stdin, linha a linha, em claude-<pid>.log.
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
for i in 1 2 3 4 5 6; do printf '\\u23fa linha %s da saida\\n' "$i"; done
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
  console.log(`[zoom] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
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
console.log(`[zoom] repo: ${repo.label}`)
writeCopyPrefs(userData, {
  claude_command: stub,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

// ---------- 2ª subida: app real, HOME fake ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
})
const shot = (name: string) =>
  page
    .screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
    .catch(() => {})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[zoom] timeout esperando: ${label}`)
      await shot(`timeout-${label.replace(/\W+/g, '-')}`)
      return false
    }
    await page.waitForTimeout(250)
  }
}

interface Live {
  id: string
  ccSessionId: string
}
const live = () => page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<Live[]>
const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const pidOf = (cc: string | null | undefined) =>
  files().find((f) => f.data.sessionId === cc)?.data.pid
const stdinOf = (pid: number | undefined) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return pid && existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const dock = page.getByTestId('mother-dock')
const lift = page.locator('[role="dialog"][data-peek-lift]')
const mapVisible = () => page.getByTestId('session-map').isVisible()
const viewport = () =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.react-flow__viewport')
    const m = new DOMMatrix(el ? getComputedStyle(el).transform : 'none')
    return { x: m.e, y: m.f, zoom: m.a }
  })
type Vp = Awaited<ReturnType<typeof viewport>>
const sameViewport = (a: Vp, b: Vp) =>
  Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3
const fmt = (v: Vp) => `${v.x.toFixed(1)},${v.y.toFixed(1)}@${v.zoom.toFixed(3)}`
// O xterm da ABA: qualquer .xterm fora do painel da mãe e da modal do mapa (o
// dockview monta o conteúdo das panes fora do .dv-groupview).
const tabXterms = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('.xterm')].filter(
        (el) => !el.closest('[data-testid="mother-dock"]') && !el.closest('[data-peek-lift]'),
      ).length,
  )
const tabPlaceholder = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[data-testid="terminal-leased"]')].find(
      (e) => !e.closest('[data-testid="mother-dock"]') && !e.closest('[data-peek-lift]'),
    )
    return el ? { owner: el.dataset.owner ?? '', text: el.innerText } : null
  })
// O fim da animação do setViewport (250ms): espera o transform parar de mudar.
async function settle(): Promise<Vp> {
  let prev = await viewport()
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(120)
    const now = await viewport()
    if (sameViewport(prev, now) && i > 2) return now
    prev = now
  }
  return prev
}

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
const resizeCount = () =>
  app.evaluate(
    () =>
      ((globalThis as unknown as { __resizeLog?: unknown[] }).__resizeLog ?? []).length as number,
  )

let fatal: unknown = null
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  check(await installResizeSpy(), 'spy do IPC sessions:resize instalado no main')

  // ---------- M por Ctrl+N (com aba) ----------
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
  const mPid = fileM?.data.pid
  check(
    !!idM && (await waitFor('xterm da aba de M', async () => (await tabXterms()) >= 1)),
    `M aberta por Ctrl+N em ${repo.label}, com aba e xterm`,
  )

  // ---------- C1/C2: filhas de M ----------
  const kids = await page.evaluate(
    async ({ repoId, mother }) => {
      const out: Array<{ id: string; cc: string | null }> = []
      for (const [name, task] of [
        ['filha-zoom-um', 'Ajustar o checkout'],
        ['filha-zoom-dois', 'Revisar o estorno'],
      ] as const) {
        const c = await window.api.sessions.spawn({ repoId, name, handoffChild: true })
        const { handoff } = await window.api.handoffs.createManual({
          repoId,
          motherSessionId: mother,
          task,
        })
        await window.api.handoffs.markRunning({ id: handoff.id, childSessionId: c.id })
        out.push({ id: c.id, cc: c.ccSessionId })
      }
      return out
    },
    { repoId: repo.id, mother: idM },
  )
  const [c1] = kids
  check(
    await waitFor('PTYs de C1/C2', async () => kids.every((k) => pidOf(k.cc) !== undefined)),
    'C1 e C2 com PTYs vivas (stub)',
  )

  // ---------- mapa + M no painel ----------
  await page.keyboard.press('Control+Shift+KeyG')
  check(await waitFor('mapa', mapVisible, 10_000), 'Ctrl+Shift+G abre o mapa')
  check(
    await waitFor(
      'cartões',
      async () => (await card(idM).count()) > 0 && (await card(c1.id).count()) > 0,
    ),
    'cartões de M e C1 no mapa',
  )
  // O painel troca sozinho (F1) ou fica pela fixação: se não veio sozinho, fixa.
  const autoDock = await waitFor(
    'painel automático',
    async () => (await dock.getAttribute('data-session-id').catch(() => null)) === idM,
    4000,
  )
  if (!autoDock) await card(idM).getByTestId('mother-pin').click()
  check(
    await waitFor(
      'xterm de M no painel',
      async () =>
        (await dock.getAttribute('data-session-id').catch(() => null)) === idM &&
        (await dock.locator('.xterm').count()) === 1,
      15_000,
    ),
    `M no painel com um xterm real (${autoDock ? 'automático' : 'fixada'})`,
  )
  const ph = await waitFor(
    'aba em "Aberta no Mapa"',
    async () => (await tabPlaceholder())?.owner === 'dock' && (await tabXterms()) === 0,
    10_000,
  )
  check(ph, `a aba de M cede: "${(await tabPlaceholder())?.text.split('\n')[0]}" sem xterm`)
  check(
    ((await tabPlaceholder())?.text ?? '').includes('Aberta no Mapa') &&
      ((await tabPlaceholder())?.text ?? '').includes('Abrir aqui'),
    'placeholder da aba diz "Aberta no Mapa" com o botão "Abrir aqui"',
  )
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await settle()
  await shot('painel-e-mapa')

  // ---------- F3: zoom-to-card ----------
  // Seleciona C1 pelo status (o clique num recolhido espia: fecha a espiada).
  await card(c1.id).getByTestId('card-status').click()
  if (await waitFor('espiada (opcional)', async () => (await lift.count()) > 0, 1500)) {
    await page.keyboard.press('Escape')
    await waitFor('espiada fecha', async () => (await lift.count()) === 0, 5000)
  }
  check(
    await waitFor('C1 selecionado', async () =>
      page.evaluate(
        (id) =>
          !!document
            .querySelector(`[data-testid="session-card"][data-session-id="${id}"]`)
            ?.closest('.react-flow__node.selected'),
        c1.id,
      ),
    ),
    'C1 selecionado no mapa',
  )
  // Foco no nó (não muda a seleção): a tecla sai do mapa, não de um campo.
  await page.evaluate((id) => {
    document
      .querySelector(`[data-testid="session-card"][data-session-id="${id}"]`)
      ?.closest<HTMLElement>('.react-flow__node')
      ?.focus()
  }, c1.id)
  const vp0 = await settle()
  const resizesBefore = await resizeCount()
  await page.keyboard.press('f')
  const vp1 = await settle()
  // Largura de layout medida DEPOIS do F: a 1.0 o cartão sai do resumo (compacto)
  // e fica mais largo.
  const layoutW = await card(c1.id).evaluate((el) => (el as HTMLElement).offsetWidth)
  const boxC1 = await card(c1.id).boundingBox()
  const mapBox = await page.getByTestId('session-map').boundingBox()
  // min(fit, 1): a 1.0 quando o cartão cabe; menor só o bastante para caber
  // inteiro — e nunca no resumo (compacto, < 0.74), onde ele não se lê.
  // Zoom esperado calculado à parte: a área livre do mapa (descontando o que flutua
  // por cima: barra, controles, minimapa, painéis à direita) e o cartão no layout.
  // Cabe a 1.0 → tem de ser 1.0 (e o cartão com a largura de layout na tela).
  const layoutH = await card(c1.id).evaluate((el) => (el as HTMLElement).offsetHeight)
  // O tsx (keepNames) embrulha as arrows nomeadas abaixo em __name(), que não existe
  // na página; string não passa pelo esbuild.
  await page.evaluate('globalThis.__name ??= (f) => f')
  const free = await page.evaluate(() => {
    const map = document.querySelector<HTMLElement>('[data-testid="session-map"]')!
    const box = map.getBoundingClientRect()
    const r = (sel: string) => {
      const b = map.querySelector<HTMLElement>(sel)?.getBoundingClientRect()
      return b && b.height > 0 ? b : null
    }
    const bar = r('[data-testid="map-top-bar"]')
    const controls = r('.react-flow__controls')
    const minimap = r('.react-flow__minimap')
    const right = [
      document.querySelector<HTMLElement>('[data-testid="crew-dock"][data-overlay]'),
      map.querySelector<HTMLElement>('[data-testid="feature-panel"]'),
    ]
      .map((e) => e?.getBoundingClientRect())
      .filter((b) => b && b.width > 0 && b.left < box.right)
      .map((b) => box.right - b!.left)
    const gap = 8
    const top = bar ? bar.bottom - box.top + gap : 0
    const left = controls ? controls.right - box.left + gap : 0
    const bottom = minimap ? box.bottom - minimap.top + gap : 0
    const rightIn = right.length ? Math.max(...right) + gap : 0
    return { w: box.width - left - rightIn, h: box.height - top - bottom }
  })
  const expectedZoom = Math.min(1, (free.w - 48) / layoutW, (free.h - 48) / layoutH)
  check(
    Math.abs(vp1.zoom - expectedZoom) <= 0.02,
    `F enquadra em min(fit, 1): zoom ${vp1.zoom.toFixed(3)} ≈ esperado ${expectedZoom.toFixed(3)} (livre ${free.w.toFixed(0)}x${free.h.toFixed(0)}, cartão ${layoutW}x${layoutH})`,
  )
  check(
    expectedZoom < 1 || (!!boxC1 && Math.abs(boxC1.width - layoutW) <= 2),
    `cabendo a 1.0, C1 aparece no tamanho real (${boxC1?.width.toFixed(1)}px = layout ${layoutW}px)`,
  )
  check(vp1.zoom >= 0.74, `F nunca cai no resumo compacto (zoom ${vp1.zoom.toFixed(3)})`)
  check(
    !!boxC1 &&
      !!mapBox &&
      boxC1.x >= mapBox.x - 1 &&
      boxC1.x + boxC1.width <= mapBox.x + mapBox.width + 1 &&
      boxC1.y >= mapBox.y - 1 &&
      boxC1.y + boxC1.height <= mapBox.y + mapBox.height + 1,
    'C1 inteiro dentro do mapa depois do F',
  )
  await shot('F-c1-enquadrado')
  await page.keyboard.press('f')
  const vp2 = await settle()
  check(sameViewport(vp0, vp2), `2º F restaura o viewport exato (${fmt(vp0)} → ${fmt(vp2)})`)
  await page.keyboard.press('f')
  await settle()
  await page.keyboard.press('Escape')
  const vp3 = await settle()
  check(sameViewport(vp0, vp3), `F + Esc também restaura (${fmt(vp0)} → ${fmt(vp3)})`)
  check(
    (await resizeCount()) === resizesBefore,
    `zero IPC sessions:resize durante o zoom (${(await resizeCount()) - resizesBefore})`,
  )
  check(await mapVisible(), 'F/Esc não saem do mapa')
  await shot('F-restaurado')

  // ---------- F no xterm do painel: texto, não zoom ----------
  await dock.locator('.xterm').click()
  await page.keyboard.type('ffoo-no-painel')
  await page.keyboard.press('Enter')
  check(
    await waitFor(
      'stdin de M',
      async () => stdinOf(mPid).includes('stdin: ffoo-no-painel'),
      15_000,
    ),
    '"f" digitado no xterm do painel chega ao stdin do stub de M',
  )
  const vp4 = await settle()
  check(sameViewport(vp0, vp4), `"f" no xterm não dá zoom (${fmt(vp0)} → ${fmt(vp4)})`)
  await shot('f-no-xterm')

  // ---------- F4: "Abrir na aba" (botão VISÍVEL do painel) leva a PTY para a aba ----------
  // O placeholder da aba fica por baixo do mapa (o dockview segue montado) e não
  // se alcança com o mapa na tela: a porta do usuário é o cabeçalho do painel.
  await dock.getByTestId('mother-dock-open-tab').click()
  check(
    await waitFor(
      'aba com a PTY',
      async () =>
        (await page.getByTestId('session-map').count()) === 0 &&
        (await tabXterms()) === 1 &&
        (await tabPlaceholder()) === null,
      10_000,
    ),
    '"Abrir na aba": sai do mapa e a aba de M monta o xterm (sem placeholder)',
  )
  await page
    .locator('.xterm')
    .first()
    .click()
    .catch(() => {})
  await page.keyboard.type('pela-aba-do-painel')
  await page.keyboard.press('Enter')
  check(
    await waitFor('stdin pela aba do painel', async () =>
      stdinOf(mPid).includes('stdin: pela-aba-do-painel'),
    ),
    'depois do "Abrir na aba", digitar na aba chega ao stdin de M',
  )
  await shot('abrir-na-aba')
  await page.getByTestId('projects-view-map').click()
  check(
    await waitFor(
      'painel de volta',
      async () =>
        (await dock.locator('.xterm').count()) === 1 &&
        (await tabXterms()) === 0 &&
        (await tabPlaceholder())?.owner === 'dock',
      10_000,
    ),
    'de volta ao mapa: o painel retoma a PTY e a aba volta a "Aberta no Mapa"',
  )
  await dock.locator('.xterm').click()
  await page.keyboard.type('de-volta-no-painel')
  await page.keyboard.press('Enter')
  check(
    await waitFor('stdin de volta', async () =>
      stdinOf(mPid).includes('stdin: de-volta-no-painel'),
    ),
    'de volta ao mapa, digitar no painel chega ao stdin',
  )
  await shot('painel-de-volta')

  // ---------- Modal por cima do painel: o painel cede com o texto DELE e volta ao fechar ----------
  // (Regressão: o painel bloqueado pela modal mostrava o "Abrir aqui" da aba, e o
  // clique criava uma lease da aba que prendia o painel em "Em uso na aba".)
  const dockPh = dock.getByTestId('terminal-leased')
  await dock.getByTestId('mother-dock-modal').click()
  check(
    await waitFor(
      'painel cede à modal',
      async () =>
        (await lift.locator('.xterm').count()) === 1 &&
        (await dock.locator('.xterm').count()) === 0 &&
        (await dockPh.count()) === 1,
      10_000,
    ),
    'modal aberta sobre o painel: o painel desmonta o xterm e mostra o placeholder',
  )
  const dockPhText = await dockPh.innerText().catch(() => '')
  check(
    (await dockPh.getAttribute('data-owner')) === 'modal' &&
      dockPhText.includes('Trazer para cá') &&
      !dockPhText.includes('Abrir aqui'),
    `placeholder do painel é o do painel, sem "Abrir aqui" ("${dockPhText.replaceAll('\n', ' / ')}")`,
  )
  await shot('painel-sob-modal')
  await lift.locator('header span[id]').first().click()
  await page.keyboard.press('Escape')
  check(
    await waitFor(
      'painel retoma',
      async () =>
        (await lift.count()) === 0 &&
        (await dock.locator('.xterm').count()) === 1 &&
        (await dockPh.count()) === 0,
      10_000,
    ),
    'Esc fecha a modal e o xterm do painel remonta (sem lease presa)',
  )
  await dock.locator('.xterm').click()
  await page.keyboard.type('painel-pos-modal')
  await page.keyboard.press('Enter')
  check(
    await waitFor('stdin pós-modal', async () => stdinOf(mPid).includes('stdin: painel-pos-modal')),
    'depois da modal, digitar no painel chega ao stdin de M',
  )

  // ---------- Mapa → Terminais: a lease sai com o Mapa ----------
  await page.getByTestId('projects-view-terminals').click()
  check(
    await waitFor(
      'mapa fechado',
      async () => (await page.getByTestId('session-map').count()) === 0,
    ),
    'visão Terminais desmonta o mapa',
  )
  check(
    await waitFor(
      'aba remonta',
      async () => (await tabXterms()) === 1 && (await tabPlaceholder()) === null,
      10_000,
    ),
    'sem o mapa a lease sai: a aba de M monta o xterm (sem placeholder)',
  )
  await page
    .locator('.xterm')
    .first()
    .click()
    .catch(() => {})
  await page.keyboard.type('ola-pela-aba')
  await page.keyboard.press('Enter')
  check(
    await waitFor('stdin pela aba', async () => stdinOf(mPid).includes('stdin: ola-pela-aba')),
    'digitar na aba chega ao stdin de M',
  )
  await shot('aba-terminais')

  // ---------- Ctrl+Shift+P em Terminais: não vira ^P na PTY ----------
  // "pre" sem Enter fica na linha da PTY: se o atalho vazasse, o \x10 entraria
  // nela e apareceria no stdin quando o Enter fechar a linha.
  await page.keyboard.type('pre')
  await page.keyboard.press('Control+Shift+KeyP')
  check(
    await waitFor(
      'mapa pelo Ctrl+Shift+P',
      async () =>
        (await page.getByTestId('session-map').count()) === 1 && (await dock.count()) === 1,
      10_000,
    ),
    'Ctrl+Shift+P em Terminais leva ao mapa com o painel da mãe aberto',
  )
  await page.getByTestId('projects-view-terminals').click()
  await waitFor('aba remonta 2', async () => (await tabXterms()) === 1, 10_000)
  await page
    .locator('.xterm')
    .first()
    .click()
    .catch(() => {})
  await page.keyboard.press('Enter')
  check(
    await waitFor('linha pre', async () => /stdin: [^\n]*pre\n/.test(stdinOf(mPid))),
    'a linha "pre" chegou ao stdin de M',
  )
  check(!stdinOf(mPid).includes('\x10'), 'nenhum ^P (0x10) chegou ao stdin de M')
} catch (err) {
  fatal = err
  console.error('[zoom] erro fatal:', err)
  await page.screenshot({ path: join(SHOTS, 'zz-fatal.png') }).catch(() => {})
} finally {
  const proc = app.process()
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
const failed = results.filter((r) => !r.ok)
console.log('\n[zoom] ===== RESULTADO =====')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label}`)
console.log(
  `[zoom] ${results.length - failed.length}/${results.length} PASS — screenshots em ${SHOTS}`,
)
if (fatal || failed.length) process.exit(1)
