import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import initSqlJs from 'sql.js'
import { launchApp, writeCopyPrefs } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { connectMcp } from '../driver/mcp'
import { queryDb } from '../driver/inspect'
import { goToArea, waitReady } from '../driver/nav'

// Validação da fila única (feat/attention-projection) no app real: HUD, Crew Dock,
// Ctrl+`, Home e TitleBar contra o length da projeção (attention:list), em estados
// NÃO-VAZIOS criados DEPOIS do boot (o boot converte needs_input em interrupted)
// pelos caminhos de produção — MCP do próprio processo e IPC do renderer:
//   fase 1 (HOME fake + stub do claude, cópia do perfil): child_question
//     (handoff_ask), child_failed (handoffs:fail, o "Forçar falha"), result_unconsumed
//     (handoff_report), child_interrupted (sessions:kill da PTY da filha, feature
//     sem outra sessão desenhada);
//   fase 2 (claude real, HOME real, CM_DRIVE_SAFE=1): uma sessão num repo
//     descartável (ATTN_SANDBOX) pede um comando Bash → menu de permissão real →
//     session_menu. O menu é recusado com Esc; nada roda.
// Rodar: npm run rebuild:native && npm run build, então
//   ATTN_SHOTS=<dir> ATTN_SANDBOX=<dir git descartável> npx tsx e2e/scenarios/validate-attention-projection.ts
//   ATTN_SKIP_REAL=1 pula a fase 2.

const SHOTS = process.env.ATTN_SHOTS ?? join(tmpdir(), `attn-projection-${Date.now()}`)
mkdirSync(SHOTS, { recursive: true })
const SANDBOX = process.env.ATTN_SANDBOX
const nodeRequire = createRequire(import.meta.url)
const out: { states: Capture[]; checks: Array<{ ok: boolean; label: string }>; notes: string[] } = {
  states: [],
  checks: [],
  notes: [],
}

interface Capture {
  phase: string
  state: string
  kinds: string[]
  projection: number
  titlebar: number
  home: number
  hudTotal: number | null
  crewRail: string
  crewBadge: number
  crewProjection: number
  switcherSum: number
  switcherRows: Array<{ key: string; kind: string; text: string }>
}

function check(ok: boolean, label: string): void {
  out.checks.push({ ok, label })
  console.log(`[attn] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
}

async function waitFor(page: Page, label: string, fn: () => Promise<boolean>, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      out.notes.push(`timeout: ${label}`)
      console.log(`[attn] timeout esperando: ${label}`)
      return false
    }
    await page.waitForTimeout(300)
  }
}

// O length da projeção na unidade de toda superfície (attentionSubjectKey).
async function projectionOf(page: Page): Promise<{ n: number; crew: number; kinds: string[] }> {
  return page.evaluate(async () => {
    const items = (await (window as any).api.attention.list()) as Array<{
      kind: string
      severity: string
      sessionId: string | null
      handoffId: string | null
      dedupKey: string
    }>
    const human = items.filter((i) => i.severity !== 'info')
    const keys = new Set(
      human.map((i) => (i.sessionId ? `s:${i.sessionId}` : `h:${i.handoffId ?? i.dedupKey}`)),
    )
    // O dock só mostra as filhas que a mãe lidera (isLedByMother): failed fica de fora.
    const hs = (await (window as any).api.handoffs.list()) as Array<{
      id: string
      status: string
      dismissedAt: number | null
      resumable: boolean
    }>
    const active = new Set(['pending', 'approved', 'running', 'needs_input'])
    const led = new Set(
      hs
        .filter(
          (h) =>
            h.dismissedAt == null &&
            (active.has(h.status) || (h.status === 'interrupted' && h.resumable)),
        )
        .map((h) => h.id),
    )
    const crew = new Set(
      human.flatMap((i) => (i.handoffId && led.has(i.handoffId) ? [i.handoffId] : [])),
    )
    return { n: keys.size, crew: crew.size, kinds: items.map((i) => `${i.kind}/${i.severity}`) }
  })
}

// Quick look / diálogos abertos (filha nova, Alt+A na crew) cobrem a tela.
async function closeOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const open =
      (await page.getByTestId('peek-backdrop').count()) +
      (await page.locator('[data-modal-overlay]').count())
    if (!open) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
}

const numberIn = (text: string | null | undefined) => Number.parseInt(text ?? '', 10) || 0

async function capture(page: Page, phase: string, state: string): Promise<Capture> {
  const tag = `${phase}-${state}`
  const shot = (name: string) =>
    page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) }).catch(() => {})
  await page.waitForTimeout(1500)
  await closeOverlays(page)
  const { n: projection, crew: crewProjection, kinds } = await projectionOf(page)

  const badge = page.locator('[data-testid="titlebar-attention-badge"]')
  const titlebar = (await badge.count()) ? numberIn(await badge.innerText()) : 0

  // Home
  await page
    .getByTitle(/^Home($| ·)/)
    .first()
    .click()
  await page.waitForTimeout(800)
  const home = numberIn(
    await page
      .getByTestId('home-in-box')
      .innerText()
      .catch(() => ''),
  )
  await shot('home-titlebar')

  // Crew Dock: recolhido, a trilha mostra "N!" (filhas na fila) ou o tamanho da equipe.
  await goToArea(page, 'projects')
  await page.waitForTimeout(800)
  const dock = page.getByTestId('crew-dock').first()
  const crewRail = (await dock.count())
    ? (await dock.innerText()).replace(/\s+/g, ' ').trim()
    : '(sem dock)'
  const crewBadge = Number(/(\d+)!/.exec(crewRail)?.[1] ?? 0)
  await shot('crew-dock')

  // HUD: Alt+A mostra "pos/total · ..."
  await page.keyboard.press('Alt+a')
  await page.waitForTimeout(600)
  const hudText = await page
    .getByTestId('attention-hud')
    .innerText()
    .catch(() => '')
  const m = /(\d+)\s*\/\s*(\d+)/.exec(hudText)
  const hudTotal = m ? Number(m[2]) : /nada esperando/i.test(hudText) ? 0 : null
  await shot('hud')
  await closeOverlays(page)

  // Ctrl+` no mapa
  await goToArea(page, 'projects')
  await page
    .getByRole('button', { name: /Mapa/ })
    .first()
    .click()
    .catch(() => {})
  await page.waitForTimeout(1200)
  await page.keyboard.down('Control')
  await page.keyboard.press('Backquote')
  await page.waitForTimeout(800)
  const switcherRows = await page.$$eval(
    '[data-testid="feature-switcher"] [role="option"]',
    (els) =>
      els.map((e) => ({
        key: e.getAttribute('data-key') ?? '',
        kind: e.getAttribute('data-kind') ?? '',
        text: (e.textContent ?? '').trim(),
      })),
  )
  const needs = await page
    .locator('[data-testid="feature-switcher"] [data-testid="feature-switcher-attention"]')
    .allTextContents()
  await shot('ctrl-backquote')
  await page.keyboard.press('Escape')
  await page.keyboard.up('Control')
  await page.waitForTimeout(400)

  const c: Capture = {
    phase,
    state,
    kinds,
    projection,
    titlebar,
    home,
    hudTotal,
    crewRail,
    crewBadge,
    crewProjection,
    switcherSum: needs.reduce((s, t) => s + numberIn(t), 0),
    switcherRows,
  }
  out.states.push(c)
  check(c.titlebar === projection, `${tag}: TitleBar ${c.titlebar} == projeção ${projection}`)
  check(c.home === projection, `${tag}: Home ${c.home} == projeção ${projection}`)
  check(c.switcherSum === projection, `${tag}: Ctrl+\` ${c.switcherSum} == projeção ${projection}`)
  check(c.hudTotal === projection, `${tag}: HUD ${c.hudTotal} == projeção ${projection}`)
  check(
    c.crewBadge === crewProjection,
    `${tag}: Crew Dock ${c.crewBadge}! == filhas lideradas na projeção ${crewProjection}`,
  )
  return c
}

// Banco da cópia: sem handoffs vivos do perfil real e sem abas restauradas (as
// abas dariam --resume em sessões reais).
async function cleanCopy(userData: string, extra?: (db: any) => void): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: () => nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'),
  })
  const path = join(userData, 'app.db')
  const db = new SQL.Database(readFileSync(path))
  const now = Date.now()
  db.run(
    `UPDATE handoffs SET status = CASE WHEN status IN ('pending','approved','running','needs_input')
       THEN 'done' ELSE status END, consumed_at = COALESCE(consumed_at, ?), dismissed_at = COALESCE(dismissed_at, ?)`,
    [now, now],
  )
  db.run("UPDATE workspace_state SET open_panes = '[]', dock_layout = NULL WHERE id = 1")
  extra?.(db)
  writeFileSync(path, Buffer.from(db.export()))
  db.close()
}

function mcpAs(userData: string, scratch: string, sessionId: string) {
  const cfg = JSON.parse(readFileSync(join(userData, 'mcp.json'), 'utf8'))
  const url = new URL(cfg.url)
  url.searchParams.set('s', sessionId)
  const dir = join(scratch, `mcp-as-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ ...cfg, url: url.toString() }))
  return connectMcp(dir)
}

async function spawnSession(page: Page, label: string): Promise<void> {
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(label)
  await search.press('Enter')
  const dialog = page.locator('div.fixed.inset-0', { hasText: `Nova sessão · ${label}` })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  const standard = dialog.getByRole('button', { name: 'Padrão', exact: true })
  if (await standard.count()) await standard.first().click()
  await dialog.getByRole('button', { name: 'Abrir', exact: true }).click()
}

type LiveRow = { id: string; ccSessionId: string | null; repo: { id: string } | null }
const liveGlobal = (page: Page) =>
  page.evaluate(() => (window as any).api.sessions.listLiveGlobal()) as Promise<LiveRow[]>

// ---------------- fase 1: HOME fake + stub ----------------
async function phaseStub(): Promise<void> {
  const fake = createFakeHome({ parentDir: tmpdir() })
  const first = await launchApp()
  await first.app.close()
  const userData = first.userDataCopy
  const repos = (
    await queryDb<{ id: string; label: string; path: string }>(
      userData,
      'SELECT id, label, path FROM repos ORDER BY label',
    )
  ).filter(
    (r, i, all) => r.path?.startsWith('/') && all.filter((x) => x.label === r.label).length === 1,
  )
  const features = await queryDb<{ id: string; title: string }>(
    userData,
    "SELECT id, title FROM features WHERE status NOT IN ('done','archived') ORDER BY updated_at DESC LIMIT 2",
  )
  if (repos.length < 5 || features.length < 2) throw new Error('cópia sem 5 repos / 2 features')
  await cleanCopy(userData)
  writeCopyPrefs(userData, {
    claude_command: fake.fakeCliPath('claude'),
    keybindings: null,
    'app.showIntroOnBoot': JSON.stringify(false),
    'session.defaultPaneMode': JSON.stringify('terminal'),
    'handoffs.requireApproval': JSON.stringify(false),
  })

  const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
  const logs = captureLogs(app, page)
  out.notes.push(`fase1 log: ${logs.logFile}`)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await waitReady(page)
    await page
      .locator('.spl-skip')
      .click({ timeout: 3000 })
      .catch(() => {})
    await capture(page, 'stub', '0-boot')

    const files = (): FakeSessionEntry[] => fake.readSessionFiles()
    const [motherRepo, ...childRepos] = repos
    await spawnSession(page, motherRepo.label)
    let M = ''
    await waitFor(page, 'mãe viva', async () => {
      M = (await liveGlobal(page)).find((s) => s.repo?.id === motherRepo.id)?.id ?? ''
      return !!M
    })
    const asM = await mcpAs(userData, fake.root, M)
    const kids: Array<{ handoffId: string; sessionId: string; ccSessionId: string }> = []
    for (const [i, repo] of childRepos.slice(0, 4).entries()) {
      // A 4ª filha numa feature só dela: interrompida, a feature fica sem lane.
      const featureId = i === 3 ? features[1].id : features[0].id
      const before = new Set(files().map((f) => f.data.pid))
      const res = await asM.call<{ handoffId: string }>('session_handoff', {
        targetRepo: repo.label,
        task: `attn ${i}`,
        mode: 'plan',
        featureId,
        force: true,
        forceReason: 'validação attention-projection',
      })
      await waitFor(page, `filha ${i}`, async () => files().some((f) => !before.has(f.data.pid)))
      let row: LiveRow | undefined
      await waitFor(page, `sessão da filha ${i}`, async () => {
        const hs = (await page.evaluate(() => (window as any).api.handoffs.list())) as Array<{
          id: string
          childSessionId: string | null
        }>
        const sid = hs.find((h) => h.id === res.handoffId)?.childSessionId
        row = sid ? (await liveGlobal(page)).find((s) => s.id === sid) : undefined
        return !!row?.ccSessionId
      })
      kids.push({ handoffId: res.handoffId, sessionId: row!.id, ccSessionId: row!.ccSessionId! })
    }
    await capture(page, 'stub', '1-crew-running')

    await (
      await mcpAs(userData, fake.root, kids[0].sessionId)
    ).call('handoff_ask', {
      handoffId: kids[0].handoffId,
      question: 'Posso apagar o índice antigo?',
    })
    await capture(page, 'stub', '2-child_question')

    await page.evaluate(
      (id) => (window as any).api.handoffs.fail({ id, error: 'validação: forçar falha' }),
      kids[1].handoffId,
    )
    await capture(page, 'stub', '3-child_failed')

    await (
      await mcpAs(userData, fake.root, kids[2].sessionId)
    ).call('handoff_report', {
      handoffId: kids[2].handoffId,
      summary: 'feito (validação)',
    })
    await capture(page, 'stub', '4-result_unconsumed')

    // Retomável: o transcript existe no HOME fake (é o que isResumableChild checa).
    const projDir = join(fake.home, '.claude', 'projects', 'attn')
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, `${kids[3].ccSessionId}.jsonl`), '{"type":"summary"}\n')
    await page.evaluate((id) => (window as any).api.sessions.kill(id), kids[3].sessionId)
    await waitFor(page, 'filha interrompida', async () =>
      (await projectionOf(page)).kinds.some((k) => k.startsWith('child_interrupted')),
    )
    const c = await capture(page, 'stub', '5-child_interrupted')
    check(
      c.switcherRows.some((r) => r.kind === 'attention'),
      'stub-5: a feature sem lane ganhou linha de atenção no Ctrl+`',
    )
    // Confirmar a linha de atenção abre a filha (quick look).
    await page.keyboard.down('Control')
    await page.keyboard.press('Backquote')
    await page.waitForTimeout(600)
    const row = page.locator(
      '[data-testid="feature-switcher"] [role="option"][data-kind="attention"]',
    )
    if (await row.count()) {
      await row.first().click()
      await page.keyboard.up('Control')
      const opened = await waitFor(
        page,
        'peek aberto pela linha de atenção',
        async () => (await page.locator('[data-peek-mode]').count()) > 0,
        10_000,
      )
      check(opened, 'stub-5: confirmar a linha de atenção abre o quick look da filha')
      await page.screenshot({ path: join(SHOTS, 'stub-5-attention-row-opened.png') })
      await page.keyboard.press('Escape')
    } else {
      await page.keyboard.up('Control')
    }
  } finally {
    out.notes.push(`fase1 pageerrors: ${errors.length}`)
    logs.stop()
    await app.close()
  }
}

// ---------------- fase 2: claude real, menu de permissão real ----------------
async function phaseReal(): Promise<void> {
  if (!SANDBOX) throw new Error('ATTN_SANDBOX ausente')
  const first = await launchApp()
  await first.app.close()
  const userData = first.userDataCopy
  const project = (await queryDb<{ id: string }>(userData, 'SELECT id FROM projects LIMIT 1'))[0]
  const label = 'attn-sandbox'
  await cleanCopy(userData, (db) =>
    db.run(
      `INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('attn-sandbox', ?, ?, ?, 999, ?)`,
      [project.id, label, SANDBOX, Date.now()],
    ),
  )
  writeCopyPrefs(userData, {
    'app.showIntroOnBoot': JSON.stringify(false),
    'session.defaultPaneMode': JSON.stringify('terminal'),
    keybindings: null,
  })
  const { app, page } = await launchApp({ userDataDir: userData })
  const logs = captureLogs(app, page)
  out.notes.push(`fase2 log: ${logs.logFile}`)
  try {
    await waitReady(page)
    await page
      .locator('.spl-skip')
      .click({ timeout: 3000 })
      .catch(() => {})
    await capture(page, 'real', '0-boot')
    await goToArea(page, 'projects')
    await page
      .getByRole('button', { name: /Terminais/ })
      .first()
      .click()
      .catch(() => {})
    await spawnSession(page, label)
    await page.screenshot({ path: join(SHOTS, 'real-0b-spawned.png') })
    const xterm = page.locator('.xterm:visible').first()
    await xterm.waitFor({ state: 'visible', timeout: 30_000 })
    const menuOf = async () =>
      ((await page.evaluate(() => (window as any).api.attention.list())) as any[]).find(
        (i) => i.kind === 'session_menu',
      )
    // 1º menu real: "confiar na pasta" (sandbox nunca aberto antes).
    const trust = await waitFor(
      page,
      'session_menu (trust)',
      async () => !!(await menuOf()),
      90_000,
    )
    check(trust, 'real: tela de confiança do claude virou session_menu')
    const trustItem = await menuOf()
    out.notes.push(`real trust: ${trustItem?.menuReason} · ${trustItem?.whyNow}`)
    if (trust) await capture(page, 'real', '1-session_menu-trust')
    await goToArea(page, 'projects')
    await page
      .getByRole('button', { name: /Terminais/ })
      .first()
      .click()
      .catch(() => {})
    await xterm.click({ position: { x: 120, y: 60 } })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await waitFor(page, 'trust respondido', async () => !(await menuOf()), 30_000)
    await page.waitForTimeout(6000)

    // 2º menu real: permissão de Bash em modo Padrão (ask).
    await xterm.click({ position: { x: 120, y: 60 } })
    await page.keyboard.type(
      'Run exactly this Bash command now: date > attn-probe.txt . Do nothing else.',
      { delay: 10 },
    )
    await page.keyboard.press('Enter')
    const menu = await waitFor(
      page,
      'session_menu (permission)',
      async () => (await menuOf())?.menuReason === 'permission',
      180_000,
    )
    check(menu, 'real: pedido de permissão do Bash virou session_menu permission')
    await page.screenshot({ path: join(SHOTS, 'real-2-permission-terminal.png') })
    const permItem = await menuOf()
    out.notes.push(`real permission: ${permItem?.menuReason} · ${permItem?.whyNow}`)
    if (menu) await capture(page, 'real', '2-session_menu-permission')
    await goToArea(page, 'projects')
    await page
      .getByRole('button', { name: /Terminais/ })
      .first()
      .click()
      .catch(() => {})
    // Recusa: nada roda no sandbox.
    await xterm.click({ position: { x: 120, y: 60 } }).catch(() => {})
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(SHOTS, 'real-3-declined.png') })
  } finally {
    logs.stop()
    await app.close()
  }
}

try {
  await phaseStub()
  if (process.env.ATTN_SKIP_REAL !== '1') await phaseReal()
} finally {
  writeFileSync(join(SHOTS, 'result.json'), JSON.stringify(out, null, 2))
  const failed = out.checks.filter((c) => !c.ok)
  console.log(`[attn] ${out.checks.length - failed.length}/${out.checks.length} PASS · ${SHOTS}`)
}
