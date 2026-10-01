import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { launchApp, REPO_ROOT } from '../driver/launch'
import { createFakeHome } from '../driver/fake-home'
import { waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'
import type { LiveSessionInfo } from '../../shared/types/ipc'
import type { PromptQueueSnapshot, ScreenPreview } from '../../shared/types/send-prompt'

// Enviar para qualquer sessão (P3). Duas sessões fake em projetos diferentes:
// A trabalhando, B ociosa. Ctrl+Shift+Enter abre o compositor flutuante, o
// '@<aliasB>' troca o destino e o '#src/x.ts' vira '@src/x.ts' no stdin de B.
// Depois: 'quando terminar' com B ocupada não entrega até B ficar ociosa, e com
// o menu de permissão REAL (captura do claude 2.1.286) na tela de B + status idle
// a mensagem fica na fila — o \r aprovaria a permissão.
// HOME fake + claude stub: o ~/.claude real e os repos não são tocados.

const require = createRequire(import.meta.url)
const SCRATCH = process.env.SEND_SCRATCH ?? join(tmpdir(), `send-to-${Date.now()}`)
mkdirSync(SCRATCH, { recursive: true })
const fake = createFakeHome({ parentDir: SCRATCH })
const FIXTURE = join(REPO_ROOT, 'shared/tui/__fixtures__/claude-2.1.286-permission-bash.ansi')
const TRIGGERS = join(fake.root, 'triggers')
mkdirSync(TRIGGERS, { recursive: true })

// Stub com gatilho de tela: o cenário cria triggers/<pid>.show e o stub desenha a
// captura real do menu de permissão no PTY. `exec` mantém o PID (o session file
// do fake-claude usa $$), então o gatilho é endereçado pelo pid do session file.
const wrapper = join(fake.root, 'bin', 'claude-with-menu.sh')
writeFileSync(
  wrapper,
  `#!/usr/bin/env bash
( while :; do
    if [ -f '${TRIGGERS}'/$$.show ]; then
      rm -f '${TRIGGERS}'/$$.show
      printf '\\033[2J\\033[3J\\033[H'
      cat '${FIXTURE}'
    fi
    sleep 0.2
  done ) &
exec '${fake.fakeCliPath('claude')}' "$@"
`,
)
chmodSync(wrapper, 0o755)

const failures: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[send-to] ${ok ? 'OK ' : 'FALHOU'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ---------- 1ª subida: migrations na cópia ----------
const first = await launchApp()
await first.app.close()
const userData = first.userDataCopy

const repos = (await queryDb(
  userData,
  'SELECT id, label, path, project_id FROM repos ORDER BY label',
)) as Array<{ id: string; label: string; path: string; project_id: string }>
const onDisk = repos.filter((r) => r.path && existsSync(r.path))
const repoA = onDisk[0]
const repoB = onDisk.find((r) => r.project_id !== repoA?.project_id)
if (!repoA || !repoB) throw new Error('a cópia precisa de 2 repos em projetos diferentes no disco')
console.log('[send-to] A:', repoA.label, '| B:', repoB.label)

const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('claude_command', ?)", [wrapper])
db.run("DELETE FROM app_prefs WHERE key = 'keybindings'")
db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
db.close()

// ---------- 2ª subida: app real, HOME fake ----------
const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - started > timeoutMs) {
      await page.screenshot({ path: join(SCRATCH, 'send-to-timeout.png') }).catch(() => {})
      throw new Error(`timeout esperando: ${label}`)
    }
    await page.waitForTimeout(500)
  }
}

async function dismissIntro(): Promise<void> {
  const skip = page.locator('.spl-skip')
  for (let i = 0; i < 30; i++) {
    if (await skip.count()) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await skip.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
      return
    }
    await page.waitForTimeout(500)
  }
}

const logOf = (pid: number) => {
  const f = join(fake.logDir, `claude-${pid}.log`)
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const queue = () => page.evaluate(() => window.api.sendTo.queue()) as Promise<PromptQueueSnapshot>
const input = page.getByTestId('quick-input')

async function typeAndSend(text: string, when: 'now' | 'on-idle'): Promise<string> {
  await input.fill(text)
  await page.getByTestId(`when-${when}`).click()
  await input.press('End')
  await input.press('Enter')
  await page.waitForTimeout(800)
  return (
    (await page
      .getByTestId('quick-notice')
      .innerText()
      .catch(() => '')) ?? ''
  )
}

try {
  await waitReady(page)
  await dismissIntro()

  const spawned = (await page.evaluate(
    ([a, b]) =>
      Promise.all([
        window.api.sessions.spawn({ repoId: a, name: 'alpha-lead' }),
        window.api.sessions.spawn({ repoId: b, name: 'beta-worker' }),
      ]),
    [repoA.id, repoB.id],
  )) as Array<{ id: string }>
  console.log('[send-to] PTYs:', spawned.map((s) => s.id).join(', '))

  await waitFor('2 session files', async () => fake.readSessionFiles().length >= 2)
  const files = fake.readSessionFiles()
  const fileA = files.find((f) => f.data.name === 'alpha-lead')!
  const fileB = files.find((f) => f.data.name === 'beta-worker')!
  fake.setStatus(fileB.data.pid, 'idle')

  // O spawn via IPC cru não passa pelo store: o liveSessions do renderer só relista
  // no boot ou em ações do store. O reload faz o boot ver as duas PTYs vivas.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await waitReady(page)
  await dismissIntro()

  let ptyB = ''
  await waitFor('as duas sessões vivas no renderer', async () => {
    const live = (await page.evaluate(() =>
      window.api.sessions.listLiveGlobal(),
    )) as LiveSessionInfo[]
    ptyB = live.find((s) => s.ccSessionId === fileB.data.sessionId)?.id ?? ''
    return ptyB !== '' && live.some((s) => s.ccSessionId === fileA.data.sessionId)
  })
  await page.evaluate((id) => window.api.sessions.resize(id, 80, 24), ptyB)

  // ---------- Ctrl+Shift+Enter + menu de @ ----------
  await page.keyboard.press('Control+Shift+Enter')
  await page.getByTestId('quick-composer').waitFor({ state: 'visible', timeout: 10_000 })
  await input.click()
  await input.pressSequentially('@beta')
  const menu = page.getByTestId('mention-menu')
  await menu.waitFor({ state: 'visible', timeout: 5000 })
  const options = await menu.getByTestId('mention-session').allInnerTexts()
  check(
    'menu de @ lista B',
    options.some((o) => o.includes('@beta-worker')),
    options.join(' | '),
  )
  check(
    'um seletor por vez: lista fixa some com o menu do @ aberto',
    (await page.getByTestId('target-picker').count()) === 0,
  )
  const menuBox = await menu.boundingBox()
  const whenBox = await page.getByTestId('when-now').boundingBox()
  check(
    'menu do @ não cobre "Enviar agora / Quando terminar"',
    !!menuBox && !!whenBox && menuBox.y + menuBox.height <= whenBox.y + 1,
    JSON.stringify({ menuBottom: menuBox && menuBox.y + menuBox.height, whenTop: whenBox?.y }),
  )
  await page.screenshot({ path: join(SCRATCH, 'send-to-1-mention-menu.png') })

  await input.press('Tab')
  // Espaço final tira o caret do token: senão o menu de # segue aberto e o Enter
  // escolheria o 1º arquivo fuzzy do repo real em vez de enviar.
  await input.pressSequentially('rode os testes #src/x.ts ')
  const pill = page.getByTestId('quick-target').getByTestId('session-pill')
  await waitFor(
    'pílula do destino B',
    async () => (await pill.getAttribute('data-alias')) === 'beta-worker',
    5000,
  )
  await waitFor(
    'prévia do terminal de B',
    async () =>
      (
        await page
          .getByTestId('quick-preview')
          .innerText()
          .catch(() => '')
      ).includes('beta-worker'),
    10_000,
  )
  check(
    'toggle default = Enviar agora (B ociosa, sem menu)',
    (await page.getByTestId('when-now').getAttribute('aria-checked')) === 'true',
  )
  await page.screenshot({ path: join(SCRATCH, 'send-to-2-quick-composer.png') })

  await input.press('Enter')
  await waitFor(
    'stdin de B com @src/x.ts',
    async () => logOf(fileB.data.pid).includes('stdin: rode os testes @src/x.ts'),
    10_000,
  )
  check('enviar agora chegou em B com #→@', true)
  check('A não recebeu nada', !logOf(fileA.data.pid).includes('rode os testes'))

  // ---------- quando terminar: B ocupada não recebe, ociosa recebe ----------
  fake.setStatus(fileB.data.pid, 'busy')
  await page.waitForTimeout(4000)
  const n1 = await typeAndSend('@beta-worker segunda mensagem', 'on-idle')
  check('B ocupada: vai pra fila', n1.includes('Na fila'), n1)
  await page.waitForTimeout(5000)
  check('B ocupada: nada chegou', !logOf(fileB.data.pid).includes('segunda mensagem'))
  fake.setStatus(fileB.data.pid, 'idle')
  await waitFor(
    'B ociosa recebe a da fila',
    async () => logOf(fileB.data.pid).includes('stdin: segunda mensagem'),
    15_000,
  )
  check('B ociosa: a mensagem da fila chegou', true)

  // ---------- menu de permissão real na tela + status idle: NÃO entrega ----------
  fake.setStatus(fileB.data.pid, 'busy')
  await page.waitForTimeout(4000)
  writeFileSync(join(TRIGGERS, `${fileB.data.pid}.show`), '')
  await waitFor(
    'tela de B com o menu de permissão',
    async () => {
      const p = (await page.evaluate(
        (id) => window.api.sendTo.preview(id),
        ptyB,
      )) as ScreenPreview | null
      return p?.hasMenu === true
    },
    15_000,
  )
  fake.setStatus(fileB.data.pid, 'idle')
  await page.waitForTimeout(1500)

  const nNow = await typeAndSend('@beta-worker agora com menu', 'now')
  check("'Enviar agora' com menu aberto é recusado", nNow.includes('menu aberto'), nNow)
  const n2 = await typeAndSend('@beta-worker terceira mensagem', 'on-idle')
  check('menu aberto + idle: vai pra fila', n2.includes('Na fila'), n2)
  await page.waitForTimeout(8000)
  const log = logOf(fileB.data.pid)
  check(
    'menu aberto: nada chegou em B',
    !log.includes('terceira') && !log.includes('agora com menu'),
  )
  const snap = await queue()
  const held = snap.items.find((i) => i.text === 'terceira mensagem')
  check(
    'continua na fila, segurada pelo menu',
    held != null && held.heldByMenu >= 1,
    JSON.stringify(snap.counters),
  )
  check('contador de recusas por menu subiu', snap.counters.refusedMenuOpen >= 2)
  const counters = await page.getByTestId('quick-counters').innerText().catch(() => '')
  check(
    'rodapé só com contadores > 0, em linguagem de usuário',
    /seguradas?: menu aberto na sessão/.test(counters) && !/\b0\b/.test(counters),
    counters,
  )
  await page.screenshot({ path: join(SCRATCH, 'send-to-3-held-by-menu.png') })
  if (held) await page.evaluate((id) => window.api.sendTo.cancel(id), held.id)

  console.log('[send-to] page errors:', pageErrors.length ? pageErrors.join('\n') : 'nenhum')
  check('sem erros no renderer', pageErrors.length === 0)
  console.log('[send-to] screenshots em', SCRATCH)
} finally {
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
  fake.cleanup()
}

if (failures.length > 0) {
  console.error(`[send-to] ${failures.length} falha(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('[send-to] PASS')
