import { createFolderStore } from '../folder-store-core'
import { getDocumentRow } from './design-rows'

// Folders of the design hub. Deleting one leaves its documents without a
// folder through the ON DELETE SET NULL of migration 065. The SQL is shared
// with the diagrams hub (folder-store-core).

const store = createFolderStore({
  folderTable: 'design_folders',
  itemTable: 'design_documents',
  label: 'design folder',
})

export const {
  listFolders,
  getFolder,
  findFolderByName,
  createFolder,
  ensureFolder,
  updateFolder,
  deleteFolder,
  assertFolderExists,
} = store

export function moveDocument(docId: string, folderId: string | null): void {
  if (!getDocumentRow(docId)) throw new Error(`design document not found: ${docId}`)
  store.setItemFolder(docId, folderId)
}
