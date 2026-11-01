/** @vitest-environment node */
// diagram_folder_* / diagram_move e o `folder` de diagram_create/list contra
// um better-sqlite3 real (tmp dir), mesmo setup de tools.test.ts.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-diagram-folders-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as diagramStore from '../diagram-store'
import { buildTools, type McpNotify, type ToolDef, type ToolResult } from './tools'
import type { DiagramFolder, DiagramMeta } from '../../../../shared/types/ipc'

const calls: Array<[string, unknown]> = []
const notify: McpNotify = {
  broadcast: (channel, payload) => calls.push([channel, payload]),
  affectedObjectives: () => {},
  affectedObjectivesForFeatureLinks: () => {},
}
let tools: ToolDef[]

async function call<T>(name: string, args: unknown): Promise<T> {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return ((await def.handler(args)) as ToolResult).structuredContent as T
}

const SKELETON = [{ id: 'a', type: 'rectangle', label: { text: 'A' } }]

async function createDiagram(title: string, folder?: string): Promise<DiagramMeta> {
  const { diagram } = await call<{ diagram: DiagramMeta }>('diagram_create', {
    title,
    summary: 'v1',
    elements: SKELETON,
    ...(folder ? { folder } : {}),
  })
  return diagram
}

beforeEach(() => {
  calls.length = 0
  tools = buildTools(notify)
  getDb().exec('DELETE FROM diagrams; DELETE FROM diagram_folders;')
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('mcp tools — diagram folders', () => {
  it('diagram_create com folder novo cria a pasta e arquiva o diagrama nela', async () => {
    const diagram = await createDiagram('Auth', 'Arquitetura')
    const { items } = await call<{ items: DiagramFolder[] }>('diagram_folder_list', {})

    expect(items).toEqual([expect.objectContaining({ name: 'Arquitetura', docCount: 1 })])
    expect(diagram.folderId).toBe(items[0].id)
    expect(calls.map(([c]) => c)).toEqual(['diagram:updated', 'diagram:folders-updated'])

    // Reaproveita sem diferenciar caixa.
    const again = await createDiagram('Billing', 'arquitetura')
    expect(again.folderId).toBe(items[0].id)
  })

  it('diagram_list filtra por nome de pasta e por null; pasta inexistente vira note', async () => {
    const inside = await createDiagram('Dentro', 'Infra')
    const loose = await createDiagram('Solto')

    const byName = await call<{ items: DiagramMeta[] }>('diagram_list', { folder: 'INFRA' })
    expect(byName.items.map((d) => d.id)).toEqual([inside.id])
    const unfiled = await call<{ items: DiagramMeta[] }>('diagram_list', { folder: null })
    expect(unfiled.items.map((d) => d.id)).toEqual([loose.id])
    const all = await call<{ items: Array<DiagramMeta & { thumbnail?: unknown }> }>('diagram_list', {})
    expect(all.items).toHaveLength(2)
    expect(all.items.every((d) => !('thumbnail' in d))).toBe(true)
    expect(await call('diagram_list', { folder: 'Nope' })).toEqual({
      items: [],
      note: 'no folder named "Nope"',
    })
  })

  it('diagram_move arquiva por nome (criando), tira com null e não bumpa versão nem updatedAt', async () => {
    const d = await createDiagram('Mover')
    calls.length = 0

    const { diagram } = await call<{ diagram: DiagramMeta }>('diagram_move', {
      diagramId: d.id,
      folder: 'Backlog',
    })
    const folder = diagramStore.findFolderByName('backlog')!
    expect(diagram).toMatchObject({ folderId: folder.id, version: d.version, updatedAt: d.updatedAt })
    expect(calls.map(([c]) => c)).toEqual(['diagram:updated', 'diagram:folders-updated'])

    const out = await call<{ diagram: DiagramMeta }>('diagram_move', { diagramId: d.id, folder: null })
    expect(out.diagram.folderId).toBeNull()
    await expect(call('diagram_move', { diagramId: 'nope', folder: null })).rejects.toThrow(
      /diagram not found/,
    )
  })

  it('diagram_move com id inexistente não cria a pasta', async () => {
    await expect(call('diagram_move', { diagramId: 'nope', folder: 'Fantasma' })).rejects.toThrow(
      /diagram not found/,
    )
    const { items } = await call<{ items: Array<{ name: string }> }>('diagram_folder_list', {})
    expect(items.map((f) => f.name)).not.toContain('Fantasma')
  })

  it('diagram_folder_create não duplica nome existente e aceita cor', async () => {
    const first = await call<{ folder: DiagramFolder; created: boolean }>('diagram_folder_create', {
      name: 'Fluxos',
      color: 'success',
    })
    const dup = await call<{ folder: DiagramFolder; created: boolean }>('diagram_folder_create', {
      name: 'fluxos',
    })

    expect(first).toMatchObject({ created: true, folder: { name: 'Fluxos', color: 'success' } })
    expect(dup).toMatchObject({ created: false, folder: { id: first.folder.id } })
    expect(calls).toEqual([['diagram:folders-updated', { folderId: first.folder.id }]])
  })

  it('diagram_folder_rename por nome ou id; cor null limpa; exige name ou color', async () => {
    const { folder } = await call<{ folder: DiagramFolder }>('diagram_folder_create', {
      name: 'Velho',
      color: 'info',
    })

    const renamed = await call<{ folder: DiagramFolder }>('diagram_folder_rename', {
      folder: 'velho',
      name: 'Novo',
    })
    expect(renamed.folder).toMatchObject({ id: folder.id, name: 'Novo', color: 'info' })
    const cleared = await call<{ folder: DiagramFolder }>('diagram_folder_rename', {
      folder: folder.id,
      color: null,
    })
    expect(cleared.folder.color).toBeNull()
    await expect(call('diagram_folder_rename', { folder: folder.id })).rejects.toThrow()
    await expect(call('diagram_folder_rename', { folder: 'x', name: 'y' })).rejects.toThrow(
      /folder not found/,
    )
  })

  it('diagram_folder_delete deixa os diagramas sem pasta (inclusive arquivados)', async () => {
    const active = await createDiagram('Ativo', 'Temp')
    const archived = await createDiagram('Arquivado', 'Temp')
    diagramStore.archive(archived.id)
    calls.length = 0

    const out = await call('diagram_folder_delete', { folder: 'temp' })

    expect(out).toMatchObject({ deleted: true, name: 'Temp', unfiled: 1 })
    expect(diagramStore.get(active.id)!.folderId).toBeNull()
    expect(diagramStore.get(archived.id)!.folderId).toBeNull()
    expect(diagramStore.listFolders()).toEqual([])
    expect(calls).toEqual([['diagram:folders-updated', { folderId: null }]])
  })
})
