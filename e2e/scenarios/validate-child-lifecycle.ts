// Ciclo de vida da filha vinculada no app buildado. Cada conferência sai como
// PASS/FAIL com o valor lido:
//   (1)  minimizar a aba                 → chip "↳ 1 em 2º plano", processo vivo
//   (2)  X na aba da filha trabalhando   → pede confirmação; confirmado: processo
//        morto, handoff interrupted, ended_by_user_at e o aviso à mãe
//   (3)  Desfazer dentro da janela       → filha viva, sem marca, mãe sem aviso
//   (4)  X numa sessão comum             → só desanexa, processo vivo
//   (5)  Retomar a encerrada e uma done  → mesmo apelido e --settings de filha no
//        argv do spawn, marca limpa
//   (6)  recado do usuário (QuickComposer) à filha fora da tela → a aba já está
//        aberta quando o envio chega ao main
//   (7)  recado da mãe                   → nenhuma aba abre, o foco fica, ponto de
//        não lida e aviso com "Abrir"
//   (8)  card: Minimizar / Encerrar filha / Desvincular; "Arquivar card" só com o
//        processo morto
//   (9)  filha done ociosa hiberna       → card "Dormindo"; "Acordar" devolve a
//        mesma identidade
//   (10) em todo passo o handoff segue apontando para a conversa da filha
//   (11) a mãe chama a filha que dorme   → acorda em 2º plano, handoff segue done
//
// (6): a ordem é lida no main, no handler do envio. O window.api chega congelado
// à janela e não dá para envolver de lá a função que o QuickComposer chama.
// (7) e (11): o stub do claude não chama tools, então o recado da mãe sai pelo
// MCP do próprio app (handoff_message com ?s=<mãe>), o handler que a mãe real chama.
// (9) e (11): o hibernador não tem gancho de teste. A janela da filha vai para
// 1 min (o mínimo da pref) e o cenário espera os ticks reais de 60 s.
// (10): retomar e acordar abrem uma linha nova em sessions e o handoff passa a
// apontar para ela. O que não pode acontecer é o vínculo ficar nulo, trocar de
// conversa ou de mãe, ou o id mudar fora de um relance. O vínculo é lido a cada
// 250 ms durante o cenário todo: um valor que só durasse o meio de um passo
// também reprova.
//
// HOME fake + stub do claude, cópia do perfil (CM_DRIVE_SAFE=1), GPU LIGADA (com
// ela desligada a janela deste harness nunca fica visível e nenhum clique estabiliza).
// Rodar (depois de npm run rebuild:native && npm run build), sem pipe na saída:
//   VCL_SHOTS=<dir> npx tsx e2e/scenarios/validate-child-lifecycle.ts > <log> 2>&1
// Leva até ~12 min: as duas hibernações esperam até 4,5 min cada.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator } from 'playwright'
import {
  ENDED_BY_USER,
  endedNoticeSince,
  tabOpenAtSend,
  undoOk,
  type SendTabsRead,
  type UndoRead,
} from '../driver/child-lifecycle'
import {
  cleanCopy,
  closeOverlays,
  liveGlobal,
  mcpAs,
  spawnSession,
  waitFor as seedWaitFor,
  type LiveRow,
} from '../driver/crew-seed'
import { argvFlag, createFakeHome } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { countNow, tapNextInvoke, tappedInvoke } from '../driver/ipc-tap'
import { copyRealUserData, launchApp, writeCopyPrefs } from '../driver/launch'
import { createLinkWatch, type Link, type LinkRead } from '../driver/link-watch'
import { goToArea, waitReady } from '../driver/nav'
import { CHILD_HIBERNATE_AFTER_MIN_PREF, HIBERNATE_AFTER_MIN_PREF } from '../../shared/hibernate'

// node:sqlite não tem tipos no @types/node do projeto.
interface Sqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, opts: { readOnly: boolean }) => Sqlite
}

const RUN_ID = Date.now()
const SHOTS = process.env.VCL_SHOTS ?? join(tmpdir(), `child-lifecycle-${RUN_ID}`)
const SANDBOX = join(tmpdir(), `vcl-sandbox-${RUN_ID}`)
mkdirSync(SHOTS, { recursive: true })
mkdirSync(SANDBOX, { recursive: true })

// END_UNDO_MS + END_KILL_GRACE_MS do appStore, com folga para o exit da PTY.
const KILL_AFTER_MS = 5000 + 750 + 2500
// Janela de 1 min + até dois ticks de 60 s (o primeiro só manda ler o
// transcript) + folga para o /exit sair.
const HIBERNATE_WAIT_MS = 270_000
const CHILD_TAB = '.dv-default-tab[title*="encerra a filha"]'
// A aba como o dockview a cria, com ou sem o rótulo já pintado.
const TAB = '.dv-tab'
// Painel dos menus abertos por portal (chip de 2º plano, "Mais ações" do card).
const MENU_PANEL = 'div.fixed.min-w-40'
const LINK_POLL_MS = 250
const SEND_PROMPT = 'sessions:send-prompt'
// Abas na janela no instante em que o envio chega ao main, sem espera: a que
// abrisse com o envio já a caminho fica fora da conta. Conta TAB e não CHILD_TAB:
// o dockview cria a aba no mesmo commit em que a pane entra no store, antes de o
// submit sair do await que a abriu. O rótulo da filha o React só pinta uma
// tarefa depois, e a leitura podia chegar antes dele.
const TABS_AT_SEND = countNow(TAB)

const LABELS: Record<number, string> = {
  1: 'minimizar a aba da filha: o chip mostra 1 e o processo segue vivo',
  2: 'X na aba da filha trabalhando: confirma, mata, interrupted, marca e aviso à mãe',
  3: 'Desfazer dentro da janela: perguntou uma vez, filha viva, sem marca e mãe sem aviso',
  4: 'X numa sessão comum: só desanexa, processo vivo',
  5: 'Retomar a encerrada e a done: mesmo apelido e --settings de filha, marca limpa',
  6: 'recado do usuário à filha fora da tela: a aba abre antes do envio',
  7: 'recado da mãe: nenhuma aba abre, o foco fica, não lida e aviso com "Abrir"',
  8: 'card: Minimizar/Encerrar/Desvincular; "Arquivar card" só com o processo morto',
  9: 'filha done ociosa hiberna: card "Dormindo" e "Acordar" devolve a mesma identidade',
  10: 'o handoff nunca solta a conversa da filha',
  11: 'a mãe chama a filha que dorme: acorda em 2º plano e o handoff segue done',
}
// Passos em que o handoff pode passar a apontar para outra linha de sessions.
const RELAUNCHES = new Set(['5 retomar encerrada', '5 retomar done', '9 acordar', '11 mãe acorda'])

type Detail = Record<string, unknown>
interface Outcome {
  ok: boolean
  detail: Detail
}
const results = new Map<number, Outcome>()
const notes: string[] = []
const say = (msg: string) => console.log(`[lifecycle] ${msg}`)
function record(n: number, ok: boolean, detail: Detail): void {
  results.set(n, { ok, detail })
  say(`${ok ? 'PASS' : 'FAIL'} (${n}) ${LABELS[n]} ${JSON.stringify(detail)}`)
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
const MOM = join(SANDBOX, 'mom')
const KID = join(SANDBOX, 'kid')
const SOLO = join(SANDBOX, 'solo')
for (const d of [MOM, KID, SOLO]) {
  mkdirSync(d, { recursive: true })
  git(d, 'init', '-q')
  writeFileSync(join(d, 'README.md'), 'x\n')
  git(d, 'add', '.')
  git(d, 'commit', '-qm', 'init')
}

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
    ['vcl-solo', SOLO],
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
  // Só a filha concluída hiberna aqui: a hibernação geral do perfil copiado
  // poderia tirar do ar a mãe ou a sessão comum.
  [HIBERNATE_AFTER_MIN_PREF]: JSON.stringify(0),
  [CHILD_HIBERNATE_AFTER_MIN_PREF]: JSON.stringify(1),
  'gpu.disabled': JSON.stringify(false),
  'gpu.disabledByUser': JSON.stringify(false),
  'gpu.autoDisabled': null,
})
// Herdado do shell, desligaria a GPU por baixo das prefs.
delete process.env.CM_DISABLE_GPU

const db = <T>(sql: string, ...params: Array<string | number>): T[] => {
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
const ccOf = (sessionId: string) =>
  db<{ cc_session_id: string | null }>(
    'SELECT cc_session_id FROM sessions WHERE id = ?',
    sessionId,
  )[0]?.cc_session_id ?? null
const titleOf = (sessionId: string) =>
  db<{ title: string | null }>('SELECT title FROM sessions WHERE id = ?', sessionId)[0]?.title ??
  null

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
// O stub que está no ar com a conversa (cada relance é outro processo).
const stubOf = (ccSessionId: string): number | null =>
  fake.readSessionFiles().find((f) => f.data.sessionId === ccSessionId && pidAlive(f.data.pid))
    ?.data.pid ?? null
const knownPids = (): Set<number> => new Set(fake.readSessionFiles().map((f) => f.data.pid))
const logOf = (pid: number): string => {
  const file = join(fake.logDir, `claude-${pid}.log`)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}
// O claude apaga o sessions/<pid>.json ao sair; o stub morto deixa o dele. O
// índice do app guarda um arquivo por conversa: com dois, o do processo morto
// pode vencer e a filha relançada aparece encerrada.
const dropDeadSessionFiles = (): void => {
  for (const f of fake.readSessionFiles())
    if (!pidAlive(f.data.pid)) rmSync(f.file, { force: true })
}
// O que o processo recebeu no spawn. O --settings é um arquivo por sessão: o que
// se compara é o conteúdo.
const spawnOf = (pid: number) => {
  const log = logOf(pid)
  const settingsPath = argvFlag(log, '--settings')
  return {
    resume: argvFlag(log, '--resume'),
    name: argvFlag(log, '-n'),
    settings: settingsPath && existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null,
  }
}
const inboundOf = (settings: string | null): unknown => {
  try {
    return settings
      ? (JSON.parse(settings) as { crossSessionInbound?: unknown }).crossSessionInbound
      : null
  } catch {
    return null
  }
}

const { app, page, mainOutput } = await launchApp({ userDataDir: userData, env: fake.env })
const electronProc = app.process()
process.on('exit', () => {
  try {
    electronProc.kill('SIGKILL')
  } catch {
    // já saiu
  }
})
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
const waitFor = (label: string, fn: () => Promise<boolean>, timeoutMs?: number) =>
  seedWaitFor(page, label, fn, timeoutMs, notes)

const links: Link[] = []

// O watchdog e o fim normal podem chegar juntos: o desfecho sai uma vez só.
let finishing: Promise<never> | null = null
const finish = (): Promise<never> => (finishing ??= conclude())
async function conclude(): Promise<never> {
  clearTimeout(watchdog)
  for (const n of Object.keys(LABELS).map(Number)) {
    if (!results.has(n)) record(n, false, { motivo: 'não executada' })
  }
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  writeFileSync(
    join(SHOTS, 'result.json'),
    JSON.stringify({ results: [...results], links, notes, pageErrors }, null, 2),
  )
  rmSync(SANDBOX, { recursive: true, force: true })
  for (const n of notes) say(`nota ${n}`)
  say(`nota pageerrors=${pageErrors.length} ${pageErrors.slice(0, 3).join(' | ')}`)
  const passed = [...results.values()].filter((r) => r.ok).length
  say(`${passed}/${results.size} PASS`)
  process.exit(passed === results.size && pageErrors.length === 0 ? 0 : 1)
}
const watchdog = setTimeout(() => {
  notes.push('watchdog: 20 min, abortando')
  void finish()
}, 20 * 60_000)

// Uma conferência que lança vira FAIL com o motivo, e as seguintes ainda rodam.
async function attempt(name: string, run: () => Promise<Outcome>): Promise<Outcome> {
  say(`--- ${name}`)
  try {
    return await run()
  } catch (e) {
    await shot(`falha-${name}`)
    return { ok: false, detail: { erro: (e as Error).message.split('\n')[0] } }
  }
}

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
  const gpu = await page.evaluate(() => (window as any).api.gpu.status())
  if (gpu.hwAccelDisabled) {
    throw new Error('o app subiu com a GPU desligada: neste harness a janela não aparece')
  }
  await goToArea(page, 'projects')

  type Live = LiveRow & { status?: string }
  const live = () => liveGlobal(page) as Promise<Live[]>
  const liveOf = async (sessionId: string) => (await live()).find((s) => s.id === sessionId)
  const isLive = async (sessionId: string) => {
    const s = await liveOf(sessionId)
    return !!s && s.status !== 'ended'
  }
  const paneOf = (sessionId: string): Locator =>
    page.locator(`[data-testid="session-pane"][data-session-id="${sessionId}"]`)
  const childTab = page.locator(CHILD_TAB)
  const toasts = page.getByTestId('toast-card')
  const toastsGone = () =>
    waitFor('avisos saíram', async () => (await toasts.count()) === 0, 10_000)
  const backgroundCount = async (): Promise<string | null> => {
    const chip = page.getByTestId('strip-background-children')
    return (await chip.count()) > 0 ? chip.first().getAttribute('data-strip-background') : null
  }
  const unreadDots = () => page.getByTestId('strip-background-unread').count()
  // Onde o usuário está: a pane com o foco do teclado, a aba ativa e o nº de abas.
  const whereUserIs = async () => ({
    foco: await page.evaluate(
      () =>
        document.activeElement?.closest('[data-session-id]')?.getAttribute('data-session-id') ??
        null,
    ),
    abaAtiva: await page
      .locator('.dv-tab.dv-active-tab .dv-default-tab-content')
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => null),
    abas: await page.locator('.dv-tab').count(),
  })

  // ---- mãe, ociosa: é no fim do turno dela que os avisos das filhas entram ----
  const before = new Set((await live()).map((s) => s.id))
  await spawnSession(page, 'vcl-mom')
  let M = ''
  await waitFor('mãe viva', async () => {
    M = (await live()).find((s) => s.repo?.id === 'vcl-mom' && !before.has(s.id))?.id ?? ''
    return !!M
  })
  if (!M) throw new Error('a mãe não subiu')
  const motherCc = (await liveOf(M))?.ccSessionId ?? ''
  await waitFor('stub da mãe', async () => stubOf(motherCc) !== null, 15_000)
  const motherPid = stubOf(motherCc)
  if (motherPid === null) throw new Error('o stub da mãe não gravou o session file')
  fake.setStatus(motherPid, 'idle')

  // ---- (4) X numa sessão comum ----
  const four = await attempt('4 x na sessao comum', async () => {
    const known = new Set((await live()).map((s) => s.id))
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await spawnSession(page, 'vcl-solo')
    let C = ''
    await waitFor('sessão comum viva', async () => {
      C = (await live()).find((s) => s.repo?.id === 'vcl-solo' && !known.has(s.id))?.id ?? ''
      return !!C
    })
    if (!C) throw new Error('a sessão comum não subiu')
    const pane = paneOf(C)
    await pane.waitFor({ state: 'visible', timeout: 20_000 })
    const cc = (await liveOf(C))?.ccSessionId ?? ''
    await waitFor('stub da sessão comum', async () => stubOf(cc) !== null, 15_000)
    const pid = stubOf(cc)
    // Pelo rótulo: cada grupo de abas tem a sua ativa, e a primeira ativa da janela
    // era a da mãe (o X fechava a aba dela, não a da sessão comum).
    const tab = page.locator('.dv-tab', { hasText: 'vcl-solo' }).first()
    const abaDoX = (await tab.locator('.dv-default-tab-content').innerText()).trim()
    const rotulo = await tab.locator('.dv-default-tab').getAttribute('title')
    const asked = confirms.length
    await tab.locator('.dv-default-tab-action').click()
    const fechou = await waitFor(
      'aba da sessão comum fechada',
      async () => (await pane.count()) === 0,
      10_000,
    )
    const aviso = (await toasts.allInnerTexts()).find((t) => t.includes('Aba fechada')) ?? null
    await page.waitForTimeout(KILL_AFTER_MS)
    const vivo = await isLive(C)
    const pidVivo = pid !== null && pidAlive(pid)
    return {
      ok: fechou && confirms.length === asked && vivo && pidVivo,
      detail: {
        abaDoX,
        rotuloDoX: rotulo,
        abaFechou: fechou,
        pediuConfirmacao: confirms.length - asked,
        aviso: aviso?.replace(/\s+/g, ' ').slice(0, 80) ?? null,
        processoVivo: vivo,
        pidVivo,
      },
    }
  })
  record(4, four.ok, four.detail)

  // ---- filha (session_handoff pelo MCP, como a mãe faria) ----
  const asM = await mcpAs(userData, fake.root, M)
  const res = (await asM.call('session_handoff', {
    targetRepo: 'vcl-kid',
    fromRepo: 'vcl-mom',
    task: 'vcl filha',
    mode: 'auto-edits',
  })) as { handoffId?: string; error?: string }
  if (!res.handoffId || res.error) {
    throw new Error(`session_handoff recusado: ${JSON.stringify(res).slice(0, 300)}`)
  }
  const H = res.handoffId
  let K = ''
  await waitFor('filha viva', async () => {
    K = handoffRow(H)?.child_session_id ?? ''
    return !!K && (await isLive(K))
  })
  if (!K) throw new Error('a filha não nasceu')
  const cc0 = ccOf(K) ?? ''
  const alias = titleOf(K) ?? ''
  await waitFor('stub da filha', async () => stubOf(cc0) !== null, 15_000)
  const bornPid = stubOf(cc0)
  if (bornPid === null || !alias) throw new Error('a filha nasceu sem stub vivo ou sem apelido')
  const born = spawnOf(bornPid)
  say(
    `filha ${K} apelido=${alias} conversa=${cc0} settingsDeFilha=${String(inboundOf(born.settings))}`,
  )
  // O stub não escreve transcript, e sem ele não há o que retomar nem o que o
  // gate da hibernação ler. Nasce já aqui: o card decide "retomável" na hora em
  // que o handoff vira interrupted.
  const transcriptDir = join(fake.home, '.claude', 'projects', 'vcl')
  mkdirSync(transcriptDir, { recursive: true })
  writeFileSync(join(transcriptDir, `${cc0}.jsonl`), '')
  await closeOverlays(page)

  // O último status da filha que o stream global entregou ao renderer.
  await page.evaluate((cc) => {
    const w = window as any
    w.__vclChildStatus = null
    w.api.sessions.onGlobalActivity((batch: Array<{ ccSessionId: string; status: string }>) => {
      const mine = batch.find((b) => b.ccSessionId === cc)
      if (mine) w.__vclChildStatus = mine.status
    })
  }, cc0)

  const linkWatch = createLinkWatch(
    () =>
      db<LinkRead>(
        `SELECT h.child_session_id AS filha, s.cc_session_id AS conversa, h.mother_session_id AS mae
           FROM handoffs h LEFT JOIN sessions s ON s.id = h.child_session_id
          WHERE h.id = ?`,
        H,
      )[0],
  )
  const linkPoll = setInterval(linkWatch.sample, LINK_POLL_MS)
  const link = (passo: string): void => {
    links.push(...linkWatch.mark(passo))
  }
  link('nascer')

  const childId = (): string => {
    const id = handoffRow(H).child_session_id
    if (!id) throw new Error('o handoff ficou sem filha (child_session_id nulo)')
    return id
  }
  const childPid = (): number => {
    const pid = stubOf(cc0)
    if (pid === null) throw new Error('nenhum stub vivo com a conversa da filha')
    return pid
  }
  const hibernatedRows = (): number =>
    db<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sessions WHERE cc_session_id = ? AND hibernated_at IS NOT NULL',
      cc0,
    )[0].n
  const setChildStatus = async (status: 'busy' | 'idle'): Promise<void> => {
    const shown = status === 'busy' ? 'working' : 'idle'
    fake.setStatus(childPid(), status)
    const reached = await waitFor(
      `filha ${shown}`,
      async () => (await liveOf(childId()))?.status === shown,
      20_000,
    )
    if (!reached) throw new Error(`a filha não ficou ${shown}`)
    // O X decide pela lista de sessões do renderer, que só anda com o stream global
    // de atividade: liveOf lê o main e chega antes. Assinar de novo faz o main
    // reenviar o batch inteiro, e o que a escuta do cenário viu o store também recebeu.
    const seen = await waitFor(
      `renderer com a filha ${shown}`,
      async () => {
        await page.evaluate(() => (window as any).api.sessions.watchGlobalActivity())
        await page.waitForTimeout(300)
        return (await page.evaluate(() => (window as any).__vclChildStatus)) === shown
      },
      20_000,
    )
    if (!seen) throw new Error(`o renderer não recebeu a filha ${shown}`)
  }
  const openChildTab = async (): Promise<void> => {
    if ((await childTab.count()) === 0) {
      await closeOverlays(page)
      await page.getByTestId('strip-background-children').first().click({ timeout: 10_000 })
      await page
        .locator(`${MENU_PANEL} button`, { hasText: alias })
        .first()
        .click({ timeout: 5000 })
    }
    const opened = await waitFor('aba da filha', async () => (await childTab.count()) === 1, 10_000)
    if (!opened) throw new Error('a aba da filha não abriu')
    await childTab.locator('.dv-default-tab-content').click()
  }
  const minimizeChildTab = async (): Promise<void> => {
    if ((await childTab.count()) === 0) return
    await childTab.locator('.dv-default-tab-content').click()
    await paneOf(childId()).locator('[aria-label="Minimizar"]').click({ timeout: 10_000 })
    const gone = await waitFor('aba minimizada', async () => (await childTab.count()) === 0, 10_000)
    if (!gone) throw new Error('a aba da filha não saiu no Minimizar')
  }
  // O card da filha no dock da equipe, com o dock aberto.
  const crewCard = async (): Promise<Locator> => {
    const card = page.locator(`[data-crew-card="${H}"]`)
    const rail = page.getByRole('button', { name: /^Equipe ·/ }).first()
    await waitFor(
      'dock da equipe',
      async () => (await card.count()) + (await rail.count()) > 0,
      10_000,
    )
    if ((await card.count()) === 0) await rail.click({ timeout: 5000 })
    await card.waitFor({ state: 'visible', timeout: 8000 })
    return card
  }
  const cardVerbs = async () => {
    const card = await crewCard()
    const more = card.getByLabel('Mais ações').first()
    await more.click({ timeout: 8000 })
    const panel = page.locator(MENU_PANEL)
    await panel.first().waitFor({ state: 'visible', timeout: 5000 })
    const menu = await panel
      .locator('button')
      .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()))
    await more.click()
    return {
      menu,
      xDeArquivar: await card.locator('[aria-label="Arquivar card"]').count(),
      card: (await card.innerText()).replace(/\s+/g, ' ').slice(0, 100),
    }
  }
  // O relance trouxe a mesma filha? Apelido no banco e no argv, --resume da
  // conversa dela e o --settings de filha.
  const relaunched = async (pidsBefore: ReadonlySet<number>): Promise<Outcome> => {
    const newStub = () =>
      fake
        .readSessionFiles()
        .find(
          (f) => f.data.sessionId === cc0 && !pidsBefore.has(f.data.pid) && pidAlive(f.data.pid),
        )?.data.pid ?? null
    await waitFor('stub da filha relançada', async () => newStub() !== null, 20_000)
    const pid = newStub()
    if (pid === null)
      throw new Error('a filha não relançou (nenhum processo novo com a conversa dela)')
    const spawn = spawnOf(pid)
    const id = childId()
    const title = titleOf(id)
    const vivo = await isLive(id)
    return {
      ok:
        vivo &&
        title === alias &&
        spawn.name === alias &&
        spawn.resume === cc0 &&
        inboundOf(spawn.settings) === 'accept',
      detail: {
        processoVivo: vivo,
        apelidoNoBanco: title,
        apelidoNoArgv: spawn.name,
        resume: spawn.resume,
        settingsDeFilha: inboundOf(spawn.settings),
        settingsIgualAoDoNascimento: spawn.settings !== null && spawn.settings === born.settings,
      },
    }
  }
  // O stub não grava transcript: a fila nunca acha a prova do que entregou à filha
  // e, 60 s depois, a entrega volta como "talvez não entregue". O relance reaponta
  // o item para a sessão nova e o gate da fila segura a hibernação até o usuário
  // decidir. O cenário decide por ele: Descartar.
  type Queued = { id: string; sessionId: string; recovery?: string; text: string }
  const childQueue = async (): Promise<Queued[]> => {
    const mine = new Set(
      db<{ id: string }>('SELECT id FROM sessions WHERE cc_session_id = ?', cc0).map((s) => s.id),
    )
    const queue = (await page.evaluate(() => (window as any).api.sendTo.queue())) as {
      items: Queued[]
    }
    return queue.items.filter((i) => mine.has(i.sessionId))
  }
  const brief = (i: Queued): string =>
    `${i.recovery ?? 'na fila'}: ${i.text.replace(/\s+/g, ' ').slice(0, 40)}`
  const dropUnproven = async (): Promise<string[]> => {
    const unproven = (await childQueue()).filter((i) => i.recovery === 'maybe-undelivered')
    for (const item of unproven) {
      await page.evaluate((itemId) => (window as any).api.sendTo.cancel(itemId), item.id)
    }
    return unproven.map(brief)
  }
  // Espera o hibernador do app tirar do ar a filha concluída, ociosa e sem aba.
  const sleepByApp = async (): Promise<{ asleep: boolean; detail: Detail }> => {
    await minimizeChildTab()
    dropDeadSessionFiles()
    const id = childId()
    const pid = childPid()
    fake.setStatus(pid, 'idle')
    const started = Date.now()
    const elapsed = () => Math.round((Date.now() - started) / 1000)
    const refusals = async (): Promise<Detail> => {
      const stats = await page.evaluate(() => (window as any).api.sessions.hibernateStats())
      return Object.fromEntries(Object.entries(stats.refusals as Detail).filter(([, n]) => n !== 0))
    }
    let asleep = false
    const dropped = await dropUnproven()
    for (let i = 1; !asleep && Date.now() - started < HIBERNATE_WAIT_MS; i++) {
      await page.waitForTimeout(3000)
      dropped.push(...(await dropUnproven()))
      asleep = hibernatedRows() > 0 && !pidAlive(pid) && !(await isLive(id))
      if (!asleep && i % 10 === 0) {
        say(
          `esperando a filha hibernar: ${elapsed()} s, recusas=${JSON.stringify(await refusals())}`,
        )
      }
    }
    return {
      asleep,
      detail: {
        hibernouPeloApp: asleep,
        esperaEmS: elapsed(),
        recusasDoGate: await refusals(),
        entregasSemProvaDescartadas: dropped,
        filaDaFilha: (await childQueue()).map(brief),
        logDoMain: mainOutput()
          .split('\n')
          .filter((l) => l.includes('hibernate') || l.includes('session_hibernated'))
          .slice(-4),
      },
    }
  }

  // ---- (1) minimizar ----
  const one = await attempt('1 minimizar', async () => {
    const chipAoNascer = await backgroundCount()
    await openChildTab()
    await minimizeChildTab()
    await waitFor('chip de 2º plano = 1', async () => (await backgroundCount()) === '1', 10_000)
    await page.waitForTimeout(KILL_AFTER_MS)
    const chip = await backgroundCount()
    const vivo = await isLive(K)
    const pid = stubOf(cc0)
    const row = handoffRow(H)
    return {
      ok:
        chip === '1' &&
        vivo &&
        pid !== null &&
        row.status === 'running' &&
        row.ended_by_user_at === null,
      detail: {
        chipAoNascer,
        chipDepoisDeMinimizar: chip,
        processoVivo: vivo,
        pidDoStub: pid,
        handoff: row.status,
        ended_by_user_at: row.ended_by_user_at,
      },
    }
  })
  record(1, one.ok, one.detail)
  link('1 minimizar')

  // ---- (7) recado da mãe com a filha em 2º plano ----
  const seven = await attempt('7 recado da mae', async () => {
    await minimizeChildTab()
    await toastsGone()
    await page
      .locator('[data-testid="session-pane"]:visible')
      .first()
      .locator('.xterm-screen')
      .click({ timeout: 10_000 })
    const antes = await whereUserIs()
    const text = `vcl recado da mae ${RUN_ID}`
    const told = (await asM
      .call('handoff_message', { handoffId: H, text })
      .catch((e: Error) => ({ error: e.message }))) as { delivered?: boolean; error?: string }
    const notice = toasts.filter({ hasText: 'recebeu mensagem da mãe' })
    const avisou = await waitFor('aviso do recado', async () => (await notice.count()) === 1, 8000)
    // Folga para uma aba que abrisse sozinha aparecer.
    await page.waitForTimeout(1000)
    const depois = await whereUserIs()
    const abasDaFilha = await childTab.count()
    const naoLida = await unreadDots()
    const abrir = notice.getByRole('button', { name: 'Abrir', exact: true })
    const temAbrir = (await abrir.count()) === 1
    await shot('7-recado-da-mae')
    const abriu =
      temAbrir &&
      (await abrir.click({ timeout: 5000 }).then(
        () => true,
        () => false,
      )) &&
      (await waitFor('aba aberta pelo aviso', async () => (await childTab.count()) === 1, 10_000))
    const naoLidaComAba = await unreadDots()
    return {
      ok:
        told.delivered === true &&
        avisou &&
        temAbrir &&
        naoLida === 1 &&
        abasDaFilha === 0 &&
        antes.foco !== null &&
        depois.foco === antes.foco &&
        depois.abaAtiva === antes.abaAtiva &&
        depois.abas === antes.abas &&
        abriu &&
        naoLidaComAba === 0,
      detail: {
        caminho: 'handoff_message pelo MCP do app com ?s=<mãe>',
        entrega: told,
        chegouAoStdinDaFilha: logOf(childPid()).includes(text),
        avisoComAbrir: temAbrir,
        pontoDeNaoLida: naoLida,
        abasDaFilhaDepoisDoRecado: abasDaFilha,
        antes,
        depois,
        abrirLevaAAba: abriu,
        pontoDeNaoLidaComAAbaAberta: naoLidaComAba,
      },
    }
  })
  record(7, seven.ok, seven.detail)
  link('7 recado da mãe')

  // ---- (6) recado do usuário pelo QuickComposer ----
  const six = await attempt('6 recado do usuario', async () => {
    await minimizeChildTab()
    await toastsGone()
    // Trabalhando, o recado "quando terminar" fica na fila até ela parar.
    await setChildStatus('busy')
    const id = childId()
    const pid = childPid()
    const text = `vcl recado do usuario ${RUN_ID}`
    const quick = page.getByTestId('quick-composer')
    try {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Control+Shift+Enter')
      await quick.waitFor({ state: 'visible', timeout: 8000 })
      if ((await page.getByTestId('target-picker').count()) === 0) {
        await quick.getByTestId('quick-target').click()
      }
      const options = page.getByTestId('target-option')
      await waitFor('lista de alvos', async () => (await options.count()) > 0, 8000)
      const alvos = await options.evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-alias')),
      )
      // O alvo leva o apelido da filha (com sufixo, se outro alvo tiver o mesmo).
      const listada = alvos.some((a) => a?.startsWith(alias))
      await page.getByLabel('Buscar sessão de destino').fill(alias)
      await page.waitForTimeout(400)
      await page.keyboard.press('Enter')
      const input = quick.getByTestId('quick-input')
      await input.waitFor({ state: 'visible', timeout: 8000 })
      await quick.getByTestId('when-on-idle').click()
      await input.fill(text)
      const abasAntes = await childTab.count()
      const todasAntes = await page.locator(TAB).count()
      const espiado = await tapNextInvoke(app, SEND_PROMPT, TABS_AT_SEND)
      await input.press('Enter')
      const abriu = await waitFor(
        'aba aberta pelo envio',
        async () => (await childTab.count()) === 1,
        10_000,
      )
      const fechou = await waitFor(
        'QuickComposer fechado',
        async () => (await quick.count()) === 0,
        8000,
      )
      const envio = await tappedInvoke(app, SEND_PROMPT)
      const alvo = (envio?.args[0] as { sessionId?: string } | undefined)?.sessionId ?? null
      const abas: SendTabsRead = {
        antes: todasAntes,
        noEnvio: typeof envio?.probed === 'number' ? envio.probed : null,
        depois: await page.locator(TAB).count(),
        daFilha: await childTab.count(),
      }
      const recusa = fechou
        ? null
        : await quick
            .getByTestId('quick-notice')
            .innerText()
            .catch(() => null)
      await shot('6-aba-aberta-antes-do-recado')
      await setChildStatus('idle')
      const chegou = await waitFor(
        'recado no stdin da filha',
        async () => logOf(pid).includes(text),
        20_000,
      )
      return {
        ok:
          listada &&
          abasAntes === 0 &&
          alvo === id &&
          tabOpenAtSend(abas) &&
          abriu &&
          fechou &&
          chegou,
        detail: {
          filhaEntreOsAlvos: listada,
          abasDaFilhaAntes: abasAntes,
          envioEspiado: espiado,
          envioParaAFilha: alvo === id,
          abas,
          abaAbriu: abriu,
          quickComposerFechou: fechou,
          recusa,
          recadoNoStdinDepoisDeOciosa: chegou,
        },
      }
    } finally {
      for (let i = 0; i < 3 && (await quick.count()) > 0; i++) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }
    }
  })
  record(6, six.ok, six.detail)
  link('6 recado do usuário')

  // ---- (8) card com o processo vivo e a aba aberta ----
  const verbsAlive = await attempt('8 card com a filha viva', async () => {
    await openChildTab()
    const read = await cardVerbs()
    return {
      ok:
        read.menu.includes('Minimizar') &&
        read.menu.includes('Encerrar filha') &&
        read.menu.includes('Desvincular') &&
        !read.menu.includes('Arquivar card') &&
        read.xDeArquivar === 0,
      detail: read,
    }
  })

  // ---- (3) X + Desfazer ----
  const three = await attempt('3 desfazer', async () => {
    await openChildTab()
    await setChildStatus('busy')
    const id = childId()
    const pid = childPid()
    confirmAnswer = true
    const asked = confirms.length
    const motherLog = logOf(motherPid).length
    await childTab.locator('.dv-default-tab-action').click()
    const ended = toasts.filter({ hasText: 'Filha encerrada' })
    await waitFor('aviso de filha encerrada', async () => (await ended.count()) === 1, 8000)
    await waitFor(
      'marca gravada no clique',
      async () => handoffRow(H).ended_by_user_at !== null,
      5000,
    )
    const marcaNoClique = handoffRow(H).ended_by_user_at
    await ended.getByRole('button', { name: 'Desfazer', exact: true }).click({ timeout: 4000 })
    await waitFor('marca desfeita', async () => handoffRow(H).ended_by_user_at === null, 5000)
    await page.waitForTimeout(KILL_AFTER_MS)
    const row = handoffRow(H)
    const read: UndoRead = {
      pediuConfirmacao: confirms.length - asked,
      marcaNoClique,
      processoVivo: await isLive(id),
      pidVivo: pidAlive(pid),
      ended_by_user_at: row.ended_by_user_at,
      handoff: row.status,
      abaDeVolta: await childTab.count(),
      avisoAMae: endedNoticeSince(logOf(motherPid), motherLog)?.slice(0, 140) ?? null,
    }
    return { ok: undoOk(read), detail: { ...read } }
  })
  record(3, three.ok, three.detail)
  link('3 desfazer')

  // ---- (2) X na filha trabalhando: recusa segura, confirmação encerra ----
  const two = await attempt('2 encerrar', async () => {
    await openChildTab()
    await setChildStatus('busy')
    const id = childId()
    const pid = childPid()
    const asked = confirms.length
    // O aviso deste encerramento é o que entra no log da mãe daqui em diante.
    const motherLog = logOf(motherPid).length
    try {
      confirmAnswer = false
      await childTab.locator('.dv-default-tab-action').click()
      await page.waitForTimeout(1500)
      const recusada = {
        perguntou: confirms.length - asked,
        abas: await childTab.count(),
        ended_by_user_at: handoffRow(H).ended_by_user_at,
      }
      confirmAnswer = true
      await childTab.locator('.dv-default-tab-action').click()
      await waitFor('aba fechada', async () => (await childTab.count()) === 0, 8000)
      const morreu = await waitFor(
        'processo da filha morto',
        async () => !(await isLive(id)) && !pidAlive(pid),
        KILL_AFTER_MS + 10_000,
      )
      await waitFor(
        'handoff interrupted',
        async () => handoffRow(H).status === 'interrupted',
        10_000,
      )
      const row = handoffRow(H)
      const avisada = await waitFor(
        'aviso no stdin da mãe',
        async () => endedNoticeSince(logOf(motherPid), motherLog) !== null,
        30_000,
      )
      const wakes = db<{ reason: string; outcome: string }>(
        'SELECT reason, outcome FROM handoff_wake_deliveries WHERE handoff_id = ? ORDER BY created_at',
        H,
      )
      await shot('2-filha-encerrada')
      return {
        ok:
          recusada.perguntou === 1 &&
          recusada.abas === 1 &&
          recusada.ended_by_user_at === null &&
          confirms.length - asked === 2 &&
          morreu &&
          row.status === 'interrupted' &&
          row.ended_by_user_at !== null &&
          ENDED_BY_USER.test(row.error ?? '') &&
          avisada,
        detail: {
          confirmacao: confirms[asked]?.slice(0, 60) ?? null,
          recusada,
          perguntasNoTotal: confirms.length - asked,
          processoMorto: morreu,
          handoff: row.status,
          ended_by_user_at: row.ended_by_user_at,
          motivoGravado: row.error?.slice(0, 60) ?? null,
          avisoNoStdinDaMae: endedNoticeSince(logOf(motherPid), motherLog)?.slice(0, 140) ?? null,
          ledgerDeWakes: wakes,
        },
      }
    } finally {
      confirmAnswer = true
    }
  })
  record(2, two.ok, two.detail)
  link('2 encerrar')
  dropDeadSessionFiles()

  // ---- (8) card com o processo morto ----
  const verbsDead = await attempt('8 card com o processo morto', async () => {
    const read = await cardVerbs()
    return {
      ok:
        read.menu.includes('Arquivar card') &&
        read.menu.includes('Desvincular') &&
        !read.menu.includes('Minimizar') &&
        !read.menu.includes('Encerrar filha') &&
        read.xDeArquivar === 1,
      detail: read,
    }
  })
  record(8, verbsAlive.ok && verbsDead.ok, {
    processoVivo: verbsAlive.detail,
    processoMorto: verbsDead.detail,
  })

  // ---- (5) Retomar a filha encerrada, pelo card ----
  const resumedEnded = await attempt('5 retomar a encerrada', async () => {
    const card = await crewCard()
    const pids = knownPids()
    await card.locator('button[title^="Re-spawnar"]').first().click({ timeout: 10_000 })
    await waitFor('handoff running de novo', async () => handoffRow(H).status === 'running', 15_000)
    const back = await relaunched(pids)
    const row = handoffRow(H)
    return {
      ok: back.ok && row.status === 'running' && row.ended_by_user_at === null,
      detail: {
        caminho: 'Retomar do card',
        ...back.detail,
        handoff: row.status,
        ended_by_user_at: row.ended_by_user_at,
      },
    }
  })
  link('5 retomar encerrada')

  // ---- (5) Retomar uma filha done que o usuário encerrou ----
  const resumedDone = await attempt('5 retomar a done', async () => {
    // A aba abre com o handoff ainda running: é pelo X dela que a done é encerrada.
    await openChildTab()
    const asChild = await mcpAs(userData, fake.root, childId())
    const reported = await asChild
      .call('handoff_report', { handoffId: H, summary: 'vcl entregue' })
      .catch((e: Error) => ({ error: e.message }))
    if (handoffRow(H).status !== 'done') {
      throw new Error(`handoff_report não levou a done: ${JSON.stringify(reported).slice(0, 200)}`)
    }
    link('5 entregar')
    // Parada, o X encerra sem perguntar.
    await setChildStatus('idle')
    const id = childId()
    const pid = childPid()
    const asked = confirms.length
    await childTab.locator('.dv-default-tab-action').click()
    const morreu = await waitFor(
      'filha done encerrada',
      async () => !(await isLive(id)) && !pidAlive(pid),
      KILL_AFTER_MS + 10_000,
    )
    const ended = handoffRow(H)
    link('5 encerrar done')
    dropDeadSessionFiles()
    const pids = knownPids()
    // Sem processo e sem dormir, a done não tem card: o usuário a retoma pela
    // lista de sessões, que cai no mesmo resumeHandoffChild deste IPC.
    const recusa = await page
      .evaluate((handoffId) => (window as any).api.handoffs.resume(handoffId), H)
      .then(
        () => null,
        (e: Error) => e.message.split('\n')[0],
      )
    const back = recusa === null ? await relaunched(pids) : { ok: false, detail: {} }
    const row = handoffRow(H)
    return {
      ok:
        confirms.length === asked &&
        morreu &&
        ended.status === 'done' &&
        ended.ended_by_user_at !== null &&
        back.ok &&
        row.status === 'done' &&
        row.ended_by_user_at === null,
      detail: {
        caminho: 'IPC handoffs.resume',
        encerrada: {
          pediuConfirmacao: confirms.length - asked,
          processoMorto: morreu,
          handoff: ended.status,
          ended_by_user_at: ended.ended_by_user_at,
        },
        recusa,
        ...back.detail,
        handoff: row.status,
        ended_by_user_at: row.ended_by_user_at,
      },
    }
  })
  record(5, resumedEnded.ok && resumedDone.ok, {
    encerrada: resumedEnded.detail,
    done: resumedDone.detail,
  })
  link('5 retomar done')

  // ---- (9) a done ociosa hiberna; o card a acorda ----
  let appHibernates = false
  const nine = await attempt('9 hibernar e acordar', async () => {
    const slept = await sleepByApp()
    appHibernates = slept.asleep
    link('9 hibernar')
    if (!slept.asleep) return { ok: false, detail: slept.detail }
    dropDeadSessionFiles()
    const card = await crewCard()
    const dormindo = await waitFor(
      'card Dormindo',
      async () => /dormindo/i.test(await card.innerText()),
      10_000,
    )
    const texto = (await card.innerText()).replace(/\s+/g, ' ').slice(0, 100)
    await shot('9-card-dormindo')
    const pids = knownPids()
    await card.getByLabel('Acordar').first().click({ timeout: 10_000 })
    const back = await relaunched(pids)
    const aba = await waitFor(
      'aba da filha acordada',
      async () => (await childTab.count()) === 1,
      10_000,
    )
    const row = handoffRow(H)
    return {
      ok: dormindo && back.ok && aba && row.status === 'done' && hibernatedRows() === 0,
      detail: {
        ...slept.detail,
        card: texto,
        ...back.detail,
        abaAbriu: aba,
        handoff: row.status,
        linhasAindaHibernadas: hibernatedRows(),
      },
    }
  })
  record(9, nine.ok, nine.detail)
  link('9 acordar')

  // ---- (11) dorme de novo e a mãe chama ----
  const eleven = await attempt('11 a mae acorda', async () => {
    // Sem a hibernação de (9), esperar outra janela inteira não traria nada novo.
    if (!appHibernates) return { ok: false, detail: { motivo: 'a filha não hibernou em (9)' } }
    const slept = await sleepByApp()
    link('11 hibernar')
    if (!slept.asleep) return { ok: false, detail: slept.detail }
    dropDeadSessionFiles()
    const pids = knownPids()
    const called = (await asM
      .call('handoff_message', { handoffId: H, text: 'vcl: e o caso X?' })
      .catch((e: Error) => ({ error: e.message }))) as {
      woke?: boolean
      delivered?: boolean
      queued?: boolean
      note?: string
      error?: string
    }
    const back = called.woke === true ? await relaunched(pids) : { ok: false, detail: {} }
    // Folga para uma aba que abrisse sozinha aparecer.
    await page.waitForTimeout(1000)
    const abas = await childTab.count()
    const row = handoffRow(H)
    return {
      ok:
        called.woke === true &&
        (called.delivered === true || called.queued === true) &&
        /session_handoff/.test(called.note ?? '') &&
        back.ok &&
        row.status === 'done' &&
        hibernatedRows() === 0 &&
        abas === 0,
      detail: {
        ...slept.detail,
        retorno: {
          woke: called.woke,
          delivered: called.delivered,
          queued: called.queued,
          error: called.error,
        },
        pedeNovoHandoffParaTrabalhoNovo: /session_handoff/.test(called.note ?? ''),
        ...back.detail,
        abasDaFilha: abas,
        handoff: row.status,
        linhasAindaHibernadas: hibernatedRows(),
      },
    }
  })
  record(11, eleven.ok, eleven.detail)
  link('11 mãe acorda')

  // ---- (10) o vínculo durante o cenário todo ----
  clearInterval(linkPoll)
  const soltou = links.filter((l) => l.filha === null || l.conversa !== cc0 || l.mae !== M)
  const trocas = links.filter((l, i) => i > 0 && l.filha !== links[i - 1].filha).map((l) => l.passo)
  const vigia = linkWatch.polled()
  record(
    10,
    soltou.length === 0 &&
      vigia.read > 0 &&
      vigia.failed === 0 &&
      trocas.every((passo) => RELAUNCHES.has(passo)),
    {
      passos: links.map((l) => `${l.passo}=${l.filha?.slice(0, 8) ?? 'NULO'}`),
      soltouEm: soltou.map((l) => l.passo),
      idMudouEm: trocas,
      idSoPodeMudarEm: [...RELAUNCHES],
      leiturasDoVigia: vigia,
    },
  )
} catch (e) {
  notes.push(`EXC: ${(e as Error).stack}`)
  await shot('exception')
} finally {
  await finish()
}
