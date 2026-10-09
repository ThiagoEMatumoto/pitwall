import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { cleanCopy, closeOverlays, liveGlobal, mcpAs } from '../driver/crew-seed'
import { createFakeHome } from '../driver/fake-home'
import { roomStubLogs, writeRoomClaudeStub } from '../driver/room-stub'
import { goToArea, waitReady } from '../driver/nav'
import { PERMISSION_FIXTURE } from './attention-reason'

// B1 (feat/room-mother-ui): a mãe no centro da Room, no app buildado, HOME fake +
// stub do claude, cópia do perfil (CM_DRIVE_SAFE=1), feature e repos descartáveis.
//   a iniciar a mãe pela Room (feature vazia) · b composer → PTY → resposta no chat ·
//   c menu de permissão inline (clique pelo 1) · d fila da filha ao lado ·
//   e Chat⇄Terminal (botão e Ctrl+.) · f as 3 entradas da Room: Ctrl+` e a barra
//   levam ao painel na visão de projeto (pane da mãe em foco); Home e o tile de
//   "Todas as mães" (pelo ⤢ do painel) levam à sala com a mãe no centro.
// Rodar: npm run rebuild:native && npm run build, então
//   ROOM_MOTHER_SB=<dir> npx tsx e2e/scenarios/room-mother.ts

const SB = process.env.ROOM_MOTHER_SB ?? '/tmp/room-mother'
mkdirSync(SB, { recursive: true })
const SHOTS = process.env.ROOM_SHOTS ?? join(SB, 'shots')
mkdirSync(SHOTS, { recursive: true })
const out = { checks: [] as Array<{ ok: boolean; label: string }>, notes: [] as string[] }
const check = (ok: boolean, label: string) => {
  out.checks.push({ ok, label })
  console.log(`[b1] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}
const note = (s: string) => {
  out.notes.push(s)
  console.log(`[b1] note — ${s}`)
}

function gitRepo(name: string): string {
  const dir = join(SB, `${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', 'commit', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}
const repoA = gitRepo('mae-descartavel')
const repoB = gitRepo('filha-descartavel')

const fake = createFakeHome({ parentDir: SB })

const stubPath = writeRoomClaudeStub(fake, PERMISSION_FIXTURE)
const stubLog = () =>
  roomStubLogs(fake)
    .map((l) => l.text)
    .join('\n')

const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
note(`userData copy: ${userData}`)
await cleanCopy(userData)
writeCopyPrefs(userData, {
  claude_command: stubPath,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('chat'),
  'handoffs.requireApproval': JSON.stringify(false),
})

const consoleErrors: string[] = []
const waitFor = async (page: Page, label: string, fn: () => Promise<boolean>, ms = 20_000) => {
  const t = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - t > ms) {
      note(`timeout: ${label}`)
      await page
        .screenshot({ path: join(SHOTS, `timeout-${label.replace(/\W+/g, '-')}.png`) })
        .catch(() => {})
      return false
    }
    await page.waitForTimeout(200)
  }
}
const shot = (page: Page, n: string) =>
  page.screenshot({ path: join(SHOTS, `${n}.png`) }).catch(() => {})

const { app, page, mainOutput } = await launchApp({
  userDataDir: userData,
  env: fake.env,
  viewport: { width: 1440, height: 900 },
} as any)
const logs = captureLogs(app, page)
note(`log: ${logs.logFile}`)
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`)
})

const room = () => page.getByTestId('feature-room')
const mother = () => page.getByTestId('room-mother')
const composer = () =>
  page.locator('[data-testid="room-mother"] textarea:not(.xterm-helper-textarea)')
const composerFocused = () =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return (
      !!a &&
      a.tagName === 'TEXTAREA' &&
      !a.classList.contains('xterm-helper-textarea') &&
      !!a.closest('[data-testid="room-mother"]')
    )
  })
const panelTileM = () =>
  page.locator(`[data-testid="room-panel"] [data-testid="mother-tile"][data-tile="${ids.M}"]`)
async function paneOfMotherFocused(): Promise<boolean> {
  const title = (await panelTileM().getByTestId('mother-tile-title').innerText()).trim()
  return waitFor(page, `pane de ${title} em foco`, async () =>
    (
      await page
        .locator('.dv-groupview.dv-active-group .dv-tab.dv-active-tab')
        .first()
        .innerText()
        .catch(() => '')
    ).includes(title),
  )
}
async function leaveRoom() {
  await closeOverlays(page)
  await goToArea(page, 'overview')
  await waitFor(page, 'fora da Room', async () => !(await room().isVisible()))
}

const ids = { F: '', A: '', B: '', P: '', M: '', cc: '' }
try {
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})
  check(mainOutput().includes('[drive-safe]'), 'modo seguro ligado ([drive-safe] no boot)')

  const seeded = await page.evaluate(
    async ([a, b]) => {
      const api = (window as any).api
      const project = await api.projects.create({ name: `e2e-b1-${Date.now()}` })
      const ra = await api.projects.createRepo({ projectId: project.id, label: 'b1-mae', path: a })
      const rb = await api.projects.createRepo({
        projectId: project.id,
        label: 'b1-filha',
        path: b,
      })
      const feature = await api.features.create({
        projectId: project.id,
        title: 'B1 Room mãe e2e',
        objective: 'Objetivo descartável do B1',
        repos: [
          { repoId: ra.id, branch: null, worktreePath: null },
          { repoId: rb.id, branch: null, worktreePath: null },
        ],
      })
      await api.features.setFocus({ featureId: feature.id, pinned: true })
      return { P: project.id, A: ra.id, B: rb.id, F: feature.id }
    },
    [repoA, repoB],
  )
  Object.assign(ids, seeded)
  note(`feature ${ids.F} repoA ${ids.A} repoB ${ids.B}`)
  await page.reload()
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})

  // ---- (a) feature vazia → Room pelo "Abrir Room" da Home → card → iniciar
  await goToArea(page, 'overview')
  const homeBtn = page.locator(`[data-testid="home-feature-open-room"][data-feature-id="${ids.F}"]`)
  await waitFor(
    page,
    'botão Abrir Room da feature',
    async () => (await homeBtn.count()) > 0,
    10_000,
  )
  await homeBtn.first().click()
  await waitFor(page, 'Room aberta', async () => room().isVisible())
  const card = page.getByTestId('start-mother')
  check(
    await waitFor(page, 'card start-mother', () => card.isVisible()),
    'a: feature vazia mostra o card "Iniciar sessão-mãe"',
  )
  check((await mother().count()) === 0, 'a: sem mãe no centro antes do start')
  check(
    await room().getByText('Esta feature ainda não tem uma mãe').isVisible(),
    'a: título "Esta feature ainda não tem uma mãe"',
  )
  const purpose = page.getByTestId('start-mother-purpose')
  check((await purpose.inputValue()) === 'Objetivo descartável do B1', 'a: objetivo vem da feature')
  const repoBtns = page.getByTestId('start-mother-repo')
  check((await repoBtns.count()) === 2, 'a: os 2 repos da feature aparecem')
  await repoBtns.filter({ hasText: 'b1-mae' }).click()
  // objetivo vazio → erro e nada sobe
  await purpose.fill('   ')
  await page.getByTestId('start-mother-submit').click()
  check(
    await waitFor(
      page,
      'erro objetivo vazio',
      () => page.getByTestId('start-mother-error').isVisible(),
      3000,
    ),
    'a: objetivo vazio → mensagem de erro',
  )
  await purpose.fill('Mãe do B1: validar o centro da Room')
  await shot(page, 'a1-start-card')
  const live0 = new Set((await liveGlobal(page)).map((s) => s.id))
  await page.getByTestId('start-mother-submit').click()
  const sawSteps = await waitFor(
    page,
    'passos',
    () => page.getByTestId('start-mother-steps').isVisible(),
    3000,
  )
  note(`passos visíveis: ${sawSteps}`)
  if (sawSteps) await shot(page, 'a2-steps')
  check(
    await waitFor(page, 'mãe no centro', () => mother().isVisible(), 30_000),
    'a: a mãe aparece no centro da Room',
  )
  check(
    await waitFor(page, 'card some', async () => (await card.count()) === 0, 15_000),
    'a: card de start some (passos concluídos)',
  )
  const fresh = (await liveGlobal(page)).find((s) => !live0.has(s.id))
  ids.M = fresh?.id ?? ''
  ids.cc = fresh?.ccSessionId ?? ''
  check(
    !!ids.M && (await mother().getAttribute('data-session-id')) === ids.M,
    'a: centro = a sessão recém-criada',
  )
  check(stubLog().includes('--session-id'), 'a: stub subiu com --session-id')
  const focusedOk = await waitFor(page, 'composer focado', composerFocused, 5000)
  check(focusedOk, 'a: depois do start o foco vai para o composer da mãe')
  await shot(page, 'a3-mother-center')

  // ---- (b) composer → PTY → resposta no chat
  await composer().fill('MSG-B1 ola mae')
  await composer().press('Enter')
  check(
    await waitFor(
      page,
      'linha no stub',
      async () => stubLog().includes('line:MSG-B1 ola mae'),
      10_000,
    ),
    'b: a mensagem do composer chega no PTY (stub loga a linha)',
  )
  check(
    await waitFor(
      page,
      'resposta no chat',
      () => mother().getByText('RESPOSTA-MAE: MSG-B1 ola mae').first().isVisible(),
      15_000,
    ),
    'b: a resposta da mãe aparece no chat do centro',
  )
  await shot(page, 'b1-chat-reply')
  // "/" com foco na Room → composer
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const rootFocused = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') === 'feature-room',
  )
  note(`Esc no composer devolve o foco à Room: ${rootFocused}`)
  await room().focus()
  await page.keyboard.press('/')
  check(
    await waitFor(page, '/ foca composer', composerFocused, 3000),
    'b: "/" na Room foca o composer da mãe',
  )
  check(((await composer().inputValue()) ?? '') === '', 'b: "/" não vaza para o composer')

  // ---- (c) menu de permissão inline
  await composer().fill('PEDE-PERMISSAO agora')
  await composer().press('Enter')
  const opt1 = mother().locator('[data-permission-option="1"]')
  check(
    await waitFor(page, 'card de permissão', () => opt1.first().isVisible(), 20_000),
    'c: card de permissão da mãe aparece inline no chat do centro',
  )
  const optCount = await mother().locator('[data-permission-option]').count()
  note(`opções de permissão: ${optCount}`)
  check(
    await waitFor(
      page,
      'status esperando você',
      async () =>
        /esperando você/.test(
          await page
            .getByTestId('room-mother-status')
            .innerText()
            .catch(() => ''),
        ),
      10_000,
    ),
    'c: status da mãe = "esperando você"',
  )
  await shot(page, 'c1-permission-inline')
  const pressedBefore = stubLog().includes('menu-answer:')
  await room().focus()
  await page.keyboard.press('1')
  check(
    await waitFor(page, 'stub recebe o 1', async () => stubLog().includes('menu-answer:1'), 8000),
    'c: tecla 1 na Room responde o menu (stub recebe "1")',
  )
  check(
    await waitFor(page, 'card some', async () => (await opt1.count()) === 0, 10_000),
    'c: card de permissão some depois da resposta',
  )
  check(
    await waitFor(
      page,
      'resposta da permissão no chat',
      () => mother().getByText('PERMISSAO-RESPONDIDA 1').first().isVisible(),
      10_000,
    ),
    'c: o chat segue com a resposta depois do menu',
  )
  const answers = (stubLog().match(/menu-answer:/g) ?? []).length
  check(answers === 1, `c: o menu foi respondido exatamente uma vez (${answers})`)
  check(!pressedBefore, 'c: nada respondeu o menu antes do 1 do usuário')
  await shot(page, 'c2-permission-answered')

  // ---- (d) filha com pedido na fila, ao lado da mãe
  const asM = await mcpAs(userData, fake.root, ids.M)
  const hres = await asM.call<{ handoffId: string }>('session_handoff', {
    targetRepo: 'b1-filha',
    task: 'filha B1: validar a fila ao lado',
    mode: 'plan',
    featureId: ids.F,
    force: true,
    forceReason: 'validação B1',
  })
  note(`handoff: ${JSON.stringify(hres)}`)
  let childId = ''
  await waitFor(
    page,
    'filha viva',
    async () => {
      const hs = (await page.evaluate(() => (window as any).api.handoffs.list())) as any[]
      childId = hs.find((h) => h.id === hres.handoffId)?.childSessionId ?? ''
      return !!childId && (await liveGlobal(page)).some((s) => s.id === childId && !!s.ccSessionId)
    },
    30_000,
  )
  check(!!childId, 'd: filha subiu no repo B')
  await (
    await mcpAs(userData, fake.root, childId)
  ).call('handoff_ask', {
    handoffId: hres.handoffId,
    question: 'Posso seguir com o plano B1?',
  })
  const reqRow = page.locator('[data-testid="room-queue-row"][data-kind="request"]')
  check(
    await waitFor(page, 'pedido na fila', async () => (await reqRow.count()) > 0, 20_000),
    'd: pedido da filha aparece na fila lateral',
  )
  check(await mother().isVisible(), 'd: a mãe segue no centro ao lado da fila')
  check(
    await waitFor(
      page,
      'linha da filha',
      async () => (await page.getByTestId('room-child-row').count()) >= 1,
      10_000,
    ),
    'd: a filha aparece na aba Filhas',
  )
  const qBox = await reqRow.first().boundingBox()
  const mBox = await mother().boundingBox()
  check(
    !!qBox && !!mBox && qBox.x >= mBox.x + mBox.width - 2,
    'd: fila à direita do centro (layout lado a lado)',
  )
  check(
    /Posso seguir com o plano B1/.test(
      await page
        .getByTestId('room-queue-open')
        .innerText()
        .catch(() => ''),
    ),
    'd: pergunta da filha aberta na fila',
  )
  await shot(page, 'd1-child-queue')

  // ---- (e) Chat⇄Terminal
  await page.getByTestId('room-mother-mode-terminal').click()
  check(
    await waitFor(
      page,
      'modo terminal',
      async () => (await mother().getAttribute('data-mode')) === 'terminal',
      3000,
    ),
    'e: botão Terminal → data-mode=terminal',
  )
  await page.waitForTimeout(700)
  check(await mother().locator('.xterm').first().isVisible(), 'e: xterm visível no modo terminal')
  await shot(page, 'e1-terminal')
  await room().focus()
  await page.keyboard.press('Control+.')
  check(
    await waitFor(
      page,
      'modo chat',
      async () => (await mother().getAttribute('data-mode')) === 'chat',
      3000,
    ),
    'e: Ctrl+. volta para chat',
  )
  await page.waitForTimeout(500)
  check(
    await mother().getByText('RESPOSTA-MAE: MSG-B1 ola mae').first().isVisible(),
    'e: chat intacto após o toggle',
  )
  await page.keyboard.press('Control+.')
  check(
    await waitFor(
      page,
      'modo terminal 2',
      async () => (await mother().getAttribute('data-mode')) === 'terminal',
      3000,
    ),
    'e: Ctrl+. de novo → terminal',
  )
  await page.getByTestId('room-mother-mode-chat').click()
  check((await mother().getAttribute('data-mode')) === 'chat', 'e: botão Chat → chat')
  await shot(page, 'e2-chat-again')

  // header: "＋ Iniciar sessão-mãe" abre o dialog com a mãe já no centro
  await page.getByTestId('room-start-mother').click()
  const dlg = page
    // O Dialog do app não tem role="dialog": a marca dele é o data-modal-overlay.
    .locator('[data-modal-overlay]')
    .filter({ has: page.getByTestId('start-mother') })
  check(
    await waitFor(page, 'dialog nova mãe', () => dlg.first().isVisible(), 3000),
    'header: "Iniciar sessão-mãe" abre o dialog',
  )
  await shot(page, 'e3-new-mother-dialog')
  await page.keyboard.press('Escape')
  await waitFor(page, 'dialog fecha', async () => (await dlg.count()) === 0, 3000)

  // ---- (f) as 3 entradas da Room, todas com a mãe no centro
  await leaveRoom()
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  await page.waitForTimeout(600)
  const opt = page.locator(`[data-testid="feature-switcher"] [role="option"][data-key="${ids.F}"]`)
  const listed = (await opt.count()) > 0
  for (let i = 0; listed && i < 30 && (await opt.getAttribute('aria-selected')) !== 'true'; i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(80)
  }
  if (!listed) await page.keyboard.press('Escape')
  await page.keyboard.up('Control')
  check(listed, 'f1: feature no Ctrl+`')
  // Contrato v0.78: o Ctrl+` leva à visão de projeto com o painel da Room filtrado
  // na feature e a pane REAL da mãe em foco (não mais a página Room).
  check(
    await waitFor(page, 'painel via Ctrl+`', () => panelTileM().isVisible(), 10_000),
    'f1: Ctrl+` → painel da Room com o tile da mãe',
  )
  check(
    await page.getByTestId('room-panel-filter').isVisible(),
    'f1: Ctrl+` filtra o painel na feature',
  )
  check(!(await room().isVisible()), 'f1: Ctrl+` não abre a página Room')
  check(await paneOfMotherFocused(), 'f1: Ctrl+` → a pane da mãe em foco no dockview')
  await shot(page, 'f1-ctrl-backquote')

  await leaveRoom()
  await page.reload()
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})
  await goToArea(page, 'overview')
  await waitFor(page, 'botão Home 2', async () => (await homeBtn.count()) > 0, 10_000)
  await homeBtn.first().click()
  check(
    await waitFor(
      page,
      'mãe via Home',
      async () => (await mother().getAttribute('data-session-id')) === ids.M,
      15_000,
    ),
    'f2: "Abrir Room" da Home → mãe no centro (após reload)',
  )
  check(
    (await mother()
      .getByText('RESPOSTA-MAE: MSG-B1 ola mae')
      .first()
      .isVisible()
      .catch(() => false)) ||
      (await waitFor(
        page,
        'chat após reload',
        () => mother().getByText('RESPOSTA-MAE: MSG-B1 ola mae').first().isVisible(),
        10_000,
      )),
    'f2: chat da mãe recarrega o histórico',
  )
  await shot(page, 'f2-home')

  await leaveRoom()
  // Contrato v0.78: a barra leva ao painel da Room na visão de projeto; a página
  // "Todas as mães" fica no ⤢ do painel, e o tile dela (Enter) leva à sala.
  await page.getByTestId('rail-room').click()
  check(
    await waitFor(page, 'tile da mãe no painel via rail', () => panelTileM().isVisible(), 10_000),
    'f3: item "Room" da barra → painel da Room com o tile da mãe',
  )
  check(!(await room().isVisible()), 'f3: a barra não abre a página Room')
  await page.getByTestId('room-panel-fullscreen').click()
  const tileM = page.locator(
    `[data-testid="all-mothers"] [data-testid="mother-tile"][data-tile="${ids.M}"]`,
  )
  check(
    await waitFor(page, 'tile da mãe em Todas as mães', () => tileM.isVisible(), 10_000),
    'f3: ⤢ do painel → Todas as mães com o tile da mãe',
  )
  await tileM.focus()
  await page.keyboard.press('Enter')
  check(
    await waitFor(
      page,
      'mãe via rail',
      async () => (await mother().getAttribute('data-session-id')) === ids.M,
      10_000,
    ),
    'f3: Enter no tile → mãe no centro da sala',
  )
  await shot(page, 'f3-rail')

  // limpeza: mata filha e mãe pelo app
  for (const id of [childId, ids.M].filter(Boolean)) {
    await page.evaluate((s) => (window as any).api.sessions.kill(s), id).catch(() => {})
  }
  await page.waitForTimeout(1000)
} catch (e) {
  check(false, `exceção ${(e as Error).stack ?? e}`)
  await shot(page, 'exception')
} finally {
  logs.stop()
  await app.close()
}

{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
  const r = db
    .prepare('SELECT feature_id, repo_id, purpose, cc_session_id FROM sessions WHERE id = ?')
    .get(ids.M) as any
  db.close()
  note(`sql mãe: ${JSON.stringify(r)}`)
  check(
    r?.feature_id === ids.F &&
      r?.repo_id === ids.A &&
      r?.purpose === 'Mãe do B1: validar o centro da Room' &&
      r?.cc_session_id === ids.cc,
    'a: SQL — sessão ligada à feature, repo A, purpose e ccSessionId',
  )
}
check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`)
for (const e of consoleErrors) note(e.slice(0, 400))
note(
  `stub log:\n${stubLog()
    .split('\n')
    .filter((l) => !l.startsWith('key:'))
    .slice(0, 40)
    .join('\n')}`,
)
const failed = out.checks.filter((c) => !c.ok)
console.log(
  `\n[b1] RESULT ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${out.checks.length - failed.length}/${out.checks.length}`,
)
writeFileSync(join(SB, 'result.json'), JSON.stringify(out, null, 2))
if (existsSync(SB)) process.exit(failed.length === 0 ? 0 : 1)
