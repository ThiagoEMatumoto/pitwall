import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Store REAL + persister REAL + app.db REAL (migrations de produção): o window.api
// só transporta para os serviços do main, como o IPC.
vi.mock('electron', () => ({ app: {} }))

const { openAppDb } = await import('../../electron/main/services/db')
const { clearComposerDraft, gcComposerDraftsAtBoot, getComposerDraft, saveComposerDraft } =
  await import('../../electron/main/services/composer-drafts')

const dir = mkdtempSync(join(tmpdir(), 'cm-store-draft-'))
let db: Database.Database = openAppDb(join(dir, 'app.db'))

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Mesmo SQL do workspace:save-panes / get-boot-state.
function savePanes(panes: unknown[]) {
  db.prepare(
    `INSERT INTO workspace_state (id, open_panes, last_opened_at) VALUES (1, ?, 0)
     ON CONFLICT(id) DO UPDATE SET open_panes = excluded.open_panes`,
  ).run(JSON.stringify(panes))
}
function openPanes(): Array<{ ccSessionId: string; paneId?: string }> {
  const row = db.prepare('SELECT open_panes FROM workspace_state WHERE id = 1').get() as
    { open_panes: string | null } | undefined
  return row?.open_panes ? JSON.parse(row.open_panes) : []
}

const sessionsImpl: Record<string, (...args: never[]) => unknown> = {
  listLiveGlobal: () => Promise.resolve([]),
  restorePlan: () => Promise.resolve({ mode: 'lazy', eagerCcSessionIds: [] }),
  isResumable: () => Promise.resolve(true),
  dormantSync: (list: unknown[]) => Promise.resolve(list),
  getDraft: async (key: string) => getComposerDraft(db, key),
  getDraftSync: (key: string) => getComposerDraft(db, key),
  saveDraft: async (d: Parameters<typeof saveComposerDraft>[1]) => saveComposerDraft(db, d),
  saveDraftSync: (d: Parameters<typeof saveComposerDraft>[1]) => saveComposerDraft(db, d),
  clearDraft: async (key: string) => clearComposerDraft(db, key),
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

const { useAppStore } = await import('./appStore')
const { useToastStore } = await import('@/features/notifications/toast-store')
const { composerDraftKey, createDraftPersister } =
  await import('@/features/sessions/composer-draft-persister')

const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }
const snapNoPaneId = (cc: string) => ({
  ccSessionId: cc,
  repo,
  projectName: 'Infra',
  projectIcon: null,
  projectColor: null,
})

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

async function restoreDormant(snaps: unknown[]) {
  await useAppStore.getState().restoreSnapshots(snaps as never)
  await vi.advanceTimersByTimeAsync(600) // debounce do save do open_panes
}

const UNDO_EXPIRES_MS = 5000 + 750

beforeEach(() => {
  vi.useFakeTimers()
  db.prepare('DELETE FROM composer_drafts').run()
  useAppStore.setState({ panes: [], lazyRestore: true })
  useToastStore.setState({ toasts: [] })
})

describe('fechar a pane × rascunho', () => {
  async function paneWithDraft(cc: string, text: string) {
    await restoreDormant([snapNoPaneId(cc)])
    const pane = useAppStore.getState().panes.find((p) => p.session.ccSessionId === cc)!
    await typeDraft(pane.paneId, cc, text)
    return pane.paneId
  }

  it('fechar → Desfazer: a pane volta com o mesmo paneId e o rascunho junto', async () => {
    const paneId = await paneWithDraft('cc-undo', 'não pode sumir')
    useAppStore.getState().closePane(paneId)
    expect(useAppStore.getState().panes).toHaveLength(0)
    // Durante a janela, o rascunho segue no banco.
    expect(getComposerDraft(db, `pane:${paneId}`)?.text).toBe('não pode sumir')

    await vi.advanceTimersByTimeAsync(2000)
    const toast = useToastStore.getState().toasts.find((t) => t.actionLabel === 'Desfazer')!
    toast.onAction!()
    await vi.advanceTimersByTimeAsync(UNDO_EXPIRES_MS * 2)

    expect(useAppStore.getState().panes.map((p) => p.paneId)).toEqual([paneId])
    expect(getComposerDraft(db, `pane:${paneId}`)?.text).toBe('não pode sumir')
    expect(await hydratedText(paneId, 'cc-undo')).toBe('não pode sumir')
  })

  it('fechar → janela expira sem desfazer: o rascunho é apagado', async () => {
    const paneId = await paneWithDraft('cc-expire', 'rascunho da aba fechada')
    useAppStore.getState().closePane(paneId)

    await vi.advanceTimersByTimeAsync(UNDO_EXPIRES_MS - 1)
    expect(getComposerDraft(db, `pane:${paneId}`)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(getComposerDraft(db, `pane:${paneId}`)).toBeNull()
  })

  it('a expiração não apaga se a pane voltou por outro caminho', async () => {
    const paneId = await paneWithDraft('cc-back', 'voltou')
    const pane = useAppStore.getState().panes[0]
    useAppStore.getState().closePane(paneId)
    useAppStore.setState({ panes: [pane] })
    await vi.advanceTimersByTimeAsync(UNDO_EXPIRES_MS)
    expect(getComposerDraft(db, `pane:${paneId}`)?.text).toBe('voltou')
  })
})

describe('paneId estável', () => {
  it('duas panes da mesma conversa têm rascunhos independentes', async () => {
    await restoreDormant([snapNoPaneId('cc-dup'), snapNoPaneId('cc-dup')])
    const ids = useAppStore.getState().panes.map((p) => p.paneId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).not.toContain('cc-dup')

    await typeDraft(ids[0], 'cc-dup', 'rascunho da primeira')
    await typeDraft(ids[1], 'cc-dup', 'rascunho da segunda')
    expect(await hydratedText(ids[0], 'cc-dup')).toBe('rascunho da primeira')
    expect(await hydratedText(ids[1], 'cc-dup')).toBe('rascunho da segunda')
  })

  it('o paneId gerado vai para o open_panes e sobrevive ao reboot com o rascunho', async () => {
    await restoreDormant([snapNoPaneId('cc-reboot')])
    const [generated] = useAppStore.getState().panes.map((p) => p.paneId)
    expect(openPanes()).toEqual([
      expect.objectContaining({ ccSessionId: 'cc-reboot', paneId: generated }),
    ])
    await typeDraft(generated, 'cc-reboot', 'sobrevive ao reboot')

    // Reboot: banco reaberto, GC do boot, store vazio restaurando do open_panes.
    db.close()
    db = openAppDb(join(dir, 'app.db'))
    gcComposerDraftsAtBoot(db, Date.now() + 30 * 24 * 60 * 60 * 1000)
    useAppStore.setState({ panes: [] })
    await restoreDormant(openPanes())

    expect(useAppStore.getState().panes.map((p) => p.paneId)).toEqual([generated])
    expect(await hydratedText(generated, 'cc-reboot')).toBe('sobrevive ao reboot')
  })
})
