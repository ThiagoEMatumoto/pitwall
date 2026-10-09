import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { captureLogs } from '../driver/capture'
import { cleanCopy, liveGlobal, mcpAs } from '../driver/crew-seed'
import { createFakeHome } from '../driver/fake-home'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { goToArea, waitReady } from '../driver/nav'
import { roomStubLogs, writeRoomClaudeStub } from '../driver/room-stub'
import { PERMISSION_FIXTURE } from './attention-reason'

// B2b (feat/room-all-mothers): "Todas as mães" e o split, no app buildado, HOME
// fake + stub do claude (o mesmo do room-mother), cópia do perfil (CM_DRIVE_SAFE=1).
//   2 IconRail → Todas · 3 composer do tile → stub certo, cauda, 0 transcript-update ·
//   4 aprovar no tile, badge e faixa caem juntos · 5 Enter expande · 6 split, um
//   terminal por vez, Esc volta · 7 viewport 1024: tiles pausados, sem scroll lateral.
// Rodar: npm run rebuild:native && npm run build, então
//   ROOM_SHOTS=<dir> npx tsx e2e/scenarios/room-mothers.ts

const SB = process.env.ROOM_MOTHERS_SB ?? '/tmp/room-mothers'
mkdirSync(SB, { recursive: true })
const SHOTS = process.env.ROOM_SHOTS ?? join(SB, 'shots')
mkdirSync(SHOTS, { recursive: true })
const out = {
  checks: [] as Array<{ ok: boolean; label: string }>,
  notes: [] as string[],
  pageerrors: [] as string[],
}
const check = (ok: boolean, label: string) => {
  out.checks.push({ ok, label })
  console.log(`[b2b] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}
const note = (s: string) => {
  out.notes.push(s)
  console.log(`[b2b] note — ${s}`)
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
const paths = { A: gitRepo('b2b-um'), B: gitRepo('b2b-filha'), C: gitRepo('b2b-dois') }

const fake = createFakeHome({ parentDir: SB })
const stubPath = writeRoomClaudeStub(fake, PERMISSION_FIXTURE)
// O log de uma sessão: o argv da 1ª linha traz --session-id <ccSessionId>.
const logOf = (cc: string) =>
  roomStubLogs(fake)
    .filter((l) => l.text.split('\n')[0].includes(cc))
    .map((l) => l.text)
    .join('\n')

function findJsonl(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isFile() && e.name === name) return p
    if (e.isDirectory() && !e.isSymbolicLink()) {
      const hit = findJsonl(p, name)
      if (hit) return hit
    }
  }
  return null
}

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
page.on('pageerror', (e) => out.pageerrors.push(e.message))

const all = () => page.getByTestId('all-mothers')
const tile = (id: string) => page.locator(`[data-testid="mother-tile"][data-tile="${id}"]`)
const col = (id: string) => page.locator(`[data-testid="room-mother"][data-session-id="${id}"]`)
const colComposer = (id: string) =>
  page.locator(
    `[data-testid="room-mother"][data-session-id="${id}"] textarea:not(.xterm-helper-textarea)`,
  )
const num = async (testId: string) =>
  Number.parseInt(
    (await page
      .getByTestId(testId)
      .first()
      .innerText()
      .catch(() => '0')) || '0',
    10,
  ) || 0
const tileNum = async (id: string, testId: string) =>
  Number(
    (
      (await tile(id)
        .getByTestId(testId)
        .innerText()
        .catch(() => '')) || ''
    ).match(/\d+/)?.[0] ?? -1,
  )
const counters = () =>
  page.evaluate(() => {
    const w = window as any
    return { tail: { ...w.__tail } as Record<string, number>, upd: w.__upd as number }
  })
const resetCounters = () =>
  page.evaluate(() => {
    const w = window as any
    w.__tail = {}
    w.__upd = 0
  })

interface Mother {
  sessionId: string
  ccSessionId: string
}
const startMother = (featureId: string, repoId: string, purpose: string) =>
  page.evaluate((i) => (window as any).api.room.startMother(i) as Promise<Mother>, {
    featureId,
    repoId,
    purpose,
  })

const ids = { P: '', A: '', B: '', C: '', F1: '', F2: '' }
const M: Record<'m1' | 'm2' | 'm3', Mother> = {} as any
const killList: string[] = []
try {
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})
  check(mainOutput().includes('[drive-safe]'), 'modo seguro ligado ([drive-safe] no boot)')

  // ---- 1. seed: 2 features com repo; 3 mães pelo IPC real; 1 filha da M1
  Object.assign(
    ids,
    await page.evaluate(async (p) => {
      const api = (window as any).api
      const project = await api.projects.create({ name: `e2e-b2b-${Date.now()}` })
      const out: Record<string, string> = { P: project.id }
      for (const [k, label, path] of [
        ['A', 'b2b-um', p.A],
        ['B', 'b2b-filha', p.B],
        ['C', 'b2b-dois', p.C],
      ]) {
        out[k] = (await api.projects.createRepo({ projectId: project.id, label, path })).id
      }
      for (const [k, title, repoIds] of [
        ['F1', 'B2b F1 mães', [out.A, out.B]],
        ['F2', 'B2b F2 mães', [out.C]],
      ] as Array<[string, string, string[]]>) {
        out[k] = (
          await api.features.create({
            projectId: project.id,
            title,
            objective: `${title}: objetivo descartável`,
            repos: repoIds.map((repoId) => ({ repoId, branch: null, worktreePath: null })),
          })
        ).id
      }
      return out
    }, paths),
  )
  note(`F1 ${ids.F1} F2 ${ids.F2}`)
  await page.evaluate(() => {
    const w = window as any
    w.__tail = {}
    w.__upd = 0
    w.api.chat.onTranscriptTail((t: { sessionId: string }) => {
      w.__tail[t.sessionId] = (w.__tail[t.sessionId] ?? 0) + 1
    })
    w.api.chat.onTranscriptUpdate(() => {
      w.__upd++
    })
  })
  M.m1 = await startMother(ids.F1, ids.A, 'M1: coordenar F1')
  M.m2 = await startMother(ids.F1, ids.A, 'M2: revisar F1')
  M.m3 = await startMother(ids.F2, ids.C, 'M3: tocar F2')
  killList.push(...Object.values(M).map((m) => m.sessionId))
  check(
    await waitFor(
      page,
      '3 mães vivas',
      async () => {
        const live = await liveGlobal(page)
        return Object.values(M).every((m) => live.some((s) => s.id === m.sessionId))
      },
      30_000,
    ),
    '1: as 3 mães sobem pelo room:start-mother real',
  )
  const asM1 = await mcpAs(userData, fake.root, M.m1.sessionId)
  const hres = await asM1.call<{ handoffId: string }>('session_handoff', {
    targetRepo: 'b2b-filha',
    task: 'filha B2b da M1',
    mode: 'plan',
    featureId: ids.F1,
    force: true,
    forceReason: 'validação B2b',
  })
  let kid = ''
  await waitFor(
    page,
    'filha viva',
    async () => {
      const hs = (await page.evaluate(() => (window as any).api.handoffs.list())) as any[]
      kid = hs.find((h) => h.id === hres.handoffId)?.childSessionId ?? ''
      return !!kid && (await liveGlobal(page)).some((s) => s.id === kid && !!s.ccSessionId)
    },
    30_000,
  )
  if (kid) killList.push(kid)
  check(!!kid, '1: filha da M1 subiu')
  await (
    await mcpAs(userData, fake.root, kid)
  ).call('handoff_ask', {
    handoffId: hres.handoffId,
    question: 'Posso seguir, M1?',
  })

  // ---- 2. IconRail → Todas as mães
  await goToArea(page, 'overview')
  await page.getByTestId('rail-room').click()
  check(await waitFor(page, 'Todas as mães', () => all().isVisible()), '2: rail abre Todas as mães')
  await waitFor(
    page,
    '3 tiles',
    async () => (await page.getByTestId('mother-tile').count()) === 3,
    15_000,
  )
  const tileIds = await page
    .getByTestId('mother-tile')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tile))
  check(
    tileIds.length === 3 && Object.values(M).every((m) => tileIds.includes(m.sessionId)),
    `2: 3 tiles, um por mãe (a filha fica de fora): ${tileIds.join(',')}`,
  )
  check(
    /3 mães · 2 features/.test(await page.getByTestId('all-mothers-summary').innerText()),
    '2: "3 mães · 2 features"',
  )
  check(
    await waitFor(
      page,
      'pedido da filha no tile da M1',
      async () => (await tileNum(M.m1.sessionId, 'mother-tile-kids')) === 1,
    ),
    '2: tile da M1 mostra "1 pedido das filhas · Abrir sala"',
  )
  await shot(page, '2-all-mothers')

  // ---- 3. composer do tile da M3
  await resetCounters()
  const c3 = tile(M.m3.sessionId).getByTestId('card-prompt')
  await c3.click()
  await c3.fill('status?')
  await c3.press('Enter')
  check(
    await waitFor(page, 'linha no stub da M3', async () =>
      logOf(M.m3.ccSessionId).includes('line:status?'),
    ),
    '3: o texto chega ao stub da M3',
  )
  check(
    !logOf(M.m1.ccSessionId).includes('line:status?') &&
      !logOf(M.m2.ccSessionId).includes('line:status?'),
    '3: e não ao da M1 nem ao da M2',
  )
  check(
    await waitFor(page, 'cauda da M3', async () =>
      /RESPOSTA-MAE: status\?/.test(
        await tile(M.m3.sessionId).getByTestId('mother-tile-tail').innerText(),
      ),
    ),
    '3: a resposta aparece na cauda do tile da M3 (vinda do JSONL)',
  )
  const k3 = await counters()
  check(
    (k3.tail[M.m3.sessionId] ?? 0) >= 1 && k3.upd === 0,
    `3: ≥1 chat:transcript-tail da M3 (${k3.tail[M.m3.sessionId] ?? 0}) e 0 transcript-update (${k3.upd})`,
  )
  await shot(page, '3-tile-composer')

  // ---- 4. aprovar a permissão da M2 no tile
  await page.keyboard.press('Escape')
  const c2 = tile(M.m2.sessionId).getByTestId('card-prompt')
  await c2.click()
  await c2.fill('PEDE-PERMISSAO tile')
  await c2.press('Enter')
  const approve = tile(M.m2.sessionId)
    .getByTestId('mother-tile-menu')
    .getByTestId('attention-action-approve')
  check(
    await waitFor(page, 'menu no tile da M2', () => approve.isVisible(), 25_000),
    '4: AttentionMenuPanel no tile da M2',
  )
  await page.keyboard.press('Escape')
  const nBefore = await num('all-mothers-badge')
  const stripBefore = await num('all-mothers-strip-count')
  const ownM2 = await tileNum(M.m2.sessionId, 'mother-tile-own')
  const kidsM1 = await tileNum(M.m1.sessionId, 'mother-tile-kids')
  check(
    nBefore === stripBefore && nBefore === ownM2 + kidsM1 && ownM2 === 1,
    `4: badge (${nBefore}) = faixa (${stripBefore}) = pedidos dos tiles (${ownM2}+${kidsM1})`,
  )
  await shot(page, '4-tile-permission')
  await approve.click()
  check(
    await waitFor(page, 'stub da M2 recebe 1', async () =>
      logOf(M.m2.ccSessionId).includes('menu-answer:1'),
    ),
    '4: Aprovar no tile responde o menu da M2 (stub recebe "1")',
  )
  check(
    await waitFor(page, 'badge cai', async () => (await num('all-mothers-badge')) === nBefore - 1),
    `4: badge cai para ${nBefore - 1}`,
  )
  check((await num('all-mothers-strip-count')) === stripBefore - 1, '4: a faixa cai junto')
  check(
    (logOf(M.m2.ccSessionId).match(/menu-answer:/g) ?? []).length === 1,
    '4: o menu foi respondido uma vez só',
  )
  await shot(page, '4-tile-approved')

  // ---- 5. Enter no tile da M1 → sala de F1
  await tile(M.m1.sessionId).focus()
  await page.keyboard.press('Enter')
  check(
    await waitFor(
      page,
      'sala de F1',
      async () =>
        (await page
          .getByTestId('room-title')
          .innerText()
          .catch(() => '')) === 'B2b F1 mães',
    ),
    '5: Enter no tile abre a sala de F1 (level feature)',
  )
  check(
    await waitFor(page, 'composer da M1 com foco', () =>
      page.evaluate(
        (id) =>
          !!document.activeElement?.closest(
            `[data-testid="room-mother"][data-session-id="${id}"]`,
          ) && document.activeElement?.tagName === 'TEXTAREA',
        M.m1.sessionId,
      ),
    ),
    '5: foco no composer da coluna da M1',
  )
  const backBadge = (await page.getByTestId('room-back-badge').count())
    ? await num('room-back-badge')
    : 0
  check(backBadge === 0, `5: badge do "← Todas" = pedidos de F2 (0): ${backBadge}`)

  // ---- 6. split com M1 e M2
  check(
    await waitFor(
      page,
      '2 colunas',
      async () => (await page.getByTestId('room-mother').count()) === 2,
    ),
    '6: 2 colunas lado a lado (M1 e M2)',
  )
  await shot(page, '6-split')
  await colComposer(M.m2.sessionId).click()
  await colComposer(M.m2.sessionId).fill('coluna dois')
  await colComposer(M.m2.sessionId).press('Enter')
  check(
    await waitFor(page, 'stub da M2 pela coluna', async () =>
      logOf(M.m2.ccSessionId).includes('line:coluna dois'),
    ),
    '6: mensagem pela coluna da M2 chega ao stub da M2',
  )
  await col(M.m1.sessionId).locator('header').click()
  await page.keyboard.press('Control+.')
  check(
    await waitFor(
      page,
      'col 1 terminal',
      async () =>
        (await col(M.m1.sessionId).getAttribute('data-mode')) === 'terminal' &&
        (await col(M.m2.sessionId).getAttribute('data-mode')) === 'chat',
    ),
    '6: Ctrl+. com a coluna 1 ativa abre o Terminal só nela',
  )
  check(
    (await col(M.m1.sessionId).locator('.xterm').isVisible()) &&
      !(await col(M.m2.sessionId).locator('.xterm').isVisible()),
    '6: .xterm visível só na coluna 1',
  )
  await col(M.m2.sessionId).getByTestId('room-mother-mode-terminal').click()
  check(
    await waitFor(
      page,
      'col 2 terminal',
      async () =>
        (await col(M.m2.sessionId).getAttribute('data-mode')) === 'terminal' &&
        (await col(M.m1.sessionId).getAttribute('data-mode')) === 'chat',
    ),
    '6: Terminal na coluna 2 devolve a coluna 1 ao chat',
  )
  await shot(page, '6-split-terminal')
  // Esc: com texto só tira o foco (rascunho fica); na sala, volta a Todas. Vazio,
  // o composer manda o Esc para a TUI (interromper), como em qualquer chat.
  await colComposer(M.m1.sessionId).click()
  await colComposer(M.m1.sessionId).fill('rascunho')
  await page.keyboard.press('Escape')
  check(
    await waitFor(
      page,
      'Esc com texto tira o foco',
      () =>
        page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'feature-room'),
      3000,
    ),
    '6: Esc com texto no composer só tira o foco',
  )
  check((await colComposer(M.m1.sessionId).inputValue()) === 'rascunho', '6: o rascunho fica')
  await page.keyboard.press('Escape')
  check(
    await waitFor(page, 'Esc volta a Todas', () => all().isVisible(), 5000),
    '6: Esc na sala volta a Todas as mães',
  )

  // ---- 7. viewport 1024: tiles pausados, sem scroll lateral
  const extra: Mother[] = []
  for (let i = 0; i < 9; i++) extra.push(await startMother(ids.F2, ids.C, `extra ${i}`))
  killList.push(...extra.map((m) => m.sessionId))
  // O stub só cria o JSONL na 1ª linha: um "oi" a cada extra antes de medir.
  check(
    await waitFor(
      page,
      'extras vivas',
      async () => {
        const live = await liveGlobal(page)
        return extra.every((m) => live.some((s) => s.id === m.sessionId && s.status !== 'ended'))
      },
      40_000,
    ),
    '7: as 9 mães extras sobem',
  )
  for (const m of extra)
    await page.evaluate(
      (id) => (window as any).api.sendTo.send({ sessionId: id, text: 'oi', when: 'now' }),
      m.sessionId,
    )
  check(
    await waitFor(
      page,
      'transcripts das extras',
      async () => extra.every((m) => logOf(m.ccSessionId).includes('line:oi')),
      30_000,
    ),
    '7: cada extra tem transcript no disco',
  )
  await page.setViewportSize({ width: 1024, height: 700 })
  check(
    await waitFor(
      page,
      '12 tiles',
      async () => (await page.getByTestId('mother-tile').count()) === 12,
      40_000,
    ),
    '7: 12 tiles com as mães extras',
  )
  await page.waitForTimeout(800)
  const states = await page
    .getByTestId('mother-tile')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.live))
  const live = states.filter((s) => s === 'live').length
  check(states.includes('paused') && live <= 8, `7: há tiles pausados (${live} vivos de 12)`)
  // O 10º tile (4ª linha em 1024×700) está fora da tela no topo da grade.
  const tenth = page.locator('[data-testid="mother-tile"][data-tile-index="9"]')
  const paused =
    (await tenth.getAttribute('data-live')) === 'paused'
      ? await tenth.getAttribute('data-tile')
      : null
  check(!!paused, `7: o 10º tile está pausado fora da tela (${paused})`)
  const pausedCc = [...extra, ...Object.values(M)].find((m) => m.sessionId === paused)?.ccSessionId
  // Linha nova direto no JSONL (sem passar pela PTY: a atividade e a ordem não
  // mudam). Assinado, o main emitiria a cauda em 400ms; pausado, nada chega.
  const jsonl = pausedCc ? findJsonl(fake.root, `${pausedCc}.jsonl`) : null
  await resetCounters()
  if (jsonl)
    appendFileSync(
      jsonl,
      `${JSON.stringify({
        type: 'user',
        uuid: `u-paused-${Date.now()}`,
        sessionId: pausedCc,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'fora da tela' },
      })}\n`,
    )
  check(!!jsonl, `7: transcript do tile pausado no disco (${jsonl})`)
  await page.waitForTimeout(1500)
  const kPaused = await counters()
  check(
    !!paused && (kPaused.tail[paused] ?? 0) === 0,
    `7: tile pausado não recebe chat:transcript-tail (unwatch no main): ${kPaused.tail[paused ?? ''] ?? 0}`,
  )
  await page.getByTestId('all-mothers-grid').evaluate((g) => (g.scrollTop = g.scrollHeight))
  check(
    (await waitFor(
      page,
      'tile volta vivo',
      async () => (await tile(paused ?? '').getAttribute('data-live')) === 'live',
      5000,
    )) &&
      (await waitFor(
        page,
        'cauda ao voltar',
        async () => ((await counters()).tail[paused ?? ''] ?? 0) >= 1,
        5000,
      )),
    '7: ao voltar à tela o tile readquire a cauda (1º emit do watch)',
  )
  const noX = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  check(noX, '7: sem scroll horizontal em 1024px')
  await shot(page, '7-viewport-1024')
} catch (e) {
  check(false, `exceção ${(e as Error).stack ?? e}`)
  await shot(page, 'exception')
} finally {
  for (const id of killList) {
    await page.evaluate((s) => (window as any).api.sessions.kill(s), id).catch(() => {})
  }
  await page.waitForTimeout(800).catch(() => {})
  logs.stop()
  await app.close()
}

{
  // Depois do close: o app grava em WAL, a leitura com ele aberto via sql.js não vê.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
  const want = [
    [M.m1?.sessionId, ids.F1],
    [M.m2?.sessionId, ids.F1],
    [M.m3?.sessionId, ids.F2],
  ]
  const ok = want.filter(
    ([id, f]) =>
      (db.prepare('SELECT feature_id f FROM sessions WHERE id = ?').get(id ?? '') as any)?.f === f,
  ).length
  db.close()
  check(ok === 3, `2: SQL — M1/M2 em F1 e M3 em F2 (sessions.feature_id): ${ok}/3`)
}
check(out.pageerrors.length === 0, `0 pageerror (${out.pageerrors.length})`)
for (const e of out.pageerrors) note(e.slice(0, 400))
const failed = out.checks.filter((c) => !c.ok)
console.log(
  `\n[b2b] RESULT ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${out.checks.length - failed.length}/${out.checks.length} · ${SHOTS}`,
)
writeFileSync(join(SB, 'result.json'), JSON.stringify(out, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
