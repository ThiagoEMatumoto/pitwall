// Cenário novo: regras de spawn de filha (posse por diretório + sem exigência de conexão)
// no app real buildado, HOME fake + stub do claude, cópia do perfil (CM_DRIVE_SAFE=1).
//   W1 writer  → repo "csr-shared", feature F1 (worktree wt1)
//   W2 writer  → repo "csr-shared", feature F2 (worktree wt2)
//   P  plan    → repo "csr-shared", feature F1 (mesmo checkout de W1)
//   L  writer  → repo "csr-lone", sem conexão nenhuma com o repo da mãe
//   X  writer  → "csr-shared"/F1 de novo, sem force: tem de ser RECUSADO
// Todas as 4 nascem (PTY viva, cwd certo) e aparecem como linha na Room da feature.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Page } from 'playwright'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
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
import { waitReady } from '../driver/nav'

// Rodar: CSR_SHOTS=<dir> CSR_SANDBOX=<dir> npx tsx e2e/scenarios/child-spawn-rules.ts
const RUN_ID = Date.now()
const SHOTS = process.env.CSR_SHOTS ?? join(tmpdir(), `child-spawn-rules-${RUN_ID}`)
const SANDBOX = process.env.CSR_SANDBOX ?? join(tmpdir(), `csr-sandbox-${RUN_ID}`)
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })
mkdirSync(SANDBOX, { recursive: true })

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
const MOM = join(SANDBOX, 'mom')
const SHARED = join(SANDBOX, 'shared')
const LONE = join(SANDBOX, 'lone')
const WT1 = join(SANDBOX, 'shared-wt1')
const WT2 = join(SANDBOX, 'shared-wt2')
for (const d of [MOM, SHARED, LONE]) {
  mkdirSync(d, { recursive: true })
  git(d, 'init', '-q')
  writeFileSync(join(d, 'README.md'), 'x\n')
  git(d, 'add', '.')
  git(d, 'commit', '-qm', 'init')
}
git(SHARED, 'worktree', 'add', '-q', WT1, '-b', 'wt1')
git(SHARED, 'worktree', 'add', '-q', WT2, '-b', 'wt2')

const out = { checks: [] as Array<{ ok: boolean; label: string }>, notes: [] as string[] }
const check = (ok: boolean, label: string) => {
  out.checks.push({ ok, label })
  console.log(`[csr] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}
const waitFor = (page: Page, l: string, fn: () => Promise<boolean>, t?: number) =>
  seedWaitFor(page, l, fn, t, out.notes)

const fake = createFakeHome({ parentDir: SANDBOX })
const first = await launchApp()
await first.app.close()
const userData: string = first.userDataCopy
const proj = (await queryDb(userData, 'SELECT id FROM projects ORDER BY position LIMIT 1')) as Array<{
  id: string
}>
const P0 = proj[0].id
const now = Date.now()
const F1 = 'csr-feature-1'
const F2 = 'csr-feature-2'
const featDir = join(userData, 'features', P0)
mkdirSync(featDir, { recursive: true })
for (const [id, slug] of [
  [F1, 'csr-um'],
  [F2, 'csr-dois'],
])
  writeFileSync(join(featDir, `${slug}.md`), `# ${slug}\n`)

await cleanCopy(userData, (db: any) => {
  const repo = (id: string, label: string, path: string) =>
    db.run(
      'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 990, ?)',
      [id, P0, label, path, now],
    )
  repo('csr-mom', 'csr-mom', MOM)
  repo('csr-shared', 'csr-shared', SHARED)
  repo('csr-lone', 'csr-lone', LONE)
  for (const [id, slug, title] of [
    [F1, 'csr-um', 'CSR Um'],
    [F2, 'csr-dois', 'CSR Dois'],
  ])
    db.run(
      `INSERT INTO features (id, project_id, slug, title, status, doc_path, synth_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'in-progress', ?, 'manual', ?, ?)`,
      [id, P0, slug, title, join(featDir, `${slug}.md`), now, now],
    )
  db.run('INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?,?,?,?)', [
    F1, 'csr-shared', 'wt1', WT1,
  ])
  db.run('INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?,?,?,?)', [
    F2, 'csr-shared', 'wt2', WT2,
  ])
  db.run('INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?,?,?,?)', [
    F1, 'csr-mom', null, null,
  ])
})
writeCopyPrefs(userData, {
  claude_command: fake.fakeCliPath('claude'),
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'handoffs.requireApproval': JSON.stringify(false),
})

const live = (sql: string) => {
  const d = new DatabaseSync(join(userData, 'app.db'), { readOnly: true })
  try {
    return d.prepare(sql).all() as any[]
  } finally {
    d.close()
  }
}
check(
  live(
    "SELECT 1 FROM repo_dependencies WHERE from_repo_id IN ('csr-mom','csr-lone') OR to_repo_id IN ('csr-mom','csr-lone')",
  ).length === 0,
  'pré: csr-lone não tem conexão nenhuma com csr-mom (repo_dependencies vazio)',
)

const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const logs = captureLogs(app, page)
out.notes.push(`log: ${logs.logFile}`)
const pageErrors: string[] = []
const consoleErrors: string[] = []
page.on('pageerror', (e: Error) => pageErrors.push(e.message))
page.on('console', (m: any) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300))
})
const shot = (n: string) => page.screenshot({ path: join(SHOTS, `${n}.png`) }).catch(() => {})

async function openRoom(F: string): Promise<boolean> {
  await closeOverlays(page)
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  await page.waitForTimeout(700)
  const opt = page.locator(`[data-testid="feature-switcher"] [role="option"][data-key="${F}"]`)
  if (!(await opt.count())) {
    await page.keyboard.press('Escape')
    await page.keyboard.up('Control')
    return false
  }
  for (let i = 0; i < 20 && (await opt.getAttribute('aria-selected')) !== 'true'; i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(80)
  }
  await page.keyboard.up('Control')
  await page.waitForTimeout(800)
  return page.getByTestId('feature-room').isVisible()
}

const canon = (p: string) => realpathSync(p)
let failed = false
try {
  await app.evaluate(({ BrowserWindow }: any) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setContentSize(1440, 900)
  })
  await waitReady(page)
  await page.locator('.spl-skip').click({ timeout: 3000 }).catch(() => {})

  // Mãe
  const before = new Set((await liveGlobal(page)).map((s: any) => s.id))
  await spawnSession(page, 'csr-mom')
  let M = ''
  await waitFor(page, 'mãe viva', async () => {
    M = (await liveGlobal(page)).find((s: any) => s.repo?.id === 'csr-mom' && !before.has(s.id))?.id ?? ''
    return !!M
  })
  await page.evaluate(([s, f]) => (window as any).api.sessions.setFeature(s, f), [M, F1])
  const asM = await mcpAs(userData, fake.root, M)

  const specs = [
    { key: 'W1', targetRepo: 'csr-shared', mode: 'auto-edits', featureId: F1, dir: WT1 },
    { key: 'W2', targetRepo: 'csr-shared', mode: 'auto-edits', featureId: F2, dir: WT2 },
    { key: 'P', targetRepo: 'csr-shared', mode: 'plan', featureId: F1, dir: WT1 },
    { key: 'L', targetRepo: 'csr-lone', mode: 'auto-edits', featureId: F1, dir: LONE },
  ] as const
  const kids: Record<string, { handoffId: string; sessionId: string }> = {}
  for (const s of specs) {
    const res = (await asM.call('session_handoff', {
      targetRepo: s.targetRepo,
      fromRepo: 'csr-mom',
      task: `csr ${s.key}`,
      mode: s.mode,
      featureId: s.featureId,
    })) as any
    out.notes.push(`${s.key}: ${JSON.stringify(res).slice(0, 300)}`)
    if (!check(!!res?.handoffId && !res?.error, `${s.key}: session_handoff aceito (${s.mode})`)) continue
    let sid = ''
    const born = await waitFor(
      page,
      `sessão ${s.key}`,
      async () => {
        const hs = (await page.evaluate(() => (window as any).api.handoffs.list())) as any[]
        sid = hs.find((h) => h.id === res.handoffId)?.childSessionId ?? ''
        return !!sid && (await liveGlobal(page)).some((x: any) => x.id === sid)
      },
      30_000,
    ).then(
      () => true,
      () => false,
    )
    check(born, `${s.key}: filha nasceu (PTY viva)`)
    kids[s.key] = { handoffId: res.handoffId, sessionId: sid }
    const row = live(`SELECT status, work_dir, mode FROM handoffs WHERE id='${res.handoffId}'`)[0]
    out.notes.push(`${s.key} db: ${JSON.stringify(row)}`)
    check(row?.status === 'running', `${s.key}: handoff running (${row?.status})`)
    check(row?.work_dir === canon(s.dir), `${s.key}: work_dir = ${s.dir} (${row?.work_dir})`)
  }
  // cwd real dos stubs
  await page.waitForTimeout(1500)
  const files = fake.readSessionFiles() as Array<{ data: { cwd: string; name?: string } }>
  out.notes.push(`stub cwds: ${JSON.stringify(files.map((f) => f.data.cwd))}`)
  for (const s of specs)
    check(
      files.some((f) => canon(f.data.cwd) === canon(s.dir)),
      `${s.key}: existe stub com cwd ${s.dir}`,
    )

  // Negativo: 2º writer no mesmo checkout de W1 é recusado
  const dup = (await asM.call('session_handoff', {
    targetRepo: 'csr-shared',
    fromRepo: 'csr-mom',
    task: 'csr X dup',
    mode: 'auto-edits',
    featureId: F1,
  })) as any
  out.notes.push(`X: ${JSON.stringify(dup).slice(0, 300)}`)
  check(!!dup?.error && !dup?.handoffId, '2º writer no worktree de W1 é recusado')

  // Room
  check(await openRoom(F1), 'Room F1 abre pelo Ctrl+`')
  await waitFor(page, 'Room F1 com 3 filhas', async () =>
    (await page.getByTestId('room-child-row').count()) === 3,
    20_000,
  ).catch(() => {})
  const rowsF1 = await page.getByTestId('room-child-row').allInnerTexts()
  out.notes.push(`F1 rows: ${JSON.stringify(rowsF1)}`)
  check(rowsF1.length === 3, `Room F1: 3 linhas de filha (W1, P, L) — ${rowsF1.length}`)
  check(await page.getByTestId('room-mother').isVisible(), 'Room F1: mãe visível')
  const repoText = await page.locator('#room-sessions-h').locator('xpath=ancestor::section').innerText()
  check(repoText.includes('csr-shared') && repoText.includes('csr-lone'), 'Room F1: grupos csr-shared e csr-lone')
  await shot('room-f1')
  check(await openRoom(F2), 'Room F2 abre pelo Ctrl+`')
  await waitFor(page, 'Room F2 com 1 filha', async () =>
    (await page.getByTestId('room-child-row').count()) === 1,
    20_000,
  ).catch(() => {})
  const rowsF2 = await page.getByTestId('room-child-row').allInnerTexts()
  out.notes.push(`F2 rows: ${JSON.stringify(rowsF2)}`)
  check(rowsF2.length === 1, `Room F2: 1 linha de filha (W2) — ${rowsF2.length}`)
  await shot('room-f2')
} catch (e) {
  failed = true
  out.notes.push(`EXC: ${(e as Error).stack}`)
  await shot('exception')
} finally {
  await page.waitForTimeout(1000)
  check(pageErrors.length === 0, `0 pageerror (${pageErrors.length}) ${pageErrors.slice(0, 3).join(' | ')}`)
  check(consoleErrors.length === 0, `0 console.error (${consoleErrors.length}) ${consoleErrors.slice(0, 3).join(' | ')}`)
  logs.stop()
  await app.close().catch(() => {})
  writeFileSync(join(SHOTS, 'result.json'), JSON.stringify(out, null, 2))
  const bad = out.checks.filter((c) => !c.ok)
  console.log(`[csr] ${out.checks.length - bad.length}/${out.checks.length} PASS${failed ? ' (EXCEPTION)' : ''}`)
  for (const n of out.notes) console.log('[csr] note', n)
  process.exit(bad.length || failed ? 1 : 0)
}
