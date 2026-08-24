import { ipcMain } from 'electron'
import * as diagramStore from '../services/diagram-store'
import { broadcast } from '../services/notify'
import type {
  CreateDiagramInput,
  Diagram,
  DiagramAuthor,
  DiagramLink,
  DiagramListFilter,
  DiagramMeta,
  DiagramVersion,
  DiagramVersionMeta,
  UpdateDiagramSceneInput,
} from '../../../shared/types/ipc'

// IPC de diagramas. Molde de ipc/content-contracts: handlers finos (a regra
// mora no store) e broadcast em cada mutação pro renderer recarregar.
//
// `delete` aqui é direto (force:true no store): a UI já confirma com o usuário
// antes de chamar. O two-step archive→delete é regra do MCP, que usa
// force:false — agente não recebe diálogo de confirmação.
export function registerDiagramsIpc(): void {
  ipcMain.handle('diagrams:list', (_e, filter?: DiagramListFilter): DiagramMeta[] => {
    return diagramStore.list(filter)
  })

  ipcMain.handle('diagrams:get', (_e, id: string): Diagram | null => {
    return diagramStore.get(id)
  })

  ipcMain.handle('diagrams:create', (_e, input: CreateDiagramInput): Diagram => {
    const diagram = diagramStore.create(input)
    broadcast('diagram:updated', diagram)
    return diagram
  })

  // author default 'human': quem chama este canal é a UI. O MCP declara
  // 'claude' explicitamente pelo caminho dele.
  ipcMain.handle('diagrams:update-scene', (_e, input: UpdateDiagramSceneInput): Diagram => {
    const diagram = diagramStore.updateScene({ ...input, author: input.author ?? 'human' })
    broadcast('diagram:updated', diagram)
    return diagram
  })

  ipcMain.handle('diagrams:rename', (_e, id: string, title: string): Diagram => {
    const diagram = diagramStore.rename(id, title)
    broadcast('diagram:updated', diagram)
    return diagram
  })

  ipcMain.handle('diagrams:archive', (_e, id: string): Diagram => {
    const diagram = diagramStore.archive(id)
    broadcast('diagram:updated', diagram)
    return diagram
  })

  ipcMain.handle('diagrams:unarchive', (_e, id: string): Diagram => {
    const diagram = diagramStore.unarchive(id)
    broadcast('diagram:updated', diagram)
    return diagram
  })

  ipcMain.handle('diagrams:delete', (_e, id: string): void => {
    diagramStore.remove(id, { force: true })
    broadcast('diagram:deleted', { id })
  })

  ipcMain.handle('diagrams:link', (_e, input: DiagramLink): DiagramLink[] => {
    const links = diagramStore.link(input)
    broadcast('diagramLinks:updated', { diagramId: input.diagramId, links })
    return links
  })

  ipcMain.handle('diagrams:unlink', (_e, input: DiagramLink): DiagramLink[] => {
    const links = diagramStore.unlink(input)
    broadcast('diagramLinks:updated', { diagramId: input.diagramId, links })
    return links
  })

  ipcMain.handle('diagrams:list-versions', (_e, diagramId: string): DiagramVersionMeta[] => {
    return diagramStore.listVersions(diagramId)
  })

  ipcMain.handle(
    'diagrams:get-version',
    (_e, diagramId: string, version: number): DiagramVersion | null => {
      return diagramStore.getVersion(diagramId, version)
    },
  )

  ipcMain.handle(
    'diagrams:restore-version',
    (_e, diagramId: string, version: number, author?: DiagramAuthor): Diagram => {
      const diagram = diagramStore.restoreVersion(diagramId, version, author ?? 'human')
      broadcast('diagram:updated', diagram)
      return diagram
    },
  )

  // Thumbnail muda o card da lista → broadcast com o Diagram completo, mesmo
  // canal das demais mutações (o renderer trata como sinal de recarga).
  ipcMain.handle('diagrams:set-thumbnail', (_e, id: string, dataUrl: string): void => {
    diagramStore.setThumbnail(id, dataUrl)
    const diagram = diagramStore.get(id)
    if (diagram) broadcast('diagram:updated', diagram)
  })
}
