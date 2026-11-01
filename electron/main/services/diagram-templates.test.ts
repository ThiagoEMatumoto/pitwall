/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { DIAGRAM_TEMPLATES, findDiagramTemplate } from '../../../shared/diagram-templates'
import { elementsToSkeleton, type ExElement } from '../../../shared/diagram-skeleton'
import { skeletonToElements } from './diagram-layout'

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])

function overlaps(a: ExElement, b: ExElement): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

describe('diagram templates', () => {
  it('ids únicos e busca por id', () => {
    const ids = DIAGRAM_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(['software-architecture', 'ml-pipeline']))
    expect(findDiagramTemplate('ml-pipeline')?.name).toBe('Pipeline de ML')
    expect(findDiagramTemplate('nope')).toBeUndefined()
  })

  it('pipeline de ML tem a seta de retreino do monitoramento pro treino', () => {
    const t = findDiagramTemplate('ml-pipeline')!
    expect(t.skeleton).toContainEqual(
      expect.objectContaining({ type: 'arrow', start: { id: 'monitor' }, end: { id: 'train' } }),
    )
  })

  for (const template of DIAGRAM_TEMPLATES) {
    it(`${template.id}: ELK posiciona todos os nós sem sobreposição e liga todas as setas`, async () => {
      const elements = (await skeletonToElements(template.skeleton, {
        direction: template.direction,
      })) as ExElement[]

      const nodeIds = template.skeleton.filter((el) => SHAPES.has(el.type)).map((el) => el.id)
      const shapes = elements.filter((el) => nodeIds.includes(el.id) && !el.isDeleted)
      expect(shapes.map((s) => s.id).sort()).toEqual([...nodeIds].sort())
      for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
          expect(overlaps(shapes[i], shapes[j]), `${shapes[i].id} × ${shapes[j].id}`).toBe(false)
        }
      }

      // Contêineres (frame/group) não se sobrepõem entre si e envolvem os filhos.
      const containerIds = template.skeleton
        .filter((el) => el.type === 'frame' || el.type === 'group')
        .map((el) => el.id)
      const frames = elements.filter((el) => containerIds.includes(el.id))
      expect(frames).toHaveLength(containerIds.length)
      for (const c of template.skeleton.filter((el) => containerIds.includes(el.id))) {
        const box = frames.find((f) => f.id === c.id)!
        for (const childId of c.children ?? []) {
          const child = shapes.find((s) => s.id === childId)!
          expect(child.x >= box.x && child.x + child.width <= box.x + box.width, `${childId} em ${c.id}`).toBe(true)
          expect(child.y >= box.y && child.y + child.height <= box.y + box.height, `${childId} em ${c.id}`).toBe(true)
        }
      }
      for (let i = 0; i < frames.length; i++) {
        for (let j = i + 1; j < frames.length; j++) {
          expect(overlaps(frames[i], frames[j]), `${frames[i].id} × ${frames[j].id}`).toBe(false)
        }
      }

      // Round-trip: o skeleton derivado da cena guarda todas as setas ligadas.
      const derived = elementsToSkeleton(elements)
      const arrows = derived.filter((el) => el.type === 'arrow')
      const expectedArrows = template.skeleton.filter((el) => el.type === 'arrow')
      expect(arrows).toHaveLength(expectedArrows.length)
      for (const a of arrows) {
        expect(a.start?.id).toBeTruthy()
        expect(a.end?.id).toBeTruthy()
      }
    })
  }
})
