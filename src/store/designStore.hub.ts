// Design hub: folders, the archived list and the hub's own view state
// (section, search, sort). Own file so designStore.ts stays the editor.

import { api } from '@/lib/ipc'
import type { DesignDocumentMeta, DesignFolder } from '@shared/types/design'
import { toMeta, upsertMeta, type DesignStore } from './designStore.internal'
import type { DesignState, HubSection, HubSort } from './designStore.types'

const HUB_PREFS_KEY = 'pitwall.design.hub'
const FIXED_SECTIONS: readonly string[] = ['recent', 'unfiled', 'archived']

interface HubPrefs {
  hubFolder: HubSection
  hubSort: HubSort
}

export function loadHubPrefs(): HubPrefs {
  const fallback: HubPrefs = { hubFolder: 'recent', hubSort: 'recent' }
  try {
    const raw = globalThis.localStorage?.getItem(HUB_PREFS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<HubPrefs>) : null
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      hubFolder: typeof parsed.hubFolder === 'string' ? parsed.hubFolder : fallback.hubFolder,
      hubSort: parsed.hubSort === 'name' ? 'name' : 'recent',
    }
  } catch {
    return fallback
  }
}

function persistHubPrefs(prefs: HubPrefs): void {
  try {
    globalThis.localStorage?.setItem(HUB_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Disabled storage: the hub just opens on Recentes next time.
  }
}

export function isFolderSection(section: HubSection): boolean {
  return !FIXED_SECTIONS.includes(section)
}

function sortFolders(list: DesignFolder[]): DesignFolder[] {
  return [...list].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pt-BR'),
  )
}

function replaceFolder(list: DesignFolder[], folder: DesignFolder): DesignFolder[] {
  return sortFolders([...list.filter((f) => f.id !== folder.id), folder])
}

function withFolder(list: DesignDocumentMeta[], docId: string, folderId: string | null) {
  return list.map((d) => (d.id === docId ? { ...d, folderId } : d))
}

// Optimistic docCount: archived documents do not count (DesignFolder.docCount).
function shiftCount(folders: DesignFolder[], from: string | null, to: string | null) {
  return folders.map((f) =>
    f.id === from
      ? { ...f, docCount: Math.max(0, f.docCount - 1) }
      : f.id === to
        ? { ...f, docCount: f.docCount + 1 }
        : f,
  )
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

type HubSlice = Pick<
  DesignState,
  | 'folders'
  | 'archivedDocs'
  | 'hubFolder'
  | 'hubQuery'
  | 'hubSort'
  | 'loadFolders'
  | 'createFolder'
  | 'renameFolder'
  | 'recolorFolder'
  | 'deleteFolder'
  | 'moveDoc'
  | 'retitleDoc'
  | 'loadArchived'
  | 'unarchiveDoc'
  | 'setHubFolder'
  | 'setHubQuery'
  | 'setHubSort'
>

export function createHubSlice(store: DesignStore): HubSlice {
  const { getState: get, setState: set } = store
  const prefs = loadHubPrefs()
  const savePrefs = () => persistHubPrefs({ hubFolder: get().hubFolder, hubSort: get().hubSort })

  return {
    folders: [],
    archivedDocs: [],
    hubFolder: prefs.hubFolder,
    hubQuery: '',
    hubSort: prefs.hubSort,

    loadFolders: async () => {
      try {
        const folders = await api.design.foldersList()
        const { hubFolder } = get()
        // A remembered folder that no longer exists falls back to Recentes.
        const gone = isFolderSection(hubFolder) && !folders.some((f) => f.id === hubFolder)
        set(gone ? { folders, hubFolder: 'recent' } : { folders })
        if (gone) savePrefs()
      } catch (err) {
        set({ error: errorText(err) })
      }
    },

    createFolder: async (name, color) => {
      const folder = await api.design.folderCreate({ name, color })
      set((s) => ({ folders: replaceFolder(s.folders, folder) }))
      return folder
    },

    renameFolder: async (id, name) => {
      const folder = await api.design.folderUpdate(id, { name })
      set((s) => ({ folders: replaceFolder(s.folders, folder) }))
    },

    recolorFolder: async (id, color) => {
      const folder = await api.design.folderUpdate(id, { color })
      set((s) => ({ folders: replaceFolder(s.folders, folder) }))
    },

    deleteFolder: async (id) => {
      await api.design.folderDelete(id)
      set((s) => ({
        folders: s.folders.filter((f) => f.id !== id),
        // Main already moved its documents out of the folder.
        docs: s.docs.map((d) => (d.folderId === id ? { ...d, folderId: null } : d)),
        archivedDocs: s.archivedDocs.map((d) => (d.folderId === id ? { ...d, folderId: null } : d)),
        doc: s.doc?.folderId === id ? { ...s.doc, folderId: null } : s.doc,
        hubFolder: s.hubFolder === id ? 'recent' : s.hubFolder,
      }))
      savePrefs()
    },

    moveDoc: async (docId, folderId) => {
      const before = get()
      const meta = [...before.docs, ...before.archivedDocs].find((d) => d.id === docId)
      if (!meta || meta.folderId === folderId) return
      const counted = meta.status === 'active'
      set((s) => ({
        docs: withFolder(s.docs, docId, folderId),
        archivedDocs: withFolder(s.archivedDocs, docId, folderId),
        doc: s.doc?.id === docId ? { ...s.doc, folderId } : s.doc,
        folders: counted ? shiftCount(s.folders, meta.folderId, folderId) : s.folders,
      }))
      try {
        await api.design.documentMove(docId, folderId)
      } catch (err) {
        set((s) => ({
          docs: withFolder(s.docs, docId, meta.folderId),
          archivedDocs: withFolder(s.archivedDocs, docId, meta.folderId),
          doc: s.doc?.id === docId ? { ...s.doc, folderId: meta.folderId } : s.doc,
          folders: counted ? shiftCount(s.folders, folderId, meta.folderId) : s.folders,
          error: `Não foi possível mover o design: ${errorText(err)}`,
        }))
      }
    },

    retitleDoc: async (docId, title) => {
      if (docId === get().docId) return get().renameDoc(title)
      const doc = await api.design.documentUpdate({ id: docId, title })
      const meta = toMeta(doc)
      set((s) =>
        meta.status === 'archived'
          ? { archivedDocs: upsertMeta(s.archivedDocs, meta) }
          : { docs: upsertMeta(s.docs, meta) },
      )
    },

    loadArchived: async () => {
      try {
        const archivedDocs = await api.design.documentsList({ status: 'archived' })
        set({ archivedDocs })
      } catch (err) {
        set({ error: errorText(err) })
      }
    },

    unarchiveDoc: async (docId) => {
      const doc = await api.design.documentUnarchive(docId)
      set((s) => ({
        archivedDocs: s.archivedDocs.filter((d) => d.id !== docId),
        docs: upsertMeta(s.docs, toMeta(doc)),
      }))
      void get().loadFolders()
    },

    setHubFolder: (hubFolder) => {
      set({ hubFolder })
      savePrefs()
    },

    setHubQuery: (hubQuery) => set({ hubQuery }),

    setHubSort: (hubSort) => {
      set({ hubSort })
      savePrefs()
    },
  }
}

// design:thumbnail-updated: only the version moves, the list is not refetched.
export function handleThumbnailUpdated(store: DesignStore, docId: string, version: string): void {
  const bump = (list: DesignDocumentMeta[]) =>
    list.some((d) => d.id === docId)
      ? list.map((d) => (d.id === docId ? { ...d, thumbnailVersion: version } : d))
      : list
  store.setState((s) => ({ docs: bump(s.docs), archivedDocs: bump(s.archivedDocs) }))
}

// design:document-updated with { moved: true }: nothing rendered changed, so
// the folder is patched in place instead of refetching the document.
export function handleDocumentMoved(
  store: DesignStore,
  docId: string,
  folderId: string | null,
): void {
  store.setState((s) => ({
    docs: withFolder(s.docs, docId, folderId),
    archivedDocs: withFolder(s.archivedDocs, docId, folderId),
    doc: s.doc?.id === docId ? { ...s.doc, folderId } : s.doc,
  }))
}
