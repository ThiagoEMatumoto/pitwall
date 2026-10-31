/** @vitest-environment node */
// Ligação da hibernação no main contra as prefs REAIS (app_prefs no DB com as
// migrations do app, gravadas pelo prefs:set real) e o lazyRestore congelado pelo
// registerDormantPanesIpc real. A PromptQueue é a real; fakes só na borda (PTY,
// tela, janela).
import { rmSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  running: [] as string[],
  writes: [] as string[],
  scan: null as unknown,
}))

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hibernate-ipc-test-'))
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
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    isRunning: (id: string) => seam.running.includes(id),
    runningIds: () => [...seam.running],
    getLastIoAt: () => null,
    sessionIdByPid: () => null,
  },
}))
vi.mock('../services/notifications', () => ({ getMainWindow: () => null }))
vi.mock('../services/repo-pull-scheduler', () => ({
  AUTO_PULL_ENABLED_KEY: 'repos.autoPull.enabled',
  AUTO_PULL_INTERVAL_MINUTES_KEY: 'repos.autoPull.intervalMinutes',
  rescheduleAutoPull: () => {},
  runAutoPullNow: async () => {},
}))
vi.mock('./sessions', () => ({
  setResumedSessionHook: () => {},
  findAliveByCc: () => null,
}))
// A fila real, com a guarda de verdade (tela relida pelo espelho headless).
vi.mock('./send-prompt', async () => {
  const { PromptQueue } = await import('../services/prompt-queue')
  const promptQueue = new PromptQueue({
    isRunning: (id) => seam.running.includes(id),
    status: () => 'idle',
    screen: async () => seam.scan as never,
    nativeStatus: () => true,
    handoffAsking: () => false,
    write: (id, text) => seam.writes.push(`${id}:${text}`),
    emit: () => {},
    warn: () => {},
  })
  return { screenOf: async () => null, promptQueue }
})

import { app } from 'electron'
import { closeDb, getDb } from '../services/db'
import { setPref } from '../services/prefs-store'
import { fixture, scanOf } from '../services/test-support/screen-scans'
import { getIdleHibernator, HIBERNATE_TICK_MS } from '../services/hibernate/idle-hibernator'
import { HIBERNATE_AFTER_MIN_PREF, type HibernateStatsView } from '../../../shared/hibernate'
import { LAZY_RESTORE_PREF } from '../../../shared/lazy-restore'
import { __resetForTests as resetDormant, registerDormantPanesIpc } from './dormant-panes'
import { __resetHibernateForTests, registerHibernateIpc } from './hibernate'
import { registerPrefsIpc } from './prefs'

const PTY = 'pty-1'
const CC = '74f13261-5b8e-4f43-9d0e-2c5a2b1f7c11'

// Um boot do main com as prefs como estão no DB agora (a ordem do index.ts).
function boot(prefs: { lazy?: boolean; afterMin?: number }): void {
  if (prefs.lazy !== undefined) setPref(LAZY_RESTORE_PREF, prefs.lazy)
  if (prefs.afterMin !== undefined) setPref(HIBERNATE_AFTER_MIN_PREF, prefs.afterMin)
  resetDormant()
  __resetHibernateForTests()
  registerDormantPanesIpc()
  registerHibernateIpc()
  registerPrefsIpc()
}

function prefsSet(key: string, value: unknown): void {
  seam.handlers.get('prefs:set')!(null, { key, value })
}

function stats(): HibernateStatsView {
  return seam.handlers.get('sessions:hibernate-stats')!(null) as HibernateStatsView
}

const hibernator = () => getIdleHibernator()!

// Avança um intervalo do tick e diz se ele rodou (lastTickAt mudou).
async function tickRan(): Promise<boolean> {
  const before = hibernator().getStats().lastTickAt
  await vi.advanceTimersByTimeAsync(HIBERNATE_TICK_MS)
  return hibernator().getStats().lastTickAt !== before
}

beforeAll(async () => {
  seam.scan = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
})

beforeEach(() => {
  vi.useFakeTimers()
  const db = getDb()
  db.prepare('DELETE FROM app_prefs WHERE key IN (?, ?)').run(
    LAZY_RESTORE_PREF,
    HIBERNATE_AFTER_MIN_PREF,
  )
  db.exec('DELETE FROM sessions; DELETE FROM workspace_state;')
  seam.handlers.clear()
  seam.running = []
  seam.writes.length = 0
})

afterEach(() => {
  __resetHibernateForTests()
  vi.useRealTimers()
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('qualquer uma das 3 condições desligada → nenhum tick', () => {
  it('defaults (nenhuma pref gravada): desligado no boot', async () => {
    boot({})
    expect(hibernator().isScheduled()).toBe(false)
    expect(await tickRan()).toBe(false)
    expect(stats()).toMatchObject({ enabled: false, reasonDisabled: 'lazy-restore-off-at-boot' })
  })

  it('lazyRestore desligado no boot: ligar a pref ao vivo não cria tick', async () => {
    boot({ lazy: false, afterMin: 30 })
    expect(hibernator().isScheduled()).toBe(false)
    prefsSet(LAZY_RESTORE_PREF, true)
    expect(hibernator().isScheduled()).toBe(false)
    expect(await tickRan()).toBe(false)
    expect(stats()).toMatchObject({ enabled: false, reasonDisabled: 'lazy-restore-off-at-boot' })
  })

  it('hibernateAfterMin = 0 com lazyRestore ligado', async () => {
    boot({ lazy: true, afterMin: 0 })
    expect(hibernator().isScheduled()).toBe(false)
    expect(await tickRan()).toBe(false)
    expect(stats()).toMatchObject({ enabled: false, reasonDisabled: 'after-min-off' })
  })

  it('lazyRestore ao vivo desligado depois do boot para o tick', async () => {
    boot({ lazy: true, afterMin: 30 })
    expect(hibernator().isScheduled()).toBe(true)
    prefsSet(LAZY_RESTORE_PREF, false)
    expect(hibernator().isScheduled()).toBe(false)
    expect(await tickRan()).toBe(false)
    expect(stats()).toMatchObject({ enabled: false, reasonDisabled: 'lazy-restore-off' })
  })
})

describe('prefs:set religa e desliga o tick', () => {
  it('hibernateAfterMin 0 → 30 liga; 30 → 0 para', async () => {
    boot({ lazy: true, afterMin: 0 })
    prefsSet(HIBERNATE_AFTER_MIN_PREF, 30)
    expect(hibernator().isScheduled()).toBe(true)
    expect(await tickRan()).toBe(true)
    const view = stats()
    expect(view.enabled).toBe(true)
    expect(view).not.toHaveProperty('reasonDisabled')

    prefsSet(HIBERNATE_AFTER_MIN_PREF, 0)
    expect(hibernator().isScheduled()).toBe(false)
    expect(await tickRan()).toBe(false)
  })

  it('lazyRestore ao vivo false → true religa (o boot já era true)', async () => {
    boot({ lazy: true, afterMin: 30 })
    prefsSet(LAZY_RESTORE_PREF, false)
    prefsSet(LAZY_RESTORE_PREF, true)
    expect(hibernator().isScheduled()).toBe(true)
    expect(await tickRan()).toBe(true)
  })
})

describe('sessions:hibernate-stats reflete os contadores do hibernator', () => {
  it('recusa do tick e hibernação concluída pela fila real', async () => {
    boot({ lazy: true, afterMin: 30 })
    // PTY claude viva sem aba no layout salvo → o tick recusa por no-pane.
    getDb()
      .prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at, provider)
         VALUES (?, NULL, ?, NULL, 'running', ?, 'claude')`,
      )
      .run(PTY, CC, Date.now())
    seam.running = [PTY]
    expect(await tickRan()).toBe(true)

    // /exit entregue na hora pela fila real (tela ociosa reconhecida) → exit.
    expect(await hibernator().hibernate({ sessionId: PTY, ccSessionId: CC })).toBe(true)
    expect(seam.writes).toEqual([`${PTY}:/exit`])
    expect(hibernator().onExit(PTY)).toEqual({ sessionId: PTY, ccSessionId: CC, paneId: null })

    const view = stats()
    expect(view.hibernated).toBe(1)
    expect(view.refusals['no-pane']).toBe(1)
    expect(view.refusals).toEqual(hibernator().getStats().refused)
    expect(view.enabled).toBe(true)
  })
})
