// Ciclo de vida da filha vinculada no app buildado: minimizar × encerrar.
// HOME fake + stub do claude, cópia do perfil (CM_DRIVE_SAFE=1), GPU LIGADA (com
// ela desligada a janela deste harness nunca fica visível e nenhum clique estabiliza).
//   1. filha nasce sem aba            → chip "↳ 1 em 2º plano" sob a mãe
//   2. abre a aba e Minimiza          → processo vivo, handoff running, sem marca
//   3. X da aba + Desfazer            → nada morre, a marca some
//   4. filha trabalhando + X recusado → a confirmação segura o encerramento
//   5. X confirmado                   → processo morto, handoff interrupted,
//      ended_by_user_at preenchido, ainda vinculada, motivo "encerrada pelo
//      usuário" e um aviso à mãe no ledger de wakes
//   6. Retomar                        → mesmo handoff, running, marca limpa, apelido igual
// Rodar (depois de npm run rebuild:native && npm run build):
//   VCL_SHOTS=<dir> npx tsx e2e/scenarios/validate-child-lifecycle.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Page } from 'playwright'
import {
  cleanCopy,
  closeOverlays,
  liveGlobal,
  mcpAs,
  spawnSession,
  waitFor as seedWaitFor,
} from '../driver/crew-seed'
import { createFakeHome } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { copyRealUserData, launchApp, writeCopyPrefs } from '../driver/launch'
import { waitReady } from '../driver/nav'

const RUN_ID = Date.now()
const SHOTS = process.env.VCL_SHOTS ?? join(tmpdir(), `child-lifecycle-${RUN_ID}`)
const SANDBOX = join(tmpdir(), `vcl-sandbox-${RUN_ID}`)
mkdirSync(SHOTS, { recursive: true })
mkdirSync(SANDBOX, { recursive: true })

// END_UNDO_MS + END_KILL_GRACE_MS do appStore, com folga para o exit da PTY.
const KILL_AFTER_MS = 5000 + 750 + 2500
const CHILD_TAB = '.dv-default-tab[title*="encerra a filha"]'

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
const MOM = join(SANDBOX, 'mom')
const KID = join(SANDBOX, 'kid')
for (const d of [MOM, KID]) {
  mkdirSync(d, { recursive: true })
  git(d, 'init', '-q')
  writeFileSync(join(d, 'README.md'), 'x\n')
  git(d, 'add', '.')
  git(d, 'commit', '-qm', 'init')
}

const out = { checks: [] as Array<{ ok: boolean; label: string }>, notes: [] as string[] }
const check = (ok: boolean, label: string) => {
  out.checks.push({ ok, label })
  console.log(`[vcl] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}
const waitFor = (page: Page, l: string, fn: () => Promise<boolean>, t?: number) =>
  seedWaitFor(page, l, fn, t, out.notes)

const fake = createFakeHome({ parentDir: SANDBOX })
const userData = copyRealUserData()
const projects = await queryDb<{ id: string }>(
  userData,
  'SELECT id FROM projects ORDER BY position LIMIT 1',
)
const P0 = projects[0].id
await cleanCopy(userData, (db: any) => {
  for (const [id, path] of [
    ['vcl-mom', MOM],
    ['vcl-kid', KID],
  ])
    db.run(
      'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 990, ?)',
      [id, P0, id, path, RUN_ID],
    )
})
writeCopyPrefs(userData, {
  claude_command: fake.fakeCliPath('claude'),
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
  'gpu.disabled': JSON.stringify(false),
  'gpu.disabledByUser': JSON.stringify(false),
  'gpu.autoDisabled': null,
})
// Herdado do shell, desligaria a GPU por baixo das prefs.
delete process.env.CM_DISABLE_GPU

const db = <T = Record<string, unknown>>(sql: string, ...params: Array<string | number>): T[] => {
  const d = new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
  try {
    return d.prepare(sql).all(...params) as T[]
  } finally {
    d.close()
  }
}
interface HandoffRow {
  status: string
  child_session_id: string | null
  mother_session_id: string | null
  ended_by_user_at: number | null
  error: string | null
}
const handoffRow = (id: string) =>
  db<HandoffRow>(
    'SELECT status, child_session_id, mother_session_id, ended_by_user_at, error FROM handoffs WHERE id = ?',
    id,
  )[0]

const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const pageErrors: string[] = []
page.on('pageerror', (e: Error) => pageErrors.push(e.message))
// A confirmação do Encerrar é window.confirm: cada diálogo é contado e respondido
// com o que o passo pediu.
let confirmAnswer = true
const confirms: string[] = []
page.on('dialog', (d) => {
  confirms.push(d.message())
  void (confirmAnswer ? d.accept() : d.dismiss())
})
const shot = (n: string) => page.screenshot({ path: join(SHOTS, `${n}.png`) }).catch(() => {})
const isLive = async (sessionId: string) => (await liveGlobal(page)).some((s) => s.id === sessionId)
const backgroundCount = () =>
  page
    .getByTestId('strip-background-children')
    .first()
    .getAttribute('data-strip-background')
    .catch(() => null)

let failed = false
try {
  await app.evaluate(({ BrowserWindow }: any) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setContentSize(1440, 900)
  })
  await waitReady(page)
  await page
    .locator('.spl-skip')
    .click({ timeout: 3000 })
    .catch(() => {})

  // ---- mãe + filha (session_handoff pelo MCP, como a mãe faria) ----
  const before = new Set((await liveGlobal(page)).map((s) => s.id))
  await spawnSession(page, 'vcl-mom')
  let M = ''
  await waitFor(page, 'mãe viva', async () => {
    M =
      (await liveGlobal(page)).find((s) => s.repo?.id === 'vcl-mom' && !before.has(s.id))?.id ?? ''
    return !!M
  })
  const asM = await mcpAs(userData, fake.root, M)
  const res = (await asM.call('session_handoff', {
    targetRepo: 'vcl-kid',
    fromRepo: 'vcl-mom',
    task: 'vcl filha',
    mode: 'auto-edits',
  })) as { handoffId?: string; error?: string }
  out.notes.push(`session_handoff: ${JSON.stringify(res).slice(0, 300)}`)
  if (!check(!!res.handoffId && !res.error, 'session_handoff aceito')) throw new Error('sem filha')
  const H = res.handoffId as string
  let K = ''
  await waitFor(page, 'filha viva', async () => {
    K = handoffRow(H)?.child_session_id ?? ''
    return !!K && (await isLive(K))
  })
  check(!!K, 'filha nasceu (PTY viva)')
  const child = db<{ title: string | null; cc_session_id: string }>(
    'SELECT title, cc_session_id FROM sessions WHERE id = ?',
    K,
  )[0]
  const alias = child.title ?? ''
  out.notes.push(`filha: ${K} alias=${alias} cc=${child.cc_session_id}`)
  await closeOverlays(page)

  // ---- 1. sem aba: chip de 2º plano ----
  await waitFor(page, 'chip 2º plano = 1', async () => (await backgroundCount()) === '1', 15_000)
  check((await backgroundCount()) === '1', 'filha sem aba aparece como "↳ 1 em 2º plano"')

  const openChildTab = async (): Promise<boolean> => {
    await closeOverlays(page)
    await page.getByTestId('strip-background-children').first().click()
    await page.getByText(alias, { exact: false }).last().click()
    return waitFor(page, 'aba da filha', async () => (await page.locator(CHILD_TAB).count()) === 1)
  }

  // ---- 2. Minimizar não encerra ----
  check(await openChildTab(), 'aba da filha aberta (rótulo do X diz que encerra a filha)')
  await page.getByRole('button', { name: 'Minimizar', exact: true }).last().click()
  await waitFor(page, 'aba minimizada', async () => (await page.locator(CHILD_TAB).count()) === 0)
  await page.waitForTimeout(KILL_AFTER_MS)
  check(await isLive(K), 'Minimizar: o processo da filha segue vivo')
  check(handoffRow(H).status === 'running', `Minimizar: handoff running (${handoffRow(H).status})`)
  check(handoffRow(H).ended_by_user_at === null, 'Minimizar: sem marca de encerrada')
  check((await backgroundCount()) === '1', 'Minimizar: a filha volta ao chip de 2º plano')

  // ---- 3. X + Desfazer ----
  check(await openChildTab(), 'aba da filha reaberta')
  await page.locator(`${CHILD_TAB} .dv-default-tab-action`).click()
  await waitFor(page, 'toast de filha encerrada', async () =>
    (await page.getByTestId('toast-card').allInnerTexts()).some((t) =>
      t.includes('Filha encerrada'),
    ),
  )
  check(confirms.length === 0, 'filha parada: o X não pede confirmação')
  await waitFor(page, 'marca gravada', async () => handoffRow(H).ended_by_user_at !== null, 5000)
  check(
    handoffRow(H).ended_by_user_at !== null,
    'X: marca gravada já no clique (janela de Desfazer)',
  )
  await shot('toast-filha-encerrada')
  await page
    .getByTestId('toast-card')
    .getByRole('button', { name: 'Desfazer', exact: true })
    .first()
    .click()
  await waitFor(page, 'marca desfeita', async () => handoffRow(H).ended_by_user_at === null, 5000)
  await page.waitForTimeout(KILL_AFTER_MS)
  check(await isLive(K), 'Desfazer: o processo não foi morto')
  check(handoffRow(H).ended_by_user_at === null, 'Desfazer: não deixa marca')
  check(handoffRow(H).status === 'running', 'Desfazer: handoff segue running')
  check((await page.locator(CHILD_TAB).count()) === 1, 'Desfazer: a aba voltou')

  // ---- 4. trabalhando: confirmação recusada segura tudo ----
  const pid = fake.readSessionFiles().find((f) => f.data.sessionId === child.cc_session_id)
    ?.data.pid
  if (check(pid != null, 'stub da filha localizado')) {
    fake.setStatus(pid as number, 'busy')
    await waitFor(
      page,
      'filha trabalhando',
      async () =>
        ((await liveGlobal(page)) as Array<{ id: string; status?: string }>).find((s) => s.id === K)
          ?.status === 'working',
      20_000,
    )
    confirmAnswer = false
    await page.locator(`${CHILD_TAB} .dv-default-tab-action`).click()
    await page.waitForTimeout(1500)
    check(confirms.length === 1, `filha trabalhando: o X pede confirmação (${confirms.length})`)
    check((await page.locator(CHILD_TAB).count()) === 1, 'recusou: a aba fica')
    check(handoffRow(H).ended_by_user_at === null, 'recusou: sem marca')
    confirmAnswer = true
  }

  // ---- 5. X confirmado: encerra de verdade, segue vinculada ----
  await page.locator(`${CHILD_TAB} .dv-default-tab-action`).click()
  await waitFor(page, 'aba fechada', async () => (await page.locator(CHILD_TAB).count()) === 0)
  await waitFor(page, 'filha morta', async () => !(await isLive(K)), KILL_AFTER_MS + 10_000)
  await waitFor(
    page,
    'handoff interrupted',
    async () => handoffRow(H).status === 'interrupted',
    10_000,
  )
  const ended = handoffRow(H)
  out.notes.push(`encerrada: ${JSON.stringify(ended)}`)
  check(!(await isLive(K)), 'X confirmado: processo da filha morto')
  check(ended.status === 'interrupted', `handoff interrupted (${ended.status})`)
  check(ended.ended_by_user_at !== null, 'ended_by_user_at preenchido')
  check(ended.child_session_id === K, 'segue vinculada (child_session_id intacto)')
  check(ended.mother_session_id === M, 'mãe intacta')
  check(/encerrada pelo usuário/i.test(ended.error ?? ''), `motivo gravado: ${ended.error}`)
  const wakes = db<{ reason: string; outcome: string }>(
    'SELECT reason, outcome FROM handoff_wake_deliveries WHERE handoff_id = ? ORDER BY created_at',
    H,
  )
  out.notes.push(`wakes: ${JSON.stringify(wakes)}`)
  check(
    wakes.some((w) => w.reason === 'interrupted'),
    'aviso à mãe registrado (reason=interrupted; o corpo é o motivo gravado acima)',
  )
  await shot('filha-encerrada')

  // ---- 6. Retomar: mesmo handoff, marca limpa, apelido igual ----
  // O stub não escreve transcript, e sem ele não há o que retomar.
  const transcriptDir = join(fake.home, '.claude', 'projects', 'vcl')
  mkdirSync(transcriptDir, { recursive: true })
  const transcript = join(transcriptDir, `${child.cc_session_id}.jsonl`)
  if (!existsSync(transcript)) writeFileSync(transcript, '')
  const resumeError = await page
    .evaluate((id) => (window as any).api.handoffs.resume(id), H)
    .then(
      () => null,
      (e: Error) => e.message,
    )
  if (check(resumeError === null, `handoffs.resume aceito (${resumeError ?? 'ok'})`)) {
    await waitFor(page, 'filha retomada', async () => {
      const row = handoffRow(H)
      return (
        row.status === 'running' && !!row.child_session_id && (await isLive(row.child_session_id))
      )
    })
    const resumed = handoffRow(H)
    check(resumed.status === 'running', `retomada: running (${resumed.status})`)
    check(resumed.ended_by_user_at === null, 'retomada: marca limpa')
    check(resumed.mother_session_id === M, 'retomada: mesma mãe')
    const title = db<{ title: string | null }>(
      'SELECT title FROM sessions WHERE id = ?',
      resumed.child_session_id as string,
    )[0]?.title
    check(title === alias, `retomada: apelido preservado (${title})`)
  }
} catch (e) {
  failed = true
  out.notes.push(`EXC: ${(e as Error).stack}`)
  await shot('exception')
} finally {
  check(
    pageErrors.length === 0,
    `0 pageerror (${pageErrors.length}) ${pageErrors.slice(0, 3).join(' | ')}`,
  )
  await app.close().catch(() => {})
  writeFileSync(join(SHOTS, 'result.json'), JSON.stringify(out, null, 2))
  rmSync(SANDBOX, { recursive: true, force: true })
  const bad = out.checks.filter((c) => !c.ok)
  console.log(
    `[vcl] ${out.checks.length - bad.length}/${out.checks.length} PASS${failed ? ' (EXCEPTION)' : ''}`,
  )
  for (const n of out.notes) console.log('[vcl] note', n)
  process.exit(bad.length || failed ? 1 : 0)
}
