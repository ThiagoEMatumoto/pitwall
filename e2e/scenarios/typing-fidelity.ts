import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { require as tsxRequire } from 'tsx/cjs/api'
import { createFakeHome, parseRawStdin, type FakeSessionEntry } from '../driver/fake-home'
import { queryDb } from '../driver/inspect'
import { copyRealUserData, launchApp, REPO_ROOT, writeCopyPrefs } from '../driver/launch'
import { goToArea, waitReady } from '../driver/nav'
import { typeOpenLoop } from '../driver/perf'
import { transcriptLoad } from '../driver/transcript-load'
import {
  compareTyped,
  loadChecks,
  loadOutputs,
  promptLines,
  submittedLines,
  type TypedComparison,
} from '../driver/typing-fidelity'
import { readXtermBuffer } from '../driver/xterm-buffer'

// Fidelidade de digitação (plano B6): "espaços a mais e letras fora de ordem" não
// tem repro, então o cenário digita rápido e confere, camada por camada, onde o
// texto deixa de ser o que foi digitado.
// Sobre a CÓPIA do perfil real, HOME fake e o stub raw do `claude` (TTY em modo
// raw, cada byte logado com horário e ecoado na hora, como a TUI real).
// Dois lotes de 300 caracteres (ASCII e pt-BR com acentos) a 5 ms por tecla, em
// laço aberto (typeOpenLoop), em duas superfícies:
//   composer  digita no composer do chat e envia pelo botão;
//   xterm     digita direto no terminal e fecha a linha com Enter.
// Cada uma roda sem carga e sob carga: a sessão em 'busy', o transcript dela
// ganhando um turno a cada 300 ms e, no xterm, o stub escrevendo uma linha no PTY
// a cada 10 caracteres ecoados (no modo terminal o chat está desmontado: o que
// concorre com o eco é a saída do próprio PTY). A rodada sob carga só passa com a
// prova de que quem estava na tela desenhou a carga: o chat mostrou mensagem nova
// antes de a digitação acabar, ou a saída do stub está na tela no meio do eco.
// Camadas, na ordem em que o texto anda:
//   textarea  o valor do composer antes do envio (só no composer);
//   ipc       os chunks de sessions:write que o main recebeu (spy no handler);
//   pty       os bytes que o stub leu do stdin;
//   tela      o eco no buffer do xterm (readXtermBuffer).
// PASS exige 100% dos caracteres na ordem em todas. A primeira camada que diverge
// diz onde olhar: textarea → o composer; ipc → o caminho de entrada do renderer;
// pty → o main; só a tela → o render do terminal.
// Fora do alcance: teclas mortas/IME (os acentos entram já compostos) e o redraw
// de linha inteira do Ink (o stub ecoa byte a byte).
// A GPU fica ligada: desligada, a janela deste harness nunca aparece.
// Saída: uma linha por camada e um resumo por superfície, mais
// .cm-drive/perf/fidelity.json. Sai com código != 0 em qualquer divergência.
// Rodar (depois de npm run rebuild:native && npm run build):
//   npx tsx e2e/scenarios/typing-fidelity.ts

// O fixture usa __dirname (injetado pelo vitest). O pacote é "type": "module", então
// um import estático o carregaria como ESM, onde __dirname não existe.
const { buildLongMotherLines } = tsxRequire(
  '../../electron/main/services/__fixtures__/long-mother-jsonl.ts',
  import.meta.url,
) as typeof import('../../electron/main/services/__fixtures__/long-mother-jsonl')

const CHARS = 300
const KEY_DELAY_MS = 5
const BASE_TURNS = 40
// Turnos a mais do gerador, gravados aos poucos nas rodadas sob carga.
const STREAM_TURNS = 200
// Sem mudança por este tempo, a camada parou de receber.
const QUIET_MS = 500
const OUT_DIR = join(REPO_ROOT, '.cm-drive', 'perf')
const OUT_FILE = join(OUT_DIR, 'fidelity.json')

// 300 caracteres exatos, sem espaço nas pontas (o composer não envia prompt só de
// espaços, e a ponta não é o que se quer medir). Sem @, # e /: abrem menus do composer.
// Sem "[[": é como a saída de carga do stub se separa do eco na tela.
function batchOf(phrase: string): string {
  return phrase
    .repeat(Math.ceil(CHARS / phrase.length))
    .slice(0, CHARS - 1)
    .trimEnd()
    .padEnd(CHARS, '.')
}
const BATCHES = [
  {
    name: 'ASCII',
    text: batchOf(
      'The quick brown fox jumps over the lazy dog 0123456789 times; then (again) it rests.  Twice - no more: ',
    ),
  },
  {
    name: 'pt-BR',
    text: batchOf(
      'À tarde a Ângela comeu pão de ló com açúcar; você vê a lingüiça, o avô e a avó: só ações rápidas, fáceis e úteis. ',
    ),
  },
]

type Surface = 'composer' | 'xterm'
type Layer = 'textarea' | 'ipc' | 'pty' | 'tela'
const LAYERS: Layer[] = ['textarea', 'ipc', 'pty', 'tela']

interface Run {
  surface: Surface
  batch: string
  load: boolean
  // Linhas de transcript gravadas enquanto a rodada digitava.
  appendedLines: number
  // Saídas de carga do stub que a rodada pôs na tela (só no xterm sob carga).
  screenOutputs: number
  layers: Partial<Record<Layer, TypedComparison>>
}

const runs: Run[] = []
const results: Array<{ ok: boolean; label: string }> = []
function check(ok: boolean, label: string): boolean {
  results.push({ ok, label })
  console.log(`[fidelity] ${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

function scoreOf(result: TypedComparison): string {
  const count = `${result.matched}/${result.expectedLength} na ordem`
  if (!result.firstDivergence) return count
  const { index, expected, actual } = result.firstDivergence
  return `${count} (chegaram ${result.actualLength}); diverge no caractere ${index}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`
}

const fake = createFakeHome({ parentDir: tmpdir() })
mkdirSync(OUT_DIR, { recursive: true })

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
  claude_command: fake.rawClaudePath,
  keybindings: null,
  'app.showIntroOnBoot': JSON.stringify(false),
  'session.defaultPaneMode': JSON.stringify('terminal'),
  'gpu.disabled': JSON.stringify(false),
  'gpu.disabledByUser': JSON.stringify(false),
  'gpu.autoDisabled': null,
})
// Herdado do shell, desligaria a GPU por baixo das prefs.
delete process.env.CM_DISABLE_GPU

const { app, page } = await launchApp({ userDataDir: userData, env: fake.env })
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w?.unmaximize()
  w?.setSize(1600, 1000)
})

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now()
  while (!(await fn().catch(() => false))) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout esperando: ${label}`)
    await page.waitForTimeout(100)
  }
}

// O valor de uma camada depois que ela parou de mudar.
async function settled(read: () => Promise<string>, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let previous = await read()
  for (;;) {
    await page.waitForTimeout(QUIET_MS)
    const current = await read()
    if (current === previous || Date.now() > deadline) return current
    previous = current
  }
}

const files = (): FakeSessionEntry[] => fake.readSessionFiles()
const live = () =>
  page.evaluate(() => window.api.sessions.listLiveGlobal()) as Promise<
    Array<{ id: string; ccSessionId: string }>
  >

interface WriteSpyGlobal {
  __fidelityWrites?: Array<{ id: string; data: string }>
}

// Mesmo desvio do spy de resize (terminal-resize.ts): o handler original continua
// atendendo, e cada escrita fica registrada na ordem em que o main a recebeu.
async function installWriteSpy(): Promise<boolean> {
  return app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Function> })
      ._invokeHandlers
    const original = handlers?.get('sessions:write')
    if (!original) return false
    const log: Array<{ id: string; data: string }> = []
    ;(globalThis as unknown as WriteSpyGlobal).__fidelityWrites = log
    ipcMain.removeHandler('sessions:write')
    ipcMain.handle('sessions:write', (e, id: string, data: string) => {
      log.push({ id, data })
      return original(e, id, data)
    })
    return true
  })
}

let fatal: unknown = null
let stopLoad = (): void => {}
try {
  await waitReady(page)
  const skip = page.locator('.spl-skip')
  if (await skip.count()) await skip.click({ timeout: 5000 }).catch(() => {})
  const gpu = await page.evaluate(() => window.api.gpu.status())
  if (gpu.hwAccelDisabled) {
    throw new Error('o app subiu com a GPU desligada: neste harness a janela não aparece')
  }
  if (!(await installWriteSpy())) throw new Error('handler sessions:write não encontrado no main')

  // ---------- a sessão, pela UI (Ctrl+N) ----------
  await goToArea(page, 'projects')
  const before = new Set(files().map((f) => f.data.pid))
  await page.keyboard.press('Control+n')
  const search = page.getByPlaceholder('Nova sessão — escolher repo…')
  await search.waitFor({ state: 'visible', timeout: 10_000 })
  await search.fill(repo.label)
  await search.press('Enter')
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()
  const openedAt = Date.now()
  let opened: { id: string; file: FakeSessionEntry } | null = null
  while (!opened) {
    const file = files().find((f) => !before.has(f.data.pid))
    const sessionId = file
      ? (await live()).find((s) => s.ccSessionId === file.data.sessionId)?.id
      : undefined
    if (file && sessionId) opened = { id: sessionId, file }
    else if (Date.now() - openedAt > 20_000) throw new Error('a sessão do stub não abriu')
    else await page.waitForTimeout(100)
  }
  const id = opened.id
  const { pid, sessionId: ccSessionId } = opened.file.data
  const pane = page.locator(`[data-testid="session-pane"][data-session-id="${id}"]`)
  await pane.locator('.xterm-screen').waitFor({ state: 'visible', timeout: 20_000 })

  // ---------- as camadas ----------
  const ipcLines = async (): Promise<string[]> =>
    submittedLines(
      await app.evaluate(
        (_electron, sid) =>
          ((globalThis as unknown as WriteSpyGlobal).__fidelityWrites ?? [])
            .filter((w) => w.id === sid)
            .map((w) => w.data)
            .join(''),
        id,
      ),
    )
  const ptyLines = (): string[] =>
    submittedLines(parseRawStdin(fake.readCliLog('claude')).bytes.toString('utf8'))
  const screenText = async (): Promise<string> => {
    const read = await readXtermBuffer(page, id, 'aba')
    if (read.text == null) {
      throw new Error(`sem buffer do xterm para ler (${read.terms} xterm da sessão)`)
    }
    return read.text
  }
  const screenLines = async (): Promise<string[]> => promptLines(await screenText())

  // O prompt só sai depois do `stty raw`: antes dele a TTY ainda ecoaria por conta.
  await waitFor('prompt do stub raw na tela', async () => (await screenLines()).length === 1)
  fake.setStatus(pid, 'idle')

  // ---------- transcript da sessão: a base no disco, o resto vira a carga ----------
  const projectDir = join(fake.home, '.claude', 'projects', 'fidelity')
  mkdirSync(projectDir, { recursive: true })
  const transcript = join(projectDir, `${ccSessionId}.jsonl`)
  const all = buildLongMotherLines(BASE_TURNS + STREAM_TURNS)
  const turnLines = all.length / (BASE_TURNS + STREAM_TURNS)
  const baseCount = turnLines * BASE_TURNS
  writeFileSync(transcript, all.slice(0, baseCount).join('\n') + '\n')
  const stream = all.slice(baseCount)
  const chatLoad = transcriptLoad(transcript, stream, turnLines)
  function startLoad(surface: Surface): void {
    fake.setStatus(pid, 'busy')
    if (surface === 'xterm') fake.setRawLoad(true)
    const stopAppends = chatLoad.start()
    stopLoad = () => {
      stopAppends()
      fake.setRawLoad(false)
      fake.setStatus(pid, 'idle')
      stopLoad = () => {}
    }
  }

  // ---------- o pane: modo e foco ----------
  const composer = pane.locator('textarea:not(.xterm-helper-textarea):not([disabled])')
  const sendButton = pane.locator('button', { hasText: /^Enviar$/ })
  const FOCUS = {
    composer: 'textarea:not(.xterm-helper-textarea)',
    xterm: '.xterm-helper-textarea',
  }

  // O pane no modo esperado E o foco no composer/xterm DELE. No chat o xterm fica
  // invisível por baixo: uma tecla que caísse no textarea auxiliar dele iria direto
  // para o PTY, e o composer ficaria sem ela.
  async function expectFocus(mode: 'chat' | 'terminal', focus: keyof typeof FOCUS): Promise<void> {
    const read = () =>
      pane.evaluate((root, selector) => {
        const active = document.activeElement
        return {
          mode: root.getAttribute('data-pane-mode'),
          focused: !!active && root.contains(active) && active.matches(selector),
          active: active ? `${active.tagName.toLowerCase()}.${active.getAttribute('class')}` : '-',
        }
      }, FOCUS[focus])
    const started = Date.now()
    let state = await read()
    while (state.mode !== mode || !state.focused) {
      if (Date.now() - started > 5000) {
        throw new Error(
          `pane fora do esperado: modo "${state.mode}" (esperado "${mode}"), foco em <${state.active}> (esperado o ${focus} da sessão)`,
        )
      }
      await page.waitForTimeout(100)
      state = await read()
    }
  }

  async function toggle(to: 'Chat' | 'Terminal'): Promise<void> {
    await pane.locator(`[aria-label="Mudar para ${to}"]`).click()
    const mode = to.toLowerCase()
    await waitFor(
      `pane em modo ${mode}`,
      async () => (await pane.getAttribute('data-pane-mode')) === mode,
    )
  }

  const lastChatText = (): Promise<string> =>
    pane
      .locator('.markdown-body')
      .last()
      .innerText()
      .catch(() => '')

  const cdp = await page.context().newCDPSession(page)

  // Uma rodada: digita o lote na superfície, fecha a linha e compara cada camada
  // com o que foi digitado. O índice da linha é o de ANTES da rodada, por camada:
  // cada uma tem o seu histórico (o spy, por exemplo, só vê o que veio depois dele).
  async function run(
    surface: Surface,
    batch: (typeof BATCHES)[number],
    load: boolean,
  ): Promise<void> {
    const label = `${surface} · ${batch.name} · ${load ? 'sob carga' : 'sem carga'}`
    const mode = surface === 'composer' ? 'chat' : 'terminal'
    await (surface === 'composer' ? composer : pane.locator('.xterm-screen')).click()
    await expectFocus(mode, surface)
    if (surface === 'composer') {
      await waitFor(`${label}: composer vazio`, async () => (await composer.inputValue()) === '')
    }
    const at = {
      ipc: (await ipcLines()).length - 1,
      pty: ptyLines().length - 1,
      tela: (await screenLines()).length - 1,
    }
    const open = {
      ipc: (await ipcLines())[at.ipc],
      pty: ptyLines()[at.pty],
      tela: (await screenLines())[at.tela],
    }
    if (open.ipc !== '' || open.pty !== '' || open.tela !== '') {
      throw new Error(`${label}: já havia texto na linha aberta: ${JSON.stringify(open)}`)
    }

    const typed: Partial<Record<Layer, string>> = {}
    const appendedAtStart = chatLoad.appendedLines()
    const chatAtStart = load && surface === 'composer' ? await lastChatText() : ''
    const outputsAtStart = loadOutputs(await screenText())
    let appended = 0
    let chatChanged = false
    if (load) startLoad(surface)
    try {
      const typing = await typeOpenLoop(
        (method, params) => cdp.send(method, params as never),
        batch.text,
        KEY_DELAY_MS,
      )
      if (typing.failed > 0) {
        throw new Error(`${label}: o CDP recusou ${typing.failed} de ${typing.keys} teclas`)
      }
      // A prova da carga é de quando a última tecla entrou: o que o chat desenhar
      // depois disso não concorreu com a digitação.
      appended = chatLoad.appendedLines() - appendedAtStart
      chatChanged = load && surface === 'composer' && (await lastChatText()) !== chatAtStart
      // O foco não pode ter saído no meio da digitação.
      await expectFocus(mode, surface)
      if (surface === 'composer') {
        typed.textarea = await settled(() => composer.inputValue())
        await sendButton.click()
      } else {
        await settled(async () => ptyLines()[at.pty] ?? '')
        await page.keyboard.press('Enter')
      }
      await waitFor(`${label}: Enter no PTY`, async () => ptyLines().length > at.pty + 1)
      await waitFor(
        `${label}: prompt novo na tela`,
        async () => (await screenLines()).length > at.tela + 1,
      )
      await waitFor(`${label}: Enter no ipc`, async () => (await ipcLines()).length > at.ipc + 1)
    } finally {
      stopLoad()
    }
    typed.ipc = (await ipcLines())[at.ipc]
    typed.pty = ptyLines()[at.pty]
    typed.tela = (await screenLines())[at.tela]

    const screenOutputs = loadOutputs(await screenText()) - outputsAtStart
    if (load) {
      const seen = { transcriptLines: appended, chatChanged, screenOutputs }
      for (const proof of loadChecks(surface, seen)) check(proof.ok, `${label}: ${proof.label}`)
    }
    const layers: Run['layers'] = {}
    for (const layer of LAYERS) {
      const value = typed[layer]
      if (value == null) continue
      const result = compareTyped(batch.text, value)
      layers[layer] = result
      check(result.ok, `${label} · ${layer}: ${scoreOf(result)}`)
    }
    runs.push({ surface, batch: batch.name, load, appendedLines: appended, screenOutputs, layers })
  }

  // ---------- composer do chat ----------
  await toggle('Chat')
  await pane
    .locator('.markdown-body')
    .filter({ hasText: `pronto ${BASE_TURNS - 1}.` })
    .last()
    .waitFor({ state: 'visible', timeout: 60_000 })
  await pane.getByTestId('chat-loading').waitFor({ state: 'hidden', timeout: 60_000 })
  for (const load of [false, true]) {
    for (const batch of BATCHES) await run('composer', batch, load)
  }

  // ---------- xterm, em modo terminal ----------
  await toggle('Terminal')
  for (const load of [false, true]) {
    for (const batch of BATCHES) await run('xterm', batch, load)
  }
} catch (err) {
  fatal = err
  console.error('[fidelity] erro fatal:', err)
  await page.screenshot({ path: join(OUT_DIR, 'fidelity-fatal.png') }).catch(() => {})
} finally {
  stopLoad()
  const proc = app.process()
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  try {
    proc.kill('SIGKILL')
  } catch {
    // já saiu
  }
  fake.cleanup()
}

// ---------- resumo por superfície ----------
for (const surface of ['composer', 'xterm'] as const) {
  const compared = runs
    .filter((r) => r.surface === surface)
    .flatMap((r) =>
      LAYERS.flatMap((layer) => {
        const result = r.layers[layer]
        const where = `${r.batch} · ${r.load ? 'sob carga' : 'sem carga'} · ${layer}`
        return result ? [{ where, result }] : []
      }),
    )
  const matched = compared.reduce((sum, c) => sum + c.result.matched, 0)
  const total = compared.reduce((sum, c) => sum + c.result.expectedLength, 0)
  const first = compared.find((c) => !c.result.ok)
  console.log(
    `[fidelity] ${surface}: ${matched}/${total} caracteres na ordem em ${compared.length} comparações; ${
      first ? `primeira divergência em ${first.where}: ${scoreOf(first.result)}` : 'sem divergência'
    }`,
  )
}

const failed = results.filter((r) => !r.ok)
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      chars: CHARS,
      keyDelayMs: KEY_DELAY_MS,
      batches: BATCHES,
      runs,
      failed: failed.map((r) => r.label),
      ...(fatal ? { error: String(fatal) } : {}),
    },
    null,
    2,
  ),
)
console.log(
  `\n[fidelity] ${results.length - failed.length}/${results.length} PASS · JSON em ${OUT_FILE}`,
)
if (fatal || failed.length) process.exit(1)
