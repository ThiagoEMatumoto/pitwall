import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeHome, type FakeSessionEntry } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { copyRealUserData, launchApp, writeCopyPrefs } from '../driver/launch'
import { goToArea, waitReady } from '../driver/nav'

// Remount do terminal DURANTE o streaming, com o pty:data coalescido no main
// (pty-data-coalescer): a tela do terminal recém-montado tem de ser exatamente a
// cauda do backlog, sem token repetido (bytes do backlog que ainda estavam na
// janela e chegaram depois do replay) nem faltando.
// Sobre a CÓPIA do perfil real, HOME fake e um stub do `claude` que, enquanto o
// arquivo `stream` existir, escreve um token numerado (s000001, s000002, …) a
// cada ~4 ms, um write por token. Com a janela de 8 ms quase sempre há token
// pendente no instante em que o terminal novo pede o backlog.
// Montagens conferidas:
//   - a modal do mapa abrindo sobre a sessão (CICLOS vezes): Terminal novo;
//   - "Abrir na aba" saindo da modal: a aba remonta o xterm dela.
// Em cada uma o stream para logo depois da montagem, para o ponto do replay
// ainda estar na tela. Montagem em que o stream já rolou esse ponto para fora não
// conta (inconclusiva), e o cenário falha se sobrarem poucas conclusivas.
// A tela é lida de .xterm-rows, que só existe no renderer DOM: o app sobe com a
// GPU desligada.
// Rodar (depois de npm run rebuild:native && npm run build):
//   npx tsx e2e/scenarios/pty-remount-streaming.ts

const CYCLES = 5
const MIN_CONCLUSIVE = 3
const TOKEN = /s(\d{6})/g

const fake = createFakeHome({ parentDir: tmpdir() })
const streamFlag = join(fake.root, 'stream')

const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[remount] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// O session file é o mesmo que o stub do perf-chat-typing grava. Sem o `stream`
// o stub só espera o stdin; com ele, cada volta do laço é um write de um token.
function streamingStub(sessionsDir: string): string {
  return `#!/usr/bin/env bash
SESSIONS_DIR=${shq(sessionsDir)}
STREAM=${shq(streamFlag)}
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
printf 'stub pty-remount %s\\n' "$name"
n=0
while true; do
  if [ -e "$STREAM" ]; then pause=0.004; else pause=0.2; fi
  if IFS= read -t "$pause" -r line; then
    :
  elif [ $? -le 128 ]; then
    exit 0
  elif [ -e "$STREAM" ]; then
    n=$((n+1))
    printf 's%06d ' "$n"
  fi
done
`
}
const stub = join(fake.root, 'bin', 'remount-claude.sh')
writeFileSync(stub, streamingStub(fake.sessionsDir))
chmodSync(stub, 0o755)

const userData = copyRealUserData()
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
writeCopyPrefs(userData, {
  claude_command: stub,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'gpu.disabled': JSON.stringify(true),
})

const { app, page } = await launchApp({
  userDataDir: userData,
  env: { ...fake.env, CM_DISABLE_GPU: '1' },
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return true
    if (Date.now() - started > timeoutMs) {
      console.log(`[remount] timeout esperando: ${label}`)
      return false
    }
    await page.waitForTimeout(100)
  }
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const live = () =>
  page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<
    Array<{ id: string; ccSessionId: string }>
  >
const card = (id: string) => page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
const lift = page.locator('[role="dialog"][data-peek-lift]')
const liftTerminal = page.locator('[role="dialog"][data-peek-lift][data-peek-mode="terminal"]')
const mapVisible = () => page.getByTestId('session-map').isVisible()

const tokensOf = (text: string): number[] => [...text.matchAll(TOKEN)].map((m) => Number(m[1]))

const startStream = () => writeFileSync(streamFlag, '')
const stopStream = () => rmSync(streamFlag, { force: true })

interface CounterWindow {
  __ptyRemount?: { events: number; chars: number }
}

let fatal: unknown = null
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  const gpu = await page.evaluate(() => window.api.gpu.status())
  if (!gpu.hwAccelDisabled) {
    throw new Error('o app subiu com a GPU ligada: sem renderer DOM não há .xterm-rows para ler')
  }

  // ---------- a sessão, pela UI (Ctrl+N): com aba ----------
  await goToArea(page, 'projects')
  const before = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(repo.label)
  await search.press('Enter')
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()
  let file: FakeSessionEntry | undefined
  let id = ''
  const opened = await waitFor('session file e sessão viva', async () => {
    file = files().find((f) => !before.has(f.data.pid))
    if (!file) return false
    id = (await live()).find((s) => s.ccSessionId === file!.data.sessionId)?.id ?? ''
    return id !== ''
  })
  if (!opened) throw new Error('a sessão do stub não abriu')

  const backlogOf = () => page.evaluate((sid) => window.api.sessions.getBacklog(sid), id)

  // O xterm DESTA sessão, na modal do mapa ou fora dela (a aba). `terms` diferente
  // de 1 ou `text` nulo é falha de infraestrutura do cenário, não do replay.
  const screenOf = (where: 'modal' | 'aba') =>
    page.evaluate(
      ({ sid, inModal }) => {
        const terms = [...document.querySelectorAll('.xterm')].filter(
          (el) =>
            (el.closest('[data-peek-lift]') != null) === inModal &&
            el.closest('[data-session-id]')?.getAttribute('data-session-id') === sid,
        )
        return {
          terms: terms.length,
          text:
            terms.length === 1
              ? (terms[0].querySelector('.xterm-rows')?.textContent ?? null)
              : null,
        }
      },
      { sid: id, inModal: where === 'modal' },
    )

  // Quantos pty:data desta sessão o renderer recebe, e com quantos caracteres.
  await page.evaluate((sid) => {
    const counter = { events: 0, chars: 0 }
    ;(window as unknown as CounterWindow).__ptyRemount = counter
    window.api.sessions.onData((e) => {
      if (e.sessionId !== sid) return
      counter.events += 1
      counter.chars += e.data.length
    })
  }, id)

  async function settledBacklog(): Promise<string> {
    let previous = await backlogOf()
    for (;;) {
      await page.waitForTimeout(300)
      const current = await backlogOf()
      if (current === previous) return current
      previous = current
    }
  }

  // Uma montagem sob streaming: liga o stream, dispara o remount, espera o xterm
  // novo, para o stream e compara a tela com a cauda do backlog.
  async function remountUnderStream(
    label: string,
    where: 'modal' | 'aba',
    trigger: () => Promise<boolean>,
  ): Promise<boolean> {
    startStream()
    try {
      const streaming = await waitFor(`${label}: stream correndo`, async () => {
        const a = tokensOf(await backlogOf()).length
        await page.waitForTimeout(150)
        return tokensOf(await backlogOf()).length > a + 10
      })
      if (!streaming) throw new Error(`${label}: o stub não está emitindo tokens`)
      const atTrigger = tokensOf(await backlogOf()).length
      if (!(await trigger())) throw new Error(`${label}: o remount não aconteceu`)
      const mounted = await waitFor(
        `${label}: xterm montado`,
        async () => (await screenOf(where)).text != null,
        10_000,
      )
      if (!mounted) {
        const seen = await screenOf(where)
        throw new Error(`${label}: sem .xterm-rows para ler (${seen.terms} xterm da sessão)`)
      }
      await page.waitForTimeout(200)
      stopStream()

      const backlogTokens = tokensOf(await settledBacklog())
      const last = backlogTokens.at(-1)
      // O render do xterm é por frame: espera o último token do backlog aparecer.
      await waitFor(
        `${label}: último token na tela`,
        async () => tokensOf((await screenOf(where)).text ?? '').at(-1) === last,
        5000,
      )
      const screenTokens = tokensOf((await screenOf(where)).text ?? '')
      const expected = backlogTokens.slice(-screenTokens.length)
      const diverges = screenTokens.findIndex((t, i) => t !== expected[i])
      const repeated = screenTokens.length - new Set(screenTokens).size
      const sinceTrigger = backlogTokens.length - atTrigger
      const same = screenTokens.length > 0 && diverges === -1
      check(
        same,
        same
          ? `${label}: a tela é a cauda do backlog (${screenTokens.length} tokens, s${screenTokens[0]} a s${last})`
          : `${label}: tela diferente do backlog a partir do token ${diverges} (tela s${screenTokens[diverges]}, backlog s${expected[diverges]}; ${repeated} repetidos; último da tela s${screenTokens.at(-1)}, do backlog s${last})`,
      )
      // O ponto do replay fica dentro do que saiu depois do disparo; só conta se
      // isso tudo ainda cabe na tela.
      const conclusive = sinceTrigger > 0 && sinceTrigger < screenTokens.length
      console.log(
        `[remount] ${label}: ${sinceTrigger} tokens desde o disparo, ${screenTokens.length} na tela → ${conclusive ? 'conclusiva' : 'INCONCLUSIVA'}`,
      )
      return same && conclusive
    } finally {
      stopStream()
    }
  }

  // ---------- mapa ----------
  await page.keyboard.press('Control+Shift+KeyG')
  check(await waitFor('mapa', mapVisible), 'Ctrl+Shift+G abre o mapa')
  check(
    await waitFor('cartão da sessão', async () => (await card(id).count()) === 1),
    'cartão da sessão no mapa',
  )
  if (
    await waitFor(
      'painel automático',
      async () => (await page.getByTestId('mother-dock').count()) > 0,
      3000,
    )
  ) {
    await page.keyboard.press('Control+Shift+KeyP')
    await waitFor(
      'painel escondido',
      async () => (await page.getByTestId('mother-dock').count()) === 0,
      5000,
    )
  }
  await page
    .locator('.react-flow__controls-fitview')
    .click()
    .catch(() => {})
  await page.waitForTimeout(700)

  const openModal = async (): Promise<boolean> => {
    await card(id).getByTestId('card-interact').click()
    return waitFor('modal em terminal', async () => (await liftTerminal.count()) === 1)
  }
  const closeModal = async (): Promise<void> => {
    await liftTerminal.locator('header span[id]').first().click()
    await page.keyboard.press('Escape')
    if (!(await waitFor('modal fecha', async () => (await lift.count()) === 0, 5000))) {
      throw new Error('a modal não fechou')
    }
  }

  // ---------- 1. a modal abre sobre a sessão em streaming ----------
  let conclusive = 0
  for (let i = 1; i <= CYCLES; i++) {
    if (await remountUnderStream(`modal ${i}/${CYCLES}`, 'modal', openModal)) conclusive += 1
    await closeModal()
  }
  check(
    conclusive >= MIN_CONCLUSIVE,
    `${conclusive}/${CYCLES} montagens da modal conclusivas (mínimo ${MIN_CONCLUSIVE})`,
  )

  // ---------- 2. "Abrir na aba": a aba remonta o xterm em streaming ----------
  if (!(await openModal())) throw new Error('a modal não abriu para o "Abrir na aba"')
  const tabOk = await remountUnderStream('aba', 'aba', async () => {
    await page.getByTestId('peek-open-tab').click()
    return waitFor('aba na frente', async () => !(await mapVisible()), 10_000)
  })
  check(tabOk, 'remount da aba conclusivo')

  // ---------- o coalescedor estava no caminho ----------
  const counter = await page.evaluate(
    () => (window as unknown as CounterWindow).__ptyRemount ?? { events: 0, chars: 0 },
  )
  const tokens = tokensOf(await backlogOf()).length
  check(
    counter.events > 0 && counter.events < tokens * 0.8,
    `pty:data chegou coalescido: ${counter.events} eventos para ${tokens} tokens (${(counter.chars / Math.max(1, counter.events)).toFixed(1)} caracteres por evento)`,
  )
} catch (err) {
  fatal = err
  console.error('[remount] erro fatal:', err)
} finally {
  stopStream()
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
  fake.cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[remount] ${results.length - failed.length}/${results.length} PASS`)
if (fatal || failed.length) process.exit(1)
