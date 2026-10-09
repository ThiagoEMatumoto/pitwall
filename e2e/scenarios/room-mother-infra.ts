import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { cleanCopy } from '../driver/crew-seed'
import { createFakeHome } from '../driver/fake-home'
import { goToArea, waitReady } from '../driver/nav'

// room:mother-preflight + room:start-mother pelo IPC do renderer, sobre a cópia do
// perfil, HOME fake + stub do claude, feature e repo descartáveis (sandbox).
//   A (MCP on): preflight, start-mother, tempo do ccSessionId, 2 ChatViews.
//   B (MCP off: porta ocupada, sem efêmera): preflight bloqueia, start recusa, 0 sessão.
// Rodar: ROOM_MOTHER_SB=<dir> npx tsx e2e/scenarios/room-mother-infra.ts

const SB = process.env.ROOM_MOTHER_SB ?? '/tmp/room-mother-infra'
mkdirSync(SB, { recursive: true })
const SHOTS = join(SB, 'shots')
mkdirSync(SHOTS, { recursive: true })
const out = { checks: [] as Array<{ ok: boolean; label: string }>, notes: [] as string[] }
const check = (ok: boolean, label: string) => {
  out.checks.push({ ok, label })
  console.log(`[rm] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}
const note = (s: string) => {
  out.notes.push(s)
  console.log(`[rm] note — ${s}`)
}

const repoDir = join(SB, `repo-descartavel-${Date.now()}`)
mkdirSync(repoDir, { recursive: true })
writeFileSync(join(repoDir, 'README.md'), '# descartável\n')
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir })
execFileSync(
  'git',
  ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', 'commit', '-qam', 'init', '--allow-empty'],
  { cwd: repoDir },
)
execFileSync('git', ['add', '.'], { cwd: repoDir })
execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', 'commit', '-qm', 'readme'], {
  cwd: repoDir,
})

const fake = createFakeHome({ parentDir: SB })
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy
note(`userData copy: ${userData}`)
await cleanCopy(userData)
writeCopyPrefs(userData, {
  claude_command: fake.fakeCliPath('claude'),
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('chat'),
  'handoffs.requireApproval': JSON.stringify(false),
})

const pageErrors: string[] = []
function watchErrors(page: Page, tag: string) {
  page.on('pageerror', (e) => pageErrors.push(`${tag} pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${tag} console: ${m.text()}`)
  })
}
async function waitFor(page: Page, label: string, fn: () => Promise<boolean>, ms = 20_000) {
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
    await page.waitForTimeout(250)
  }
}
const shot = (page: Page, n: string) =>
  page.screenshot({ path: join(SHOTS, `${n}.png`) }).catch(() => {})

let transcriptFile = ''
let line = 0
function appendAssistant(text: string) {
  line++
  appendFileSync(
    transcriptFile,
    JSON.stringify({
      type: 'assistant',
      uuid: `u-${line}`,
      timestamp: new Date().toISOString(),
      message: {
        id: `m-${line}`,
        role: 'assistant',
        model: 'claude-e2e',
        content: [{ type: 'text', text }],
      },
    }) + '\n',
  )
}

const ids = { featureId: '', repoId: '', sessionId: '', ccSessionId: '', projectId: '' }
const knownCc = new Set<string>()
const PURPOSE = 'Validar a infra da mãe da Room (e2e)'

// ---------------- Fase A: MCP ligado ----------------
{
  const { app, page, mainOutput } = await launchApp({ userDataDir: userData, env: fake.env })
  const logs = captureLogs(app, page)
  note(`log A: ${logs.logFile}`)
  watchErrors(page, 'A')
  try {
    await waitReady(page)
    await page
      .locator('.spl-skip')
      .click({ timeout: 3000 })
      .catch(() => {})
    check(mainOutput().includes('[drive-safe]'), 'A: modo seguro ligado ([drive-safe] no boot)')

    const seeded = await page.evaluate(async (path) => {
      const api = (window as any).api
      const project = await api.projects.create({ name: `e2e-room-mother-${Date.now()}` })
      const repo = await api.projects.createRepo({
        projectId: project.id,
        label: 'room-mother-descartavel',
        path,
      })
      const feature = await api.features.create({
        projectId: project.id,
        title: 'Room mother infra e2e',
        objective: 'Objetivo descartável do e2e',
        repos: [{ repoId: repo.id, branch: null, worktreePath: null }],
      })
      return { projectId: project.id, repoId: repo.id, featureId: feature.id }
    }, repoDir)
    ids.featureId = seeded.featureId
    ids.repoId = seeded.repoId
    ids.projectId = seeded.projectId
    note(`feature ${ids.featureId} repo ${ids.repoId}`)

    const pre = await page.evaluate(
      ([f, r]) => (window as any).api.room.motherPreflight(f, r),
      [ids.featureId, ids.repoId],
    )
    note(`preflight A: ${JSON.stringify(pre)}`)
    check(pre.mcpReady === true && pre.mcpBlockReason === null, 'A: preflight mcpReady=true')
    check(
      pre.featureExists === true && pre.repo?.valid === true && pre.repo?.cwd === repoDir,
      'A: preflight repo válido, cwd = repo',
    )

    const before = (await page.evaluate(() => (window as any).api.sessions.list())).length
    const t0 = Date.now()
    const res = await page.evaluate(
      ([f, r, p]) => (window as any).api.room.startMother({ featureId: f, repoId: r, purpose: p }),
      [ids.featureId, ids.repoId, PURPOSE],
    )
    const roundtrip = Date.now() - t0
    note(`startMother: ${JSON.stringify(res)} roundtrip=${roundtrip}ms`)
    ids.sessionId = res.sessionId
    ids.ccSessionId = res.ccSessionId
    knownCc.add(res.ccSessionId)
    check(
      !!res.ccSessionId,
      `(b) ccSessionId no retorno (handler ${res.ccSessionIdReadyMs}ms, IPC ${roundtrip}ms)`,
    )
    check(res.cwd === repoDir, 'A: cwd devolvido = repo descartável')

    // Processo do stub sobe com --session-id = ccSessionId: tempo até o session file.
    const tFile = Date.now()
    const up = await waitFor(page, 'session file do stub', async () =>
      fake.readSessionFiles().some((s) => s.data.sessionId === res.ccSessionId),
    )
    note(
      `(b) session file do stub com o ccSessionId: ${up ? Date.now() - t0 : 'nunca'}ms após o start (${Date.now() - tFile}ms após o retorno)`,
    )
    const after = (await page.evaluate(() => (window as any).api.sessions.list())).length
    note(`sessions.list: ${before} → ${after}`)

    // ---- (d) duas ChatViews ----
    const projDir = join(fake.home, '.claude', 'projects', repoDir.replace(/[/.]/g, '-'))
    mkdirSync(projDir, { recursive: true })
    transcriptFile = join(projDir, `${res.ccSessionId}.jsonl`)
    writeFileSync(transcriptFile, '')
    appendAssistant('MARK-0 primeira mensagem')

    // Room da feature: area via o switcher Ctrl+`.
    const openRoom = async () => {
      await page.keyboard.down('Control')
      await page.keyboard.press('Backquote')
      await page.waitForTimeout(600)
      const opt = page.locator(
        `[data-testid="feature-switcher"] [role="option"][data-key="${ids.featureId}"]`,
      )
      const has = (await opt.count()) > 0
      for (let i = 0; has && i < 30 && (await opt.getAttribute('aria-selected')) !== 'true'; i++) {
        await page.keyboard.press('Tab')
        await page.waitForTimeout(80)
      }
      if (!has) await page.keyboard.press('Escape')
      await page.keyboard.up('Control')
      await page.waitForTimeout(600)
      return has
    }
    check(await openRoom(), 'd: feature descartável no Ctrl+`')
    await waitFor(page, 'room-mother', () => page.getByTestId('room-mother').isVisible())
    check(await page.getByTestId('room-mother').isVisible(), 'd: Room mostra a mãe')
    await shot(page, 'A1-room')
    const peekChat = page.locator('[data-peek-mode="chat"]')
    await page.getByTestId('room-mother').getByRole('button', { name: /^Peek em / }).click()
    const firstTry = await waitFor(page, 'peek chat', async () => (await peekChat.count()) > 0, 5000)
    check(firstTry, 'd: Peek da mãe recém-criada abre na 1ª tentativa (renderer conhece a sessão)')
    if (!firstTry) {
      // Diagnóstico: o renderer só põe a sessão no liveSessions quando algo refaz o
      // snapshot (o switcher faz isso ao ver um id desconhecido no grafo).
      const inLive = await page.evaluate(
        (id) => (window as any).api.sessions.listLiveGlobal().then((l: any[]) => l.some((x) => x.id === id)),
        ids.sessionId,
      )
      note(`diag: listLiveGlobal (main) contém a mãe = ${inLive}`)
      // Controle: reload refaz startLiveWatch (snapshot) no renderer.
      await page.reload()
      await waitReady(page)
      await page.waitForTimeout(1500)
      for (let i = 0; i < 2 && (await peekChat.count()) === 0; i++) {
        await openRoom()
        await page.waitForTimeout(1000)
        await page.getByTestId('room-mother').getByRole('button', { name: /^Peek em / }).click()
        await waitFor(page, `peek chat retry ${i}`, async () => (await peekChat.count()) > 0, 3000)
        note(`retry ${i}: peek aberto=${(await peekChat.count()) > 0}`)
      }
    }
    await waitFor(page, 'MARK-0 no peek', () => peekChat.getByText('MARK-0').first().isVisible())
    check(await peekChat.getByText('MARK-0').first().isVisible(), 'd: peek (chat) mostra MARK-0')
    await shot(page, 'A2-peek1')
    // Promove a aba (ChatView nº1, pane em modo chat).
    await page
      .getByText(/abrir como aba/i)
      .first()
      .click()
    await page.waitForTimeout(1200)
    const tabChat = page.locator('main').getByText('MARK-0').first()
    await waitFor(page, 'aba com MARK-0', () => tabChat.isVisible())
    check(await tabChat.isVisible(), 'd: aba (ChatView nº1) mostra MARK-0')
    await shot(page, 'A3-tab')

    // ChatView nº2: peek de novo pela Room (a aba fica montada, escondida).
    check(await openRoom(), 'd: volta para a Room')
    await waitFor(page, 'room-mother 2', () => page.getByTestId('room-mother').isVisible())
    await page.getByTestId('room-mother').getByRole('button', { name: /^Peek em / }).click()
    await waitFor(page, 'peek chat 2', async () => (await peekChat.count()) > 0)
    appendAssistant('MARK-1 com as duas abertas')
    check(
      await waitFor(page, 'MARK-1 no peek', () => peekChat.getByText('MARK-1').first().isVisible()),
      'd: com 2 ChatViews, MARK-1 aparece no peek',
    )
    await shot(page, 'A4-peek2')
    // Fecha o peek (unmount de 1 consumidor) e escreve outra mensagem.
    await page.keyboard.press('Escape')
    await waitFor(page, 'peek fechado', async () => (await peekChat.count()) === 0)
    check((await peekChat.count()) === 0, 'd: peek fechado')
    await page.waitForTimeout(500)
    appendAssistant('MARK-2 depois de fechar o peek')
    await goToArea(page, 'projects')
    const m2 = page.locator('main').getByText('MARK-2').first()
    check(
      await waitFor(page, 'MARK-2 na aba', () => m2.isVisible(), 10_000),
      'd: fechar o peek não congela a aba (MARK-2 chega)',
    )
    await shot(page, 'A5-tab-after-close')

    // Inverso: peek aberto, aba fora de cena; a aba permanece; reabre o peek e
    // confere MARK-3 nele também (o watch nunca caiu).
    appendAssistant('MARK-3 controle final')
    check(
      await waitFor(
        page,
        'MARK-3 na aba',
        () => page.locator('main').getByText('MARK-3').first().isVisible(),
        10_000,
      ),
      'd: MARK-3 chega na aba',
    )

    // (g) repoId fora da feature → recusado, sem sessão nem PTY.
    const strayDir = join(SB, `repo-fora-${Date.now()}`)
    mkdirSync(strayDir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: strayDir })
    const strayId = await page.evaluate(
      async ([pid, path]) =>
        (
          await (window as any).api.projects.createRepo({
            projectId: pid,
            label: 'repo-fora-da-feature',
            path,
          })
        ).id,
      [ids.projectId, strayDir],
    )
    const s0 = (await page.evaluate(() => (window as any).api.sessions.list())).length
    const l0 = (await page.evaluate(() => (window as any).api.sessions.listLiveGlobal())).length
    const f0 = fake.readSessionFiles().length
    const strayErr = await page.evaluate(
      async ([f, r, p]) => {
        try {
          await (window as any).api.room.startMother({ featureId: f, repoId: r, purpose: p })
          return null
        } catch (e) {
          return String((e as Error).message)
        }
      },
      [ids.featureId, strayId, PURPOSE],
    )
    await page.waitForTimeout(1000)
    const s1 = (await page.evaluate(() => (window as any).api.sessions.list())).length
    const l1 = (await page.evaluate(() => (window as any).api.sessions.listLiveGlobal())).length
    const f1 = fake.readSessionFiles().length
    note(`(g) erro repo fora: ${strayErr}; sessions ${s0}→${s1}, live ${l0}→${l1}, stub files ${f0}→${f1}`)
    check(
      !!strayErr &&
        strayErr.includes(`repo ${strayId} não está ligado à feature ${ids.featureId}`) &&
        s0 === s1 &&
        l0 === l1 &&
        f0 === f1,
      '(g) repoId fora da feature → recusado, sem sessão/PTY/stub',
    )

    // (h) purpose com quebra de linha → nome da sessão normalizado.
    const NL_PURPOSE = 'Linha um\nLinha dois\r\n\tcom   tab e um texto bem longo para passar de quarenta chars'
    const res2 = await page.evaluate(
      ([f, r, p]) => (window as any).api.room.startMother({ featureId: f, repoId: r, purpose: p }),
      [ids.featureId, ids.repoId, NL_PURPOSE],
    )
    if (res2.ccSessionId) knownCc.add(res2.ccSessionId)
    // claude recebe o nome via `-n` (não vai pro sessions.title): o stub grava.
    await waitFor(page, 'session file da mãe 2', async () =>
      fake.readSessionFiles().some((x) => x.data.sessionId === res2.ccSessionId),
    )
    const nm: string =
      fake.readSessionFiles().find((x) => x.data.sessionId === res2.ccSessionId)?.data.name ?? ''
    note(`(h) nome: ${JSON.stringify(nm)}`)
    check(
      nm.startsWith('mãe · Linha um Linha dois com tab') &&
        !/[\r\n\t]/.test(nm) &&
        !/ {2}/.test(nm) &&
        nm.endsWith('…') &&
        [...nm.replace('mãe · ', '')].length <= 40,
      '(h) purpose com quebra de linha → nome normalizado (1 linha, ≤40, …)',
    )
    await page.evaluate((id) => (window as any).api.sessions.kill(id), res2.sessionId)

    await page.evaluate((id) => (window as any).api.sessions.kill(id), ids.sessionId)
    await page.waitForTimeout(800)
  } catch (e) {
    check(false, `A: exceção ${(e as Error).stack ?? e}`)
    await shot(page, 'A-exception')
  } finally {
    logs.stop()
    await app.close()
  }
}

// (a) SQL na cópia com node:sqlite (enxerga o -wal).
{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
  const row = db
    .prepare(
      'SELECT * FROM sessions WHERE id = ?',
    )
    .get(ids.sessionId) as Record<string, unknown> | undefined
  note(`(a) row: ${JSON.stringify(row)}`)
  check(row?.feature_id === ids.featureId, '(a) sessions.feature_id = feature')
  check(row?.purpose === PURPOSE, '(a) sessions.purpose = purpose')
  check(row?.cc_session_id === ids.ccSessionId, '(a) sessions.cc_session_id = retorno')
  check(row?.repo_id === ids.repoId, '(a) sessions.repo_id = repo descartável')
  db.close()
}

// ---------------- Fase B: MCP desligado ----------------
{
  const blocker = createServer()
  const port: number = await new Promise((r) =>
    blocker.listen(0, '127.0.0.1', () => r((blocker.address() as any).port)),
  )
  const countSessions = async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE feature_id = ?').get(ids.featureId) as {
        n: number
      }
    ).n
    const total = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    db.close()
    return { n, total }
  }
  const beforeB = await countSessions()
  const { app, page, mainOutput } = await launchApp({
    userDataDir: userData,
    env: { ...fake.env, CM_MCP_PORT: String(port), CM_MCP_EPHEMERAL_PORT: '0' },
  })
  const logs = captureLogs(app, page)
  note(`log B: ${logs.logFile}`)
  watchErrors(page, 'B')
  try {
    await waitReady(page)
    await page.waitForTimeout(1500)
    check(/continuing without MCP/.test(mainOutput()), 'B: main sobe sem MCP (porta ocupada)')
    const pre = await page.evaluate(
      ([f, r]) => (window as any).api.room.motherPreflight(f, r),
      [ids.featureId, ids.repoId],
    )
    note(`preflight B: ${JSON.stringify(pre)}`)
    check(
      pre.mcpReady === false &&
        typeof pre.mcpBlockReason === 'string' &&
        pre.mcpBlockReason.length > 20,
      '(c) preflight mcpReady=false com motivo',
    )
    const live0 = (await page.evaluate(() => (window as any).api.sessions.listLiveGlobal())).length
    const err = await page.evaluate(
      async ([f, r, p]) => {
        try {
          await (window as any).api.room.startMother({ featureId: f, repoId: r, purpose: p })
          return null
        } catch (e) {
          return String((e as Error).message)
        }
      },
      [ids.featureId, ids.repoId, PURPOSE],
    )
    note(`(c) erro: ${err}`)
    check(
      !!err && err.includes('MCP_NOT_READY') && err.includes('Reinicie o Pitwall'),
      '(c) start-mother recusa com MCP_NOT_READY e texto claro',
    )
    await page.waitForTimeout(800)
    const live1 = (await page.evaluate(() => (window as any).api.sessions.listLiveGlobal())).length
    check(live0 === live1, `(c) nenhuma PTY nova (${live0} → ${live1})`)
    check(
      !fake
        .readSessionFiles()
        .some((s) => s.data.sessionId && !knownCc.has(s.data.sessionId)),
      '(c) stub não subiu outra sessão',
    )
  } catch (e) {
    check(false, `B: exceção ${(e as Error).stack ?? e}`)
  } finally {
    logs.stop()
    await app.close()
    blocker.close()
  }
  const afterB = await countSessions()
  check(
    afterB.n === beforeB.n && afterB.total === beforeB.total,
    `(c) SQL: sessions sem linha nova (feature ${beforeB.n}→${afterB.n}, total ${beforeB.total}→${afterB.total})`,
  )
}

check(pageErrors.length === 0, `(f) zero console errors (${pageErrors.length})`)
for (const e of pageErrors) note(`console: ${e.slice(0, 300)}`)
const failed = out.checks.filter((c) => !c.ok)
console.log(
  `\n[rm] RESULT ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${out.checks.length - failed.length}/${out.checks.length}`,
)
writeFileSync(join(SB, 'result.json'), JSON.stringify(out, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
