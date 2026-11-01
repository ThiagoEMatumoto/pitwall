import { DIAGRAM_TEMPLATES, findDiagramTemplate, type DiagramTemplate } from '../../../shared/diagram-templates'
import type { DiagramLayoutOptions } from '../../../shared/diagram-skeleton'
import type { DiagramScene } from '../../../shared/types/ipc'
import { skeletonToElements } from './diagram-layout'

// Caminho único (IPC "Novo a partir de modelo" e MCP diagram_create { template })
// pra transformar um modelo em cena posicionada pelo ELK.
export function requireDiagramTemplate(id: string): DiagramTemplate {
  const template = findDiagramTemplate(id)
  if (!template) {
    const known = DIAGRAM_TEMPLATES.map((t) => t.id).join(', ')
    throw new Error(`modelo "${id}" não existe (ids: ${known})`)
  }
  return template
}

export async function templateScene(
  template: DiagramTemplate,
  options: DiagramLayoutOptions = {},
): Promise<DiagramScene> {
  return {
    elements: await skeletonToElements(template.skeleton, {
      ...options,
      direction: options.direction ?? template.direction,
    }),
  }
}
