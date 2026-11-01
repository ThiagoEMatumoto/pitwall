import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Store REAL + persister REAL + app.db REAL (migrations de produção) + localizador
// de transcript REAL num HOME temporário: o window.api só transporta para os
// serviços do main, como o IPC.
vi.mock('electron', () => ({ app: {} }))

const home = mkdtempSync(join(tmpdir(), 'cm-draft-life-home-'))
process.env.HOME = home

const { openAppDb } = await import('../../electron/main/services/db')
const drafts = await import('../../electron/main/services/composer-drafts')
const { composerDraftKey, createDraftPersister } =
  await import('@/features/sessions/composer-draft-persister')

const dir = mkdtempSync(join(tmpdir(), 'cm-draft-life-'))
const db: Database.Database = openAppDb(join(dir, 'app.db'))

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const DAY = 24 * 60 * 60 * 1000
const UNDO_EXPIRES_MS = 5000 + 750
const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }

function writeTranscript(cc: string) {
  const projectDir = join(home, '.claude', 'projects', '-tmp-infra')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${cc}.jsonl`), '{"type":"user"}\n')
}

let bootState = {
  openPanes: [] as unknown[],
  cleanShutdown: true,
  restoreAttempts: 0,
  dockLayout: null,
}
const calls = { gc: 0, kill: [] as string[] }

const sessionsImpl: Record<string, (...args: never[]) => unknown> = {
  listLiveGlobal: () => Promise.resolve([]),
  restorePlan: () => Promise.resolve({ mode: 'lazy', eagerCcSessionIds: [] }),
  isResumable: () => Promise.resolve(true),
  dormantSync: (list: unknown[]) => Promise.resolve(list),
  getDraft: async (key: string) => drafts.getComposerDraft(db, key),
  getDraftSync: (key: string) => drafts.getComposerDraft(db, key),
  saveDraft: async (d: Parameters<typeof drafts.saveComposerDraft>[1]) =>
    drafts.saveComposerDraft(db, d),
  saveDraftSync: (d: Parameters<typeof drafts.saveComposerDraft>[1]) =>
    drafts.saveComposerDraft(db, d),
  writeDraft: (d: Parameters<typeof drafts.saveComposerDraft>[1]) =>
    drafts.saveComposerDraftsFast(db, [d]),
  clearDraft: async (key: string) => drafts.clearComposerDraft(db, key),
  adoptDraft: async (t: Parameters<typeof drafts.adoptComposerDraft>[1]) =>
    drafts.adoptComposerDraft(db, t),
  clearSessionDrafts: async (t: Parameters<typeof drafts.clearSessionDrafts>[1]) =>
    drafts.clearSessionDrafts(db, t),
  gcDrafts: async (panes: Parameters<typeof drafts.gcComposerDraftsAfterRestore>[1]) => {
    calls.gc++
    return drafts.gcComposerDraftsAfterRestore(db, panes)
  },
  kill: async (id: string) => {
    calls.kill.push(id)
  },
}

function savePanes(panes: unknown[]) {
  db.prepare(
    `INSERT INTO workspace_state (id, open_panes, last_opened_at) VALUES (1, ?, 0)
     ON CONFLICT(id) DO UPDATE SET open_panes = excluded.open_panes`,
  ).run(JSON.stringify(panes))
}

Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => {
              const impl =
                ns === 'sessions' && typeof prop === 'string' ? sessionsImpl[prop] : undefined
              return (...args: unknown[]) => {
                if (impl) return (impl as (...a: unknown[]) => unknown)(...args)
                if (ns === 'workspace' && prop === 'savePanes') {
                  savePanes(args[0] as unknown[])
                  return Promise.resolve()
                }
                if (ns === 'workspace' && prop === 'getBootState') return Promise.resolve(bootState)
                if (ns === 'sessions' && prop === 'list') return Promise.resolve([])
                if (typeof prop === 'string' && prop.startsWith('on')) return () => {}
                return Promise.resolve()
              }
            },
          },
        ),
    },
  ),
})

// Módulo novo a cada teste: o restore tem guarda de uma execução por processo.
async function freshStore() {
  vi.resetModules()
  const { useAppStore } = await import('./appStore')
  useAppStore.setState({ panes: [], lazyRestore: true })
  return useAppStore
}

function persisterFor(paneId: string, cc: string) {
  return createDraftPersister({
    key: composerDraftKey(paneId, cc),
    ccSessionId: cc,
    paneId,
    api: {
      get: sessionsImpl.getDraft as never,
      getSync: sessionsImpl.getDraftSync as never,
      save: sessionsImpl.saveDraft as never,
      saveSync: sessionsImpl.saveDraftSync as never,
      writeThrough: sessionsImpl.writeDraft as never,
      clear: sessionsImpl.clearDraft as never,
    },
  })
}

async function typeDraft(paneId: string, cc: string, text: string) {
  const p = persisterFor(paneId, cc)
  await p.hydrate(() => {})
  p.update({ text, attachments: [] })
  p.dispose() // desmonte da pane: grava síncrono
}

async function hydratedText(paneId: string, cc: string): Promise<string | null> {
  const p = persisterFor(paneId, cc)
  let text: string | null = null
  await p.hydrate((d) => (text = d.text))
  p.dispose()
  return text
}

function liveItem(cc: string) {
  return {
    id: `sess-${cc}`,
    ccSessionId: cc,
    repo,
    projectName: 'Infra',
    projectIcon: null,
    projectColor: null,
    title: null,
    name: null,
    status: 'idle',
  } as never
}

const snap = (cc: string, paneId: string) => ({
  ccSessionId: cc,
  paneId,
  repo,
  projectName: 'Infra',
  projectIcon: null,
  projectColor: null,
})

function closedDraft(paneId: string, cc: string, ageMs: number) {
  const key = `pane:${paneId}`
  drafts.saveComposerDraft(
    db,
    { key, ccSessionId: cc, paneId, text: `rascunho ${paneId}`, attachments: [] },
    Date.now() - ageMs,
  )
  return key
}

beforeEach(() => {
  vi.useRealTimers()
  db.prepare('DELETE FROM composer_drafts').run()
  db.prepare('DELETE FROM workspace_state').run()
  rmSync(join(home, '.claude'), { recursive: true, force: true })
  calls.gc = 0
  calls.kill = []
})

describe('GC × restore', () => {
  it('restore bloqueado (crash-loop): o GC não roda e o rascunho das panes bloqueadas fica', async () => {
    // Pane bloqueada fora do store, sem transcript e velha: o GC a apagaria.
    const key = closedDraft('p-blocked', 'cc-blocked', 10 * DAY)
    bootState = {
      openPanes: [snap('cc-blocked', 'p-blocked')],
      cleanShutdown: false,
      restoreAttempts: 2,
      dockLayout: null,
    }
    const store = await freshStore()
    await store.getState().restoreWorkspace()
    await new Promise((r) => setTimeout(r, 20))

    expect(store.getState().restoreBlocked).toBe(true)
    expect(calls.gc).toBe(0)
    expect(drafts.getComposerDraft(db, key)?.text).toBe('rascunho p-blocked')
  })

  it('restore bem-sucedido aciona o GC: some o órfão sem transcript, ficam o da pane restaurada e o com transcript', async () => {
    writeTranscript('cc-closed')
    const restored = closedDraft('p-restored', 'cc-restored', 40 * DAY)
    const withTranscript = closedDraft('p-closed', 'cc-closed', 10 * DAY)
    const orphan = closedDraft('p-orphan', 'cc-orphan', 10 * DAY)
    bootState = {
      openPanes: [snap('cc-restored', 'p-restored')],
      cleanShutdown: true,
      restoreAttempts: 0,
      dockLayout: null,
    }
    const store = await freshStore()
    await store.getState().restoreWorkspace()
    await vi.waitFor(() => expect(calls.gc).toBe(1))

    expect(store.getState().panes.map((p) => p.paneId)).toEqual(['p-restored'])
    expect(drafts.getComposerDraft(db, restored)).not.toBeNull()
    expect(drafts.getComposerDraft(db, withTranscript)).not.toBeNull()
    expect(drafts.getComposerDraft(db, orphan)).toBeNull()
  })
})

describe('fechar pane VIVA × rascunho', () => {
  it('fechar → janela expira → reabrir pela lista: o rascunho aparece na pane nova', async () => {
    vi.useFakeTimers()
    const store = await freshStore()
    await store.getState().focusOrOpenSession(liveItem('cc-live'))
    const [first] = store.getState().panes
    await typeDraft(first.paneId, 'cc-live', 'trabalho da pane viva')

    store.getState().closePane(first.paneId)
    await vi.advanceTimersByTimeAsync(UNDO_EXPIRES_MS * 2)
    expect(drafts.getComposerDraft(db, `pane:${first.paneId}`)?.text).toBe('trabalho da pane viva')

    await store.getState().focusOrOpenSession(liveItem('cc-live'))
    const [reopened] = store.getState().panes
    expect(reopened.paneId).not.toBe(first.paneId)
    expect(await hydratedText(reopened.paneId, 'cc-live')).toBe('trabalho da pane viva')
    // Migrou: a chave velha não fica duplicada.
    expect(drafts.getComposerDraft(db, `pane:${first.paneId}`)).toBeNull()
  })

  it('reabrir em grade também herda o rascunho', async () => {
    vi.useFakeTimers()
    const store = await freshStore()
    const old = closedDraft('p-old', 'cc-grid', 1000)
    await store.getState().openSessionsInGrid([liveItem('cc-grid'), liveItem('cc-other')])
    const pane = store.getState().panes.find((p) => p.session.ccSessionId === 'cc-grid')!
    expect(await hydratedText(pane.paneId, 'cc-grid')).toBe('rascunho p-old')
    expect(drafts.getComposerDraft(db, old)).toBeNull()
  })

  it('não rouba o rascunho de outra pane da mesma conversa que segue aberta', async () => {
    vi.useFakeTimers()
    const store = await freshStore()
    await store.getState().focusOrOpenSession(liveItem('cc-twin'))
    const [open] = store.getState().panes
    await typeDraft(open.paneId, 'cc-twin', 'da pane aberta')
    const adopted = await drafts.adoptComposerDraft(db, {
      paneId: 'p-new',
      ccSessionId: 'cc-twin',
      openPaneIds: [open.paneId],
    })
    expect(adopted).toBeNull()
    expect(await hydratedText(open.paneId, 'cc-twin')).toBe('da pane aberta')
  })

  it('Encerrar confirmado: os rascunhos da conversa são apagados depois do kill', async () => {
    vi.useFakeTimers()
    const store = await freshStore()
    await store.getState().focusOrOpenSession(liveItem('cc-end'))
    const [pane] = store.getState().panes
    await typeDraft(pane.paneId, 'cc-end', 'vai embora no fim')
    const closedEarlier = closedDraft('p-earlier', 'cc-end', 1000)
    const otherConversation = closedDraft('p-other', 'cc-keep', 1000)

    store.getState().endSession(pane.session.id)
    await vi.advanceTimersByTimeAsync(UNDO_EXPIRES_MS - 1)
    expect(drafts.getComposerDraft(db, `pane:${pane.paneId}`)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)

    expect(calls.kill).toEqual([pane.session.id])
    expect(drafts.getComposerDraft(db, `pane:${pane.paneId}`)).toBeNull()
    expect(drafts.getComposerDraft(db, closedEarlier)).toBeNull()
    expect(drafts.getComposerDraft(db, otherConversation)).not.toBeNull()
  })

  it('Encerrar desfeito: o rascunho fica', async () => {
    vi.useFakeTimers()
    const store = await freshStore()
    await store.getState().focusOrOpenSession(liveItem('cc-undo-end'))
    const [pane] = store.getState().panes
    await typeDraft(pane.paneId, 'cc-undo-end', 'fica')

    store.getState().endSession(pane.session.id)
    store.getState().undoEndSession(pane.session.id)
    await vi.advanceTimersByTimeAsync(UNDO_EXPIRES_MS * 2)

    expect(calls.kill).toEqual([])
    expect(drafts.getComposerDraft(db, `pane:${pane.paneId}`)?.text).toBe('fica')
  })
})
