/** @vitest-environment node */
// A volta da hibernação pelos produtores reais: o handler de exit do
// ipc/sessions.ts, o sessions:write, a PromptQueue do ipc/send-prompt.ts (com o
// redirectOnExit e o beforeWrite de verdade), o hibernador do ipc/hibernate.ts
// (registerHibernatedDormant) e o registro de dormant do ipc/dormant-panes.ts, com
// o DB e o disco reais. Fakes só na borda: a PTY, o espelho da tela e a janela,
// que responde ao wake-request como o renderer.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, Array<(e: unknown) => void>>(),
  running: new Set<string>(),
  ptyWrites: [] as string[],
  sent: [] as Array<{ channel: string; payload: unknown }>,
  scan: null as unknown,
  wakeTo: 'pty-woken',
  onWake: () => {},
}))

// O renderer confirma o flush dos rascunhos (o caminho real do sweep do exit só
// apaga temps depois disso).
vi.mock('./composer-drafts', async (orig) => ({
  ...(await orig<typeof import('./composer-drafts')>()),
  requestDraftFlush: async () => true,
}))

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hibernate-exit-test-'))
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        seam.sent.push({ channel, payload })
        // O renderer acorda a pane (sessions:resume) e devolve o id novo.
        if (channel === 'sessions:wake-request') {
          const { requestId } = payload as { requestId: string }
          seam.running.add(seam.wakeTo)
          seam.onWake()
          queueMicrotask(() =>
            seam.handlers.get('sessions:wake-result')!(null, {
              requestId,
              sessionId: seam.wakeTo,
            }),
          )
        }
      },
    },
  }
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test', isPackaged: false },
    BrowserWindow: { getAllWindows: () => [win] },
    webContents: { fromId: () => null },
    Notification: class {
      static isSupported() {
        return false
      }
      show() {}
      on() {}
    },
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        seam.handlers.set(channel, fn)
      },
    },
    __win: win,
  }
})
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: (event: string, fn: (e: unknown) => void) => {
      seam.listeners.set(event, [...(seam.listeners.get(event) ?? []), fn])
    },
    off: () => {},
    write: (id: string, data: string) => {
      if (!seam.running.has(id)) throw new Error('session not running')
      seam.ptyWrites.push(`${id}:${data}`)
    },
    isRunning: (id: string) => seam.running.has(id),
    runningIds: () => [...seam.running],
    getLastIoAt: () => null,
    sessionIdByPid: () => null,
  },
}))
vi.mock('../services/tui-menu-watch', async (orig) => ({
  ...(await orig<typeof import('../services/tui-menu-watch')>()),
  tuiMenuWatch: {
    attach: () => {},
    on: () => {},
    has: () => true,
    rescan: async () => seam.scan,
    current: () => seam.scan,
    ptyForCc: () => null,
  },
}))
vi.mock('../services/notifications', async (orig) => {
  const electron = (await import('electron')) as unknown as { __win: unknown }
  return {
    ...(await orig<typeof import('../services/notifications')>()),
    getMainWindow: () => electron.__win,
    notify: () => {},
  }
})
// O status nativo do claude (~/.claude/sessions/<pid>.json): todas ociosas.
vi.mock('../services/session-activity', async (orig) => {
  const actual = await orig<typeof import('../services/session-activity')>()
  return {
    ...actual,
    buildSessionsFileIndex: () =>
      new Proxy(new Map(), {
        get: (target, prop) =>
          prop === 'get'
            ? () => ({ pid: process.pid, status: 'idle', procStart: null, statusUpdatedAt: 0 })
            : Reflect.get(target, prop),
      }),
    isPidAlive: () => true,
  }
})
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))

import { app } from 'electron'
import { closeDb, getDb } from '../services/db'
import { setPref } from '../services/prefs-store'
import { fixture, scanOf } from '../services/test-support/screen-scans'
import { getDormantPanes } from '../services/dormant-panes'
import { getIdleHibernator } from '../services/hibernate/idle-hibernator'
import { buildImageFilename } from '../services/image-temp'
import { formatPtyInjection } from '../services/handoff/inject'
import { LAZY_RESTORE_PREF } from '../../../shared/lazy-restore'
import { registerSessionIpc, sweepOrphanImageTemps } from './sessions'
import { promptQueue, registerSendPromptIpc } from './send-prompt'
import { registerDormantPanesIpc } from './dormant-panes'
import { registerHibernateIpc } from './hibernate'

const PTY = 'pty-1'
const CC = '74f13261-5b8e-4f43-9d0e-2c5a2b1f7c11'
const OTHER = 'pty-2'
const OTHER_CC = '0b8e3c55-9f2a-4d61-8a7e-3e1f6c2d9a40'
const PANE = 'pane-1'
const WOKEN = seam.wakeTo

const tmp = () => join(app.getPath('userData'), 'tmp')
const channels = () => seam.sent.map((s) => s.channel)

function exit(sessionId: string): void {
  seam.running.delete(sessionId)
  for (const fn of seam.listeners.get('exit') ?? []) fn({ sessionId, exitCode: 0, signal: null })
}

function write(sessionId: string, data: string): void {
  seam.handlers.get('sessions:write')!(null, sessionId, data)
}

function insertSession(id: string, cc: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at, provider)
       VALUES (?, NULL, ?, NULL, 'running', ?, 'claude')`,
    )
    .run(id, cc, Date.now())
}

// Imagem colada no Composer desta sessão, como o sessions:save-image grava.
function pastedImage(sessionId: string): string {
  mkdirSync(tmp(), { recursive: true })
  const path = join(tmp(), buildImageFilename({ id: 'shot', mime: 'image/png', sessionId }))
  writeFileSync(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  return path
}

beforeAll(async () => {
  seam.scan = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
  setPref(LAZY_RESTORE_PREF, true)
  seam.onWake = () => insertSession(WOKEN, CC)
  // A ordem do index.ts.
  registerSessionIpc()
  registerSendPromptIpc()
  registerDormantPanesIpc()
  registerHibernateIpc()
})

beforeEach(() => {
  getDb().exec('DELETE FROM sessions;')
  seam.running = new Set([PTY, OTHER])
  seam.ptyWrites.length = 0
  seam.sent.length = 0
  insertSession(PTY, CC)
  insertSession(OTHER, OTHER_CC)
})

afterAll(() => {
  getIdleHibernator()?.dispose()
  promptQueue.dispose()
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('exit da hibernação pelos handlers reais', () => {
  it('Composer depois do /exit: não chega ao PTY, hiberna, acorda e o texto chega na sessão nova', async () => {
    const image = pastedImage(PTY)
    const composer = `\x1b[200~olha ${image}\x1b[201~`

    expect(await getIdleHibernator()!.hibernate({ sessionId: PTY, ccSessionId: CC }, PANE)).toBe(
      true,
    )
    expect(seam.ptyWrites).toEqual([`${PTY}:${formatPtyInjection('/exit')}`])

    // O usuário envia pelo Composer enquanto o claude sai.
    write(PTY, composer)
    write(PTY, '\r')
    await vi.waitFor(() => expect(promptQueue.snapshot().items).toHaveLength(1))
    expect(seam.ptyWrites).toHaveLength(1)
    expect(promptQueue.snapshot().items[0]).toMatchObject({ sessionId: PTY, text: `${composer}\r` })

    exit(PTY)

    // sessions:hibernated antes do pty:exit, e a dormant já no registro do main
    // (registerHibernatedDormant) para o redirect da fila achá-la.
    const hibernatedAt = channels().indexOf('sessions:hibernated')
    expect(hibernatedAt).toBeGreaterThanOrEqual(0)
    expect(hibernatedAt).toBeLessThan(channels().indexOf('pty:exit'))
    expect(seam.sent[hibernatedAt].payload).toEqual({
      sessionId: PTY,
      ccSessionId: CC,
      paneId: PANE,
    })
    expect(getDormantPanes()?.findDormantByCc(CC)).toMatchObject({ ccSessionId: CC, paneId: PANE })
    expect(getIdleHibernator()!.getStats().hibernated).toBe(1)

    // A imagem colada sobrevive ao exit hibernado: o rascunho volta no wake com o path.
    expect(existsSync(image)).toBe(true)

    // O redirectOnExit acorda a pane e a fila entrega o texto cru na sessão nova.
    await vi.waitFor(() => expect(seam.ptyWrites).toHaveLength(2), { timeout: 3_000 })
    expect(channels()).toContain('sessions:wake-request')
    expect(seam.ptyWrites[1]).toBe(`${WOKEN}:${composer}\r`)
    expect(promptQueue.snapshot().counters.sessionGone).toBe(0)
    expect(existsSync(image)).toBe(true)

    // Exit comum de outra sessão: a imagem dela é varrida, a da hibernada fica.
    const otherImage = pastedImage(OTHER)
    exit(OTHER)
    await vi.waitFor(() => expect(existsSync(otherImage)).toBe(false))
    expect(existsSync(image)).toBe(true)

    // A sweep do boot recolhe os temps de imagem (num processo fresco todos são
    // órfãos) e nada além deles.
    const notImage = join(tmp(), 'system-prompt-x.md')
    writeFileSync(notImage, 'x')
    sweepOrphanImageTemps()
    expect(existsSync(image)).toBe(false)
    expect(existsSync(notImage)).toBe(true)
  })

  it('exit comum com item na fila: sem dormant e sem wake', async () => {
    const before = getIdleHibernator()!.getStats().hibernated
    const sent = await promptQueue.send({ sessionId: OTHER, text: 'oi', when: 'on-idle' })
    // A tela ociosa entrega na hora; o próximo espera o turno.
    expect(sent).toEqual({ ok: true, delivered: true })
    await promptQueue.send({ sessionId: OTHER, text: 'segunda', when: 'on-idle' })
    exit(OTHER)
    expect(channels()).not.toContain('sessions:hibernated')
    await new Promise((r) => setTimeout(r, 20))
    expect(channels()).not.toContain('sessions:wake-request')
    expect(getDormantPanes()?.findDormantByCc(OTHER_CC)).toBeNull()
    expect(getIdleHibernator()!.getStats().hibernated).toBe(before)
  })
})
