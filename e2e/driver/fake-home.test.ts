// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAKE_CODEX_DONE,
  buildSessionFile,
  createFakeHome,
  withStatus,
  type FakeHome,
} from './fake-home'
import { hasInputPrompt } from '../../shared/tui/attention-reason'

// session-activity importa electron e serviços com banco; só o leitor de
// sessions/<pid>.json interessa aqui.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../electron/main/services/usage-monitor', () => ({ notifyUsageConsumption: () => {} }))
vi.mock('../../electron/main/services/notifications', () => ({
  getNotifPrefs: () => ({}),
  getMainWindow: () => null,
  getRendererFocusedSession: () => null,
  notify: () => {},
}))
vi.mock('../../electron/main/services/handoff-store', () => ({ isActiveCrewChild: () => false }))

let fake: FakeHome | null = null
const originalHome = process.env.HOME

afterEach(() => {
  fake?.cleanup()
  fake = null
  process.env.HOME = originalHome
})

function runStub(path: string, args: string[], stdin: string): string {
  return execFileSync(path, args, { input: stdin, cwd: fake!.root, encoding: 'utf8' })
}

describe('buildSessionFile / withStatus', () => {
  it('monta o arquivo com os campos que o leitor do app usa', () => {
    const file = buildSessionFile(42, { sessionId: 's1', cwd: '/r', status: 'busy' }, 1000)
    expect(file).toEqual({
      pid: 42,
      sessionId: 's1',
      cwd: '/r',
      status: 'busy',
      name: null,
      startedAt: 1000,
      updatedAt: 1000,
    })
  })

  it('troca status e updatedAt sem mutar o original', () => {
    const file = buildSessionFile(42, { sessionId: 's1', cwd: '/r', status: 'busy' }, 1000)
    const next = withStatus(file, 'waiting', 2000)
    expect(next).toMatchObject({ status: 'waiting', updatedAt: 2000, startedAt: 1000 })
    expect(file.status).toBe('busy')
  })
})

describe('createFakeHome', () => {
  it('cria o HOME com zsh silenciado e as CLIs executáveis', () => {
    fake = createFakeHome()
    expect(fake.env).toEqual({ HOME: fake.home })
    expect(readFileSync(join(fake.home, '.zshrc'), 'utf8')).toBe('')
    expect(existsSync(join(fake.home, '.claude', 'projects'))).toBe(true)
    for (const provider of ['claude', 'codex'] as const) {
      expect(statSync(fake.fakeCliPath(provider)).mode & 0o111).not.toBe(0)
    }
  })

  it('writeSessionFile + setStatus + readSessionFiles fazem roundtrip', () => {
    fake = createFakeHome()
    fake.writeSessionFile(123, { sessionId: 's1', cwd: '/r', status: 'busy', name: 'ana' })
    fake.setStatus(123, 'idle')
    const [entry] = fake.readSessionFiles()
    expect(entry.file).toBe(join(fake.sessionsDir, '123.json'))
    expect(entry.data).toMatchObject({ pid: 123, sessionId: 's1', status: 'idle', name: 'ana' })
  })

  it('setStatus sem session file falha alto', () => {
    fake = createFakeHome()
    expect(() => fake!.setStatus(999, 'idle')).toThrow(/pid 999/)
  })

  it('cleanup remove o root inteiro', () => {
    fake = createFakeHome()
    const root = fake.root
    fake.cleanup()
    expect(existsSync(root)).toBe(false)
  })
})

describe('fake-claude.sh', () => {
  it('grava sessions/<pid>.json a partir do argv do spawn e loga o stdin sem bracketed-paste', () => {
    fake = createFakeHome()
    const out = runStub(
      fake.fakeCliPath('claude'),
      ['--session-id', 'cc-1', '-n', 'maurício "m"', '--model', 'opus', 'kickoff'],
      '\x1b[200~olá\x1b[201~\r\nsegunda\n',
    )
    expect(out).toContain('Fake Claude Code')
    expect(out).toContain('recebido: olá')

    const [entry] = fake.readSessionFiles()
    expect(entry.data).toMatchObject({
      sessionId: 'cc-1',
      name: 'maurício "m"',
      status: 'busy',
      cwd: fake.root,
    })
    expect(entry.file).toBe(join(fake.sessionsDir, `${entry.data.pid}.json`))

    const log = fake.readCliLog('claude')
    expect(log).toContain('--session-id cc-1')
    expect(log).toContain('stdin: olá\n')
    expect(log).toContain('stdin: segunda\n')
  })

  it('desenha a caixa de input ociosa que o leitor real (hasInputPrompt) reconhece', () => {
    fake = createFakeHome()
    const out = runStub(fake.fakeCliPath('claude'), ['--session-id', 'cc-3'], 'oi\n')
    expect(hasInputPrompt(out)).toBe(true)
  })

  it('--resume também vira o sessionId', () => {
    fake = createFakeHome()
    runStub(fake.fakeCliPath('claude'), ['--resume', 'cc-old', '-n', 'x'], '')
    expect(fake.readSessionFiles()[0].data.sessionId).toBe('cc-old')
  })

  // Contrato com o produtor real: o arquivo escrito pelo stub (e o flip do
  // setStatus) tem que ser lido pelo MESMO leitor que o app usa em produção.
  it('o leitor do app (buildSessionsFileIndex) indexa o que o stub escreveu', async () => {
    fake = createFakeHome()
    runStub(fake.fakeCliPath('claude'), ['--session-id', 'cc-2', '-n', 'renata'], '')
    const pid = fake.readSessionFiles()[0].data.pid

    process.env.HOME = fake.home
    vi.resetModules()
    const activity = await import('../../electron/main/services/session-activity')

    const before = activity.buildSessionsFileIndex().get('cc-2')
    expect(before).toMatchObject({ pid, name: 'renata', cwd: fake.root, status: 'busy' })
    expect(activity.mapStatus(before!.status)).toBe('working')

    fake.setStatus(pid, 'waiting')
    const after = activity.buildSessionsFileIndex().get('cc-2')
    expect(activity.mapStatus(after!.status)).toBe('waiting')
  })
})

describe('fake-codex.sh', () => {
  it('imprime o banner do Codex, roda um turno pelo prompt inicial e ecoa/loga o stdin', () => {
    fake = createFakeHome()
    const out = runStub(
      fake.fakeCliPath('codex'),
      ['-s', 'read-only', '-c', 'k="v"', 'tarefa inicial'],
      'oi\n',
    )
    expect(out).toContain('>_ OpenAI Codex')
    expect(out).toContain('prompt inicial: tarefa inicial')
    expect(out).toContain('Working (1s')
    expect(out).toContain(FAKE_CODEX_DONE)
    expect(out).toContain('recebido: oi')
    const log = fake.readCliLog('codex')
    expect(log).toMatch(/argv: -s read-only -c k=\\"v\\" tarefa\\ inicial\n/)
    // Sem PITWALL_MCP_TOKEN no env do teste: a linha existe e fica vazia.
    expect(log).toMatch(/env-token: \n/)
    // O stdin só é lido depois do turno do prompt inicial.
    expect(log).toMatch(/turn-end: \d+\nstdin: oi @\d+\nturn-end: \d+\n/)
    expect(readdirSync(fake.sessionsDir)).toEqual([])
  })
})
