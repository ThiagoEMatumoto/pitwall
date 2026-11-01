// Folder CRUD tools shared by the design hub (design_folder_*) and the
// diagrams hub (diagram_folder_*). Both sit on folder-store-core, so the tools
// are the same four verbs with a different prefix and broadcast channel.
//
// Deleting a folder is not destructive: the items it held go back to "no
// folder" (ON DELETE SET NULL), nothing else is lost.

import * as z from 'zod/v4'
import type { createFolderStore, HubFolder } from '../folder-store-core'
import { ok, type ToolDef } from './tools'

type FolderStore = Pick<
  ReturnType<typeof createFolderStore>,
  'listFolders' | 'getFolder' | 'findFolderByName' | 'createFolder' | 'updateFolder' | 'deleteFolder'
>

export interface FolderToolsConfig {
  prefix: 'design' | 'diagram'
  // Plural shown in descriptions: "documents", "diagrams".
  items: string
  store: FolderStore
  // Broadcast after every mutation; folderId = the folder touched, null when
  // only counts/assignments moved (delete).
  onChange: (folderId: string | null) => void
}

const folderName = z.string().trim().min(1).max(200)
const folderColor = z.string().trim().max(64).nullable()
const folderRef = z.string().trim().min(1)

const createSchema = z.object({ name: folderName, color: folderColor.optional() })
const renameSchema = z
  .object({ folder: folderRef, name: folderName.optional(), color: folderColor.optional() })
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: 'provide name and/or color',
  })
const deleteSchema = z.object({ folder: folderRef })

const COLOR_HINT =
  'color is a theme key (accent | accent2 | info | success | warning | danger, follows the theme) or any CSS color; null clears it.'

// A folder is addressed by id or by name (case-insensitive): agents usually
// know the name the human said, not the uuid.
export function resolveFolder(store: FolderStore, ref: string): HubFolder {
  const folder = store.getFolder(ref) ?? store.findFolderByName(ref)
  if (!folder) throw new Error(`folder not found: "${ref}" (see the folder_list tool)`)
  return folder
}

export function folderListTool({ prefix, items, store }: FolderToolsConfig): ToolDef {
  return {
    name: `${prefix}_folder_list`,
    title: `List ${prefix} folders`,
    description: `List the folders of the ${prefix} hub (one level, no nesting) with how many active ${items} each holds (docCount).`,
    inputSchema: z.object({}),
    handler: () => ok({ items: store.listFolders() }),
  }
}

export function folderCrudTools({ prefix, items, store, onChange }: FolderToolsConfig): ToolDef[] {
  return [
    {
      name: `${prefix}_folder_create`,
      title: `Create ${prefix} folder`,
      description: `Create a folder in the ${prefix} hub (one level). Reuse an existing folder with the same name instead of creating a near-duplicate — ${prefix}_folder_list shows them. ${COLOR_HINT}`,
      inputSchema: createSchema,
      handler: (args) => {
        const { name, color } = createSchema.parse(args)
        const existing = store.findFolderByName(name)
        if (existing) return ok({ folder: existing, created: false })
        const folder = store.createFolder({ name, color })
        onChange(folder.id)
        return ok({ folder, created: true })
      },
    },
    {
      name: `${prefix}_folder_rename`,
      title: `Rename / recolor ${prefix} folder`,
      description: `Rename and/or recolor a ${prefix} folder. folder = its id or current name (case-insensitive). ${COLOR_HINT}`,
      inputSchema: renameSchema,
      handler: (args) => {
        const { folder: ref, name, color } = renameSchema.parse(args)
        const current = resolveFolder(store, ref)
        const folder = store.updateFolder(current.id, { name, color })
        onChange(folder.id)
        return ok({ folder })
      },
    },
    {
      name: `${prefix}_folder_delete`,
      title: `Delete ${prefix} folder`,
      description: `Delete a ${prefix} folder (id or name). Not destructive: its ${items} stay and become "no folder". Returns how many active ${items} were unfiled.`,
      inputSchema: deleteSchema,
      handler: (args) => {
        const { folder: ref } = deleteSchema.parse(args)
        const folder = resolveFolder(store, ref)
        store.deleteFolder(folder.id)
        onChange(null)
        return ok({ id: folder.id, name: folder.name, deleted: true, unfiled: folder.docCount })
      },
    },
  ]
}
