/** @vitest-environment node */
// Fiação do lazy restore no main contra a pref REAL (app_prefs no DB com as
// migrations do app, gravada pelo prefs-store que o prefs:set usa).
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  hook: null as null | ((session: unknown, origin: 'renderer' | 'main') => void),
  sent: [] as Array<{ channel: string; payload: unknown }>,
}))

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dormant-panes-ipc-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        seam.handlers.set(channel, fn)
      },
    },
  }
})
vi.mock('../services/pty-manager', () => ({ ptyManager: { isRunning: () => false } }))
vi.mock('../services/notifications', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => seam.sent.push({ channel, payload }),
    },
  }),
}))
vi.mock('./sessions', () => ({
  setResumedSessionHook: (fn: typeof seam.hook) => {
    seam.hook = fn
  },
}))
vi.mock('./send-prompt', () => ({ screenOf: async () => null }))

import { app } from 'electron'
import { closeDb, getDb } from '../services/db'
import { setPref } from '../services/prefs-store'
import { getDormantPanes } from '../services/dormant-panes'
import { LAZY_RESTORE_PREF } from '../services/restore-plan'
import { registerDormantPanesIpc } from './dormant-panes'

const PANE = { ccSessionId: 'cc-1', paneId: 'pane-1', title: 'api', repoId: null }

function sync(list: unknown[]): unknown {
  return seam.handlers.get('sessions:dormant-sync')!(null, list)
}

registerDormantPanesIpc()

beforeEach(() => {
  getDb().prepare('DELETE FROM app_prefs WHERE key = ?').run(LAZY_RESTORE_PREF)
  seam.sent.length = 0
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('sessions:dormant-sync e o registro', () => {
  it('pref ausente (default desligada): ignora o sync e o main não vê pane dormindo', () => {
    expect(sync([PANE])).toEqual([PANE])

    expect(getDormantPanes()).toBeNull()
    setPref(LAZY_RESTORE_PREF, true)
    // Nada foi registrado enquanto estava desligada.
    expect(getDormantPanes()?.findDormantByCc('cc-1')).toBeNull()
  })

  it('pref ligada: registra e o registro fica alcançável', () => {
    setPref(LAZY_RESTORE_PREF, true)

    sync([PANE])

    expect(getDormantPanes()?.findDormantByCc('cc-1')).toMatchObject({ paneId: 'pane-1' })
  })

  it('desligar depois de registrar: some na hora, sem reiniciar', () => {
    setPref(LAZY_RESTORE_PREF, true)
    sync([PANE])

    setPref(LAZY_RESTORE_PREF, false)

    expect(getDormantPanes()).toBeNull()
  })
})

describe('sessions:restore-plan', () => {
  it('pref desligada: tudo eager', () => {
    const plan = seam.handlers.get('sessions:restore-plan')!(null, ['cc-1', 'cc-2'])
    expect(plan).toEqual({ mode: 'eager', eagerCcSessionIds: ['cc-1', 'cc-2'] })
  })
})

describe('sessions:dormant-became-live', () => {
  const SESSION = { id: 'new-1', ccSessionId: 'cc-1', status: 'running' }

  function became(): unknown[] {
    return seam.sent
      .filter((e) => e.channel === 'sessions:dormant-became-live')
      .map((e) => e.payload)
  }

  it('resume pedido no main para cc com pane dormindo: emite e tira do registro', () => {
    setPref(LAZY_RESTORE_PREF, true)
    sync([PANE])

    seam.hook!(SESSION, 'main')

    expect(became()).toEqual([{ ccSessionId: 'cc-1', session: SESSION }])
    expect(getDormantPanes()?.findDormantByCc('cc-1')).toBeNull()
  })

  it('resume pedido pelo renderer (sessions:resume): não emite', () => {
    setPref(LAZY_RESTORE_PREF, true)
    sync([PANE])

    seam.hook!(SESSION, 'renderer')

    expect(became()).toEqual([])
  })

  it('cc sem pane dormindo: não emite', () => {
    setPref(LAZY_RESTORE_PREF, true)
    sync([PANE])

    seam.hook!({ ...SESSION, ccSessionId: 'cc-outra' }, 'main')

    expect(became()).toEqual([])
  })

  it('pref desligada: não emite', () => {
    setPref(LAZY_RESTORE_PREF, true)
    sync([PANE])
    setPref(LAZY_RESTORE_PREF, false)

    seam.hook!(SESSION, 'main')

    expect(became()).toEqual([])
  })
})
