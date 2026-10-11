/** @vitest-environment node */
import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

const { openAppDb: openAppDbForTest } = await import('./db')
import { getComposerDraft, saveComposerDraft } from './composer-drafts'

// Durabilidade contra kill -9 com processo de verdade: um filho Node abre o
// app.db pelo caminho de produção, grava o rascunho e leva SIGKILL 1s depois,
// sem chance de fechar a conexão nem fazer checkpoint do WAL.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-draft-kill-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function bundleWriter(entry = 'composer-draft-writer'): string {
  const outfile = join(dir, `${entry}.cjs`)
  buildSync({
    entryPoints: [resolve(__dirname, `test-support/${entry}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['better-sqlite3', 'electron'],
    logLevel: 'silent',
  })
  return outfile
}

// better-sqlite3 11 no Node 24 do vitest (produção roda o Node 20 do Electron)
// às vezes aborta no GC de um Statement ("Assertion failed: (env) != nullptr")
// antes de o filho avisar. Abort ANTES do aviso não é falha de durabilidade (o
// filho nunca disse que gravou): roda de novo com um banco novo, até 3 vezes.
// Qualquer outra saída antes do aviso falha o teste.
async function runChild(opts: {
  entry: string
  args: (dbPath: string) => string[]
  marker: string
  setup?: (dbPath: string) => void
  // Chamado no mesmo handler em que o aviso chega (SIGKILL imediato).
  onReady?: (child: ChildProcess) => void
}): Promise<{ dbPath: string; child: ChildProcess; exited: Promise<ChildExit> }> {
  const script = bundleWriter(opts.entry)
  for (let attempt = 1; ; attempt++) {
    const dbPath = join(dir, `app-${attempt}.db`)
    opts.setup?.(dbPath)
    const child = spawn(process.execPath, [script, ...opts.args(dbPath)], {
      env: { ...process.env, NODE_PATH: resolve(__dirname, '../../../node_modules') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (b) => (stderr += String(b)))
    const exited = new Promise<ChildExit>((res) =>
      child.on('exit', (code, signal) => res({ code, signal })),
    )
    const ready = await new Promise<boolean>((res) => {
      child.stdout!.on('data', (b) => {
        if (!String(b).includes(opts.marker)) return
        opts.onReady?.(child)
        res(true)
      })
      void exited.then(() => res(false))
    })
    if (ready) return { dbPath, child, exited }
    if (!stderr.includes('Assertion failed') || attempt >= 3) {
      throw new Error(`filho saiu antes de avisar: ${stderr}`)
    }
  }
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null }

it('o rascunho gravado sobrevive a SIGKILL do processo que gravou', async () => {
  const draft = {
    key: 'pane:p-kill',
    ccSessionId: 'cc-kill',
    paneId: 'p-kill',
    text: 'texto que não pode sumir\ncom quebra e ç',
    attachments: [{ name: 'a.png', path: '/x/img-s-1.png' }],
  }
  const { dbPath, child, exited } = await runChild({
    entry: 'composer-draft-writer',
    args: (db) => [db, JSON.stringify(draft)],
    marker: 'saved',
  })
  await new Promise((r) => setTimeout(r, 1000))
  child.kill('SIGKILL')
  expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })
  expect(readDraft(dbPath, draft.key)).toMatchObject(draft)
}, 30000)

// Sobe o filho que digita e (conforme o modo) dá flushSync; SIGKILL no mesmo
// instante em que ele avisa — sem esperar o debounce de 500ms.
async function typeAndKillNow(
  mode: string,
  key: string,
  text: string,
  setup?: (dbPath: string) => void,
): Promise<string> {
  const { dbPath, exited } = await runChild({
    entry: 'composer-draft-flusher',
    args: (db) => [db, mode, key, text],
    marker: 'ready',
    setup,
    onReady: (child) => child.kill('SIGKILL'),
  })
  expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })
  return dbPath
}

function readDraft(dbPath: string, key: string) {
  const db = new Database(dbPath)
  try {
    return getComposerDraft(db, key)
  } finally {
    db.close()
  }
}

it('flushSync grava antes do SIGKILL imediato; sem ele, o debounce perderia o digitado', async () => {
  const text = 'digitado e morto na hora\nlinha 2 ç'

  const ctrl = await typeAndKillNow('no-flush', 'pane:p-ctrl', text)
  expect(readDraft(ctrl, 'pane:p-ctrl')).toBeNull()

  const flushed = await typeAndKillNow('flush', 'pane:p-flush', text)
  expect(readDraft(flushed, 'pane:p-flush')).toMatchObject({
    text,
    attachments: [{ name: 'shot.png', path: '/x/img-proc-1.png' }],
  })
}, 30000)

it('flushSync antes da hidratação junta o salvo ao digitado, sem sobrescrever', async () => {
  const dbPath = await typeAndKillNow(
    'flush-before-hydrate',
    'pane:p-race',
    'digitado no boot',
    (path) => {
      const seed = openAppDbForTest(path)
      saveComposerDraft(seed, {
        key: 'pane:p-race',
        ccSessionId: 'cc-proc',
        paneId: 'p-race',
        text: 'salvo antes do reboot',
        attachments: [],
      })
      seed.close()
    },
  )
  expect(readDraft(dbPath, 'pane:p-race')?.text).toBe('salvo antes do reboot\n\ndigitado no boot')
}, 30000)

// Write-through: cada mudança chega ao main e é commitada (NORMAL) antes de o
// renderer seguir para a próxima. SIGKILL logo após a última mudança, sem flush e
// com o debounce FULL ainda pendente: a última versão está no app.db.
it.each([
  ['keys', 'cada tecla no seu tick'],
  ['burst', '200 mudanças no mesmo tick, coalescidas'],
])(
  'write-through (%s): SIGKILL logo após a última mudança mantém a última versão — %s',
  async (mode) => {
    const key = `pane:p-wt-${mode}`
    const { dbPath, exited } = await runChild({
      entry: 'composer-draft-typist',
      args: (db) => [db, mode, key, 'versão', '200'],
      marker: 'ready',
      onReady: (child) => child.kill('SIGKILL'),
    })
    expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })
    expect(readDraft(dbPath, key)).toMatchObject({ key, text: 'versão 200', attachments: [] })
  },
  30000,
)
