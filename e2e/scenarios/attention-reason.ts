import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Page } from 'playwright'
import { REPO_ROOT, launchApp } from '../driver/launch'
import { createFakeHome, type FakeHome } from '../driver/fake-home'
import { waitReady } from '../driver/nav'
import { queryDb } from '../driver/inspect'

// P2 — a fila de atenção diz POR QUE a sessão espera e deixa responder sem
// abrir o terminal, numa sessão SEM pane (filha do Crew Dock, só listada).
//
// O stub do `claude` imprime os BYTES REAIS de um prompt de permissão do claude
// 2.1.286 (shared/tui/__fixtures__, capturado via node-pty) e grava o status
// 'waiting' em sessions/<pid>.json. O main parseia a tela num xterm headless; o
// cenário confere motivo + opções no popover, clica Aprovar, e lê no log do stub
// a tecla que chegou ao stdin. Depois o stub volta a 'busy' e a sessão sai da fila.
// HOME é um fake-home: o ~/.claude real não é lido nem tocado; nenhuma API é chamada.
//
// Rodar (ABI Electron): ATTN_SCRATCH=<dir> npx tsx e2e/scenarios/attention-reason.ts

export const PERMISSION_FIXTURE = join(
  REPO_ROOT,
  'shared/tui/__fixtures__/claude-2.1.286-permission-bash.ansi',
)

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Fases do stub: (1) status busy e drena o prompt inicial que o dispatch injeta
// (bracketed paste) até 2 s de silêncio; (2) desenha a captura real e vira
// waiting; (3) cada byte do stdin vira "key:<hex>" no log; dígito = resposta ao
// menu → volta a busy e imprime uma linha nova (a tela sai do menu). SIGUSR1
// redesenha a tela com o 2º fixture (mesmo prompt, OUTRO comando) — é o "menu
// mudou entre abrir o popover e clicar" que o fingerprint tem que recusar.
export function attentionClaudeStub(
  sessionsDir: string,
  logDir: string,
  fixture: string,
  changedFixture = fixture,
): string {
  return `#!/usr/bin/env bash
export LC_ALL=C
SESSIONS_DIR=${shq(sessionsDir)}
LOG=${shq(logDir)}/attention-claude-$$.log
FIXTURE=${shq(fixture)}
FIXTURE2=${shq(changedFixture)}
session_id=''; name=''
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--resume) session_id="$2"; shift 2 ;;
    -n|--name) name="$2"; shift 2 ;;
    *) shift ;;
  esac
done
write_status() {
  local now; now=$(date +%s%3N)
  printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"%s","name":"%s","startedAt":%s,"updatedAt":%s}' \\
    "$$" "$session_id" "$PWD" "$1" "$name" "$now" "$now" > "$SESSIONS_DIR/$$.json"
  printf 'status:%s\\n' "$1" >> "$LOG"
}
write_status busy
stty raw -echo
printf 'booting\\r\\n'
while IFS= read -r -s -n1 -d '' -t 2 _; do :; done
cat "$FIXTURE"
write_status waiting
trap 'printf "\\033[2J\\033[3J\\033[H"; cat "$FIXTURE2"; printf "redraw\\n" >> "$LOG"' USR1
# read interrompido pelo trap devolve >128: segue lendo; EOF (PTY fechou) sai.
while true; do
  if IFS= read -r -s -n1 -d '' ch; then
    printf 'key:%02x\\n' "'$ch" >> "$LOG"
    case "$ch" in
      [1-9]) write_status busy; printf '\\r\\n* respondido %s\\r\\n' "$ch" ;;
    esac
  elif [ $? -le 128 ]; then
    exit 0
  fi
done
`
}

// Mesmo tamanho do original: a captura posiciona o cursor por coluna.
export const ORIGINAL_COMMAND = 'permissao-fixture.txt'
export const CHANGED_COMMAND = 'comando-trocado-x.txt'

export function installStub(fake: FakeHome): string {
  const path = join(fake.root, 'bin', 'attention-claude.sh')
  const changed = join(fake.root, 'bin', 'permission-changed.ansi')
  writeFileSync(
    changed,
    readFileSync(PERMISSION_FIXTURE, 'utf8').replaceAll(ORIGINAL_COMMAND, CHANGED_COMMAND),
  )
  writeFileSync(
    path,
    attentionClaudeStub(fake.sessionsDir, fake.logDir, PERMISSION_FIXTURE, changed),
  )
  chmodSync(path, 0o755)
  return path
}

export function readStubLog(fake: FakeHome): string {
  return readdirSync(fake.logDir)
    .filter((f) => f.startsWith('attention-claude-'))
    .map((f) => readFileSync(join(fake.logDir, f), 'utf8'))
    .join('')
}

interface LiveRow {
  id: string
  status: string
  attentionReason?: string
}

async function liveSessions(page: Page): Promise<LiveRow[]> {
  return page.evaluate(async () => {
    const list = await (
      window as unknown as { api: { sessions: { listLiveGlobal(): Promise<LiveRow[]> } } }
    ).api.sessions.listLiveGlobal()
    return list.map((s) => ({ id: s.id, status: s.status, attentionReason: s.attentionReason }))
  })
}

async function run(scratch: string): Promise<void> {
  const require = createRequire(import.meta.url)
  const { default: initSqlJs } = await import('sql.js')
  const fake = createFakeHome({ parentDir: scratch })
  const stub = installStub(fake)

  const first = await launchApp()
  await first.app.close()
  const userData = first.userDataCopy
  const repos = (await queryDb(
    userData,
    'SELECT id, label, path FROM repos ORDER BY label',
  )) as Array<{
    id: string
    label: string
    path: string
  }>
  const target = repos.find((r) => r.path && existsSync(r.path))
  if (!target) throw new Error('nenhum repo da cópia existe no disco')

  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
  const db = new SQL.Database(readFileSync(join(userData, 'app.db')))
  const now = Date.now()
  db.run(
    "UPDATE handoffs SET status = 'done' WHERE status IN ('pending','approved','running','needs_input')",
  )
  db.run("INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('claude_command', ?)", [stub])
  db.run('UPDATE workspace_state SET open_panes = NULL, dock_layout = NULL WHERE id = 1')
  db.run(
    `INSERT INTO handoffs
       (id, mother_session_id, target_repo_id, child_session_id, feature_id, task,
        context_json, composed_prompt, status, mode, summary, error, created_at, updated_at)
     VALUES ('attn-perm', NULL, ?, NULL, NULL, ?, NULL, ?, 'pending', 'interactive', NULL, NULL, ?, ?)`,
    [
      target.id,
      'Criar o arquivo de fixture',
      '## Tarefa\nrode touch permissao-fixture.txt',
      now,
      now,
    ],
  )
  writeFileSync(join(userData, 'app.db'), Buffer.from(db.export()))
  db.close()

  const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
  const consoleErrors: string[] = []
  const mainErr: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message))
  app.process().stderr?.on('data', (d) => mainErr.push(String(d).trimEnd()))

  const shot = (name: string) => join(scratch, `attention-${name}.png`)
  async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 90_000) {
    const started = Date.now()
    while (!(await fn())) {
      if (Date.now() - started > timeoutMs) {
        await page.screenshot({ path: shot('timeout') }).catch(() => {})
        console.log('[attn] stub log:\n' + readStubLog(fake))
        console.log('[attn] live:', JSON.stringify(await liveSessions(page).catch(() => [])))
        throw new Error(`timeout esperando: ${label}`)
      }
      await page.waitForTimeout(500)
    }
  }

  try {
    await waitReady(page)
    const skip = page.locator('.spl-skip')
    if (await skip.count()) await skip.click().catch(() => {})

    await waitFor('filha waiting com motivo permission', async () =>
      (await liveSessions(page)).some(
        (s) => s.status === 'waiting' && s.attentionReason === 'permission',
      ),
    )
    const child = (await liveSessions(page)).find((s) => s.attentionReason === 'permission')!
    const terminalPanes = await page.locator('.dv-tab').count()
    console.log(
      '[attn] sessão',
      child.id,
      'status',
      child.status,
      '· abas no dockview:',
      terminalPanes,
    )
    if (terminalPanes !== 0) throw new Error('o cenário exige a sessão SEM pane aberta')

    // Lista da fila pela TitleBar → item → popover com motivo e opções reais.
    await page.getByTestId('titlebar-attention-list').click()
    await page.getByTestId('attention-queue-item').first().click()
    const popover = page.getByTestId('attention-popover').first()
    await popover.getByText('Quer continuar?').waitFor({ timeout: 10_000 })
    const text = await popover.innerText()
    for (const want of ['Pede permissão', 'Aprovar', 'Sempre', 'Negar', 'Abrir']) {
      if (!text.includes(want)) throw new Error(`popover sem "${want}":\n${text}`)
    }
    console.log('[attn] popover:\n' + text)
    await popover.screenshot({ path: shot('popover') })
    await page.screenshot({ path: shot('window') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Esc no popover FIXADO (Alt+A): fecha o popover e não vira \x1b no stdin.
    const keysBefore = readStubLog(fake).split('\n').filter((l) => l.startsWith('key:'))
    await page.keyboard.press('Alt+a')
    const pinned = page.locator('[data-testid="attention-popover"][role="dialog"]')
    await pinned.getByText('Quer continuar?').waitFor({ timeout: 10_000 })
    await pinned.screenshot({ path: shot('popover-pinned') })
    await page.screenshot({ path: shot('hud-pinned') })
    await page.keyboard.press('Escape')
    await pinned.waitFor({ state: 'hidden', timeout: 5_000 })
    await page.waitForTimeout(1500)
    const keysAfterEsc = readStubLog(fake).split('\n').filter((l) => l.startsWith('key:'))
    console.log('[attn] teclas no stdin antes/depois do Esc:', keysBefore.length, keysAfterEsc.length)
    if (keysAfterEsc.includes('key:1b')) throw new Error('Esc do popover fixado chegou ao PTY')
    if (keysAfterEsc.length !== keysBefore.length)
      throw new Error(`Esc gerou tecla no stdin: ${keysAfterEsc.slice(keysBefore.length).join(' ')}`)
    // O Alt+A abriu o peek da filha por baixo do popover: fecha até não sobrar overlay.
    for (let i = 0; i < 3 && (await page.getByRole('dialog').count()) > 0; i++) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
    await page.screenshot({ path: shot('after-esc') })

    // Fingerprint: abre o popover no comando original, a TUI troca o comando,
    // o clique em Aprovar tem que ser recusado sem digitar nada.
    const queueItem = page.getByTestId('attention-queue-item').first()
    if (!(await queueItem.isVisible().catch(() => false))) {
      await page.getByTestId('titlebar-attention-list').click()
    }
    await queueItem.waitFor({ timeout: 10_000 })
    await queueItem.click()
    const pop2 = page.locator('[data-testid="attention-popover"]:visible').first()
    // O item lembra que estava expandido desde o 1º popover: o clique pode ter colapsado.
    await page.waitForTimeout(800)
    if ((await pop2.count()) === 0) await queueItem.click()
    await pop2.getByText('Quer continuar?').waitFor({ timeout: 10_000 }).catch(async (e) => {
      const all = await page.getByTestId('attention-popover').allInnerTexts()
      console.log('[attn] popovers na tela:', JSON.stringify(all))
      console.log('[attn] stub log:\n' + readStubLog(fake))
      await page.screenshot({ path: shot('reopen-fail') })
      throw e
    })
    const stubPid = readdirSync(fake.sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => Number(f.replace('.json', '')))[0]
    process.kill(stubPid, 'SIGUSR1')
    await waitFor('stub redesenhou com outro comando', async () =>
      readStubLog(fake).includes('redraw'),
    )
    await page.waitForTimeout(1200)
    const keysBeforeStale = readStubLog(fake).split('\n').filter((l) => l.startsWith('key:'))
    await pop2.getByTestId('attention-action-approve').click()
    await pop2.getByText('O menu mudou').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(800)
    const keysAfterStale = readStubLog(fake).split('\n').filter((l) => l.startsWith('key:'))
    const pop2Text = await pop2.innerText()
    console.log('[attn] popover após recusa:\n' + pop2Text)
    await pop2.screenshot({ path: shot('popover-menu-changed') })
    if (keysAfterStale.length !== keysBeforeStale.length)
      throw new Error(`clique no menu velho digitou: ${keysAfterStale.slice(keysBeforeStale.length).join(' ')}`)
    console.log(
      '[attn] fingerprint recusou o menu velho; comando novo no popover:',
      pop2Text.includes(CHANGED_COMMAND),
    )

    const popover2 = pop2
    await popover2.getByTestId('attention-action-approve').click()
    await waitFor(
      'tecla 1 no stdin do stub',
      async () => readStubLog(fake).includes('key:31'),
      15_000,
    )
    const log = readStubLog(fake)
    const keys = log.split('\n').filter((l) => l.startsWith('key:'))
    console.log('[attn] teclas recebidas pelo stub:', keys.join(' '))
    if (keys.at(-1) !== 'key:31') throw new Error(`última tecla não foi "1": ${keys.join(' ')}`)

    await waitFor(
      'sessão sai da fila (busy, sem motivo)',
      async () => {
        const s = (await liveSessions(page)).find((x) => x.id === child.id)
        const listed = await page.getByTestId('attention-queue-item').count()
        return s?.status === 'working' && s.attentionReason == null && listed === 0
      },
      30_000,
    )
    console.log('[attn] sessão saiu da fila após voltar a busy')

    const counters = await page.evaluate(() =>
      (
        window as unknown as { api: { sessions: { attentionDebug(): Promise<unknown> } } }
      ).api.sessions.attentionDebug(),
    )
    console.log('[attn] contadores:', JSON.stringify(counters))
    console.log(
      '[attn] console errors:',
      consoleErrors.length ? consoleErrors.join('\n') : 'nenhum',
    )
    console.log('[attn] main stderr:', mainErr.length ? mainErr.join('\n') : 'nenhum')
    console.log('[attn] PASS')
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
}

if (process.env.ATTN_SCRATCH) await run(process.env.ATTN_SCRATCH)
