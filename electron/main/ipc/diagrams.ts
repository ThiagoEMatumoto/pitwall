import { ipcMain } from 'electron'
import * as diagramStore from '../services/diagram-store'
import * as libraryStore from '../services/diagram-library-store'
import {
  installCatalogLibrary,
  installedCatalogIds,
  installLibraryFromUrl,
  removeCatalogLibrary,
} from '../services/diagram-library-install'
import { DIAGRAM_LIBRARY_CATALOG } from '../../../shared/diagram-library-catalog'
import { broadcast } from '../services/notify'
import { requireDiagramTemplate, templateScene } from '../services/diagram-template-scene'
import type {
  CreateDiagramFolderInput,
  CreateDiagramInput,
  Diagram,
  DiagramAuthor,
  DiagramFolder,
  DiagramLibraryCatalogState,
  DiagramLibraryItem,
  DiagramLink,
  DiagramListFilter,
  DiagramMeta,
  DiagramVersion,
  DiagramVersionMeta,
  InstallDiagramLibraryResult,
  UpdateDiagramFolderInput,
  UpdateDiagramSceneInput,
} from '../../../shared/types/ipc'

// Thumbnail é preview de card, não imagem full-res: dataUrl maior que isso
// indica bug no gerador do renderer.
const MAX_THUMBNAIL_DATAURL_BYTES = 512 * 1024

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

  // "Novo a partir de modelo": o layout ELK só roda no main.
  ipcMain.handle(
    'diagrams:create-from-template',
    async (_e, templateId: string): Promise<Diagram> => {
      const template = requireDiagramTemplate(templateId)
      const diagram = diagramStore.create({
        title: template.name,
        kind: template.kind,
        scene: await templateScene(template),
        sourceFormat: 'skeleton',
        source: JSON.stringify(template.skeleton),
        author: 'human',
        summary: `criado a partir do modelo ${template.name}`,
      })
      broadcast('diagram:updated', diagram)
      return diagram
    },
  )

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
  // O gerador do thumbnail no renderer é v2 — a superfície (id + dataUrl)
  // deste canal é mantida deliberadamente; o cap protege o banco enquanto isso.
  ipcMain.handle('diagrams:set-thumbnail', (_e, id: string, dataUrl: string): void => {
    if (dataUrl.length > MAX_THUMBNAIL_DATAURL_BYTES) {
      throw new Error(
        `thumbnail dataUrl excede o limite de 512 KB (recebido ${dataUrl.length} bytes)`,
      )
    }
    diagramStore.setThumbnail(id, dataUrl)
    const diagram = diagramStore.get(id)
    if (diagram) broadcast('diagram:updated', diagram)
  })

  // ---- pastas do hub ----
  // Toda mutação de pasta (e todo move, que muda as contagens) emite
  // diagram:folders-updated; o renderer recarrega a lista de pastas.

  const foldersUpdated = (folderId: string | null) =>
    broadcast('diagram:folders-updated', { folderId })

  ipcMain.handle('diagrams:folders-list', (): DiagramFolder[] => diagramStore.listFolders())

  ipcMain.handle('diagrams:folder-create', (_e, input: CreateDiagramFolderInput): DiagramFolder => {
    const folder = diagramStore.createFolder(input)
    foldersUpdated(folder.id)
    return folder
  })

  ipcMain.handle(
    'diagrams:folder-update',
    (_e, id: string, input: UpdateDiagramFolderInput): DiagramFolder => {
      const folder = diagramStore.updateFolder(id, input)
      foldersUpdated(id)
      return folder
    },
  )

  // Os diagramas da pasta voltam pra "sem pasta" no schema; o renderer
  // recarrega a lista para refletir o folderId novo.
  ipcMain.handle('diagrams:folder-delete', (_e, id: string): void => {
    diagramStore.deleteFolder(id)
    foldersUpdated(null)
  })

  ipcMain.handle('diagrams:move', (_e, id: string, folderId: string | null): Diagram => {
    const diagram = diagramStore.move(id, folderId ?? null)
    broadcast('diagram:updated', diagram)
    foldersUpdated(null)
    return diagram
  })

  // ---- biblioteca de shapes (.excalidrawlib) ----
  // Global (uma por app); todo write broadcasta o conjunto completo — o
  // renderer aplica via updateLibrary no editor aberto.

  ipcMain.handle('diagrams:library-get', (): DiagramLibraryItem[] => {
    return libraryStore.getItems()
  })

  // Caminho do onLibraryChange do editor: o Excalidraw manda a biblioteca
  // inteira, já na ordem do painel.
  ipcMain.handle(
    'diagrams:library-replace',
    (_e, items: DiagramLibraryItem[]): DiagramLibraryItem[] => {
      const saved = libraryStore.replaceAll(items)
      broadcast('diagramLibrary:updated', { items: saved })
      return saved
    },
  )

  ipcMain.handle('diagrams:library-remove', (_e, id: string): DiagramLibraryItem[] => {
    const items = libraryStore.removeItem(id)
    broadcast('diagramLibrary:updated', { items })
    return items
  })

  // Fetch no MAIN (CSP do renderer não alcança domínio arbitrário); timeout
  // 15s + cap 5MB moram no serviço de instalação.
  ipcMain.handle(
    'diagrams:library-install-url',
    async (_e, url: string): Promise<InstallDiagramLibraryResult> => {
      const result = await installLibraryFromUrl(url)
      broadcast('diagramLibrary:updated', { items: result.items })
      return result
    },
  )

  ipcMain.handle('diagrams:library-catalog', (): DiagramLibraryCatalogState => {
    return { entries: [...DIAGRAM_LIBRARY_CATALOG], installedIds: installedCatalogIds() }
  })

  ipcMain.handle(
    'diagrams:library-install-catalog',
    async (_e, catalogId: string): Promise<InstallDiagramLibraryResult> => {
      const result = await installCatalogLibrary(catalogId)
      broadcast('diagramLibrary:updated', { items: result.items })
      return result
    },
  )

  ipcMain.handle(
    'diagrams:library-remove-catalog',
    (_e, catalogId: string): DiagramLibraryItem[] => {
      const items = removeCatalogLibrary(catalogId)
      broadcast('diagramLibrary:updated', { items })
      return items
    },
  )
}
