/** @vitest-environment node */
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { getComposerDraft } from './composer-drafts'

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

function bundleWriter(): string {
  const outfile = join(dir, 'writer.cjs')
  buildSync({
    entryPoints: [resolve(__dirname, 'test-support/composer-draft-writer.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['better-sqlite3', 'electron'],
    logLevel: 'silent',
  })
  return outfile
}

it('o rascunho gravado sobrevive a SIGKILL do processo que gravou', async () => {
  const dbPath = join(dir, 'app.db')
  const draft = {
    key: 'pane:p-kill',
    ccSessionId: 'cc-kill',
    paneId: 'p-kill',
    text: 'texto que não pode sumir\ncom quebra e ç',
    attachments: [{ name: 'a.png', path: '/x/img-s-1.png' }],
  }
  const child = spawn(process.execPath, [bundleWriter(), dbPath, JSON.stringify(draft)], {
    env: { ...process.env, NODE_PATH: resolve(__dirname, '../../../node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (b) => (stderr += String(b)))

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
    child.on('exit', (code, signal) => res({ code, signal })),
  )
  await new Promise<void>((res, rej) => {
    child.stdout.on('data', (b) => String(b).includes('saved') && res())
    void exited.then(() => rej(new Error(`writer saiu antes de gravar: ${stderr}`)))
  })
  await new Promise((r) => setTimeout(r, 1000))
  child.kill('SIGKILL')
  expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })

  const db = new Database(dbPath)
  try {
    expect(getComposerDraft(db, draft.key)).toMatchObject(draft)
  } finally {
    db.close()
  }
}, 20000)
