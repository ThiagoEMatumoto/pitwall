/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { DIAGRAM_TEMPLATES, findDiagramTemplate } from '../../../shared/diagram-templates'
import {
  absolutePoints,
  elementsToSkeleton,
  frameTitleBand,
  type Box,
  type ExElement,
  type ExLinear,
  type Point,
} from '../../../shared/diagram-skeleton'
import { contentBounds, frameViewport, VIEWPORT_TOP_INSET } from '../../../src/features/diagrams/frame-viewport'
import { labelBox, renderedLabelCenter, segmentHitsBox } from '../../../shared/diagram-arrow-label'
import { skeletonToElements } from './diagram-layout'

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])

function overlaps(a: ExElement, b: ExElement): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

const segmentsOf = (el: ExElement): [Point, Point][] => {
  const pts = absolutePoints(el as ExLinear)
  return pts.slice(1).map((p, i) => [pts[i], p])
}

async function layoutOf(id: string) {
  const template = findDiagramTemplate(id)!
  return (await skeletonToElements(template.skeleton, { direction: template.direction })) as ExElement[]
}

/** Frames da esquerda pra direita (LR), pelo nome. */
const frameOrder = (elements: ExElement[]) =>
  elements
    .filter((el) => el.type === 'frame')
    .sort((a, b) => a.x - b.x)
    .map((f) => (f as ExElement & { name: string }).name)

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

  it('pipeline de ML lê Dados → Treino → Produção e arquitetura lê Clientes → Borda → Serviços → Dados', async () => {
    expect(frameOrder(await layoutOf('ml-pipeline'))).toEqual(['Dados', 'Treino', 'Produção'])
    expect(frameOrder(await layoutOf('software-architecture'))).toEqual([
      'Clientes',
      'Borda',
      'Serviços',
      'Dados',
    ])
  })

  for (const template of DIAGRAM_TEMPLATES) {
    it(`${template.id}: abre centralizado na área útil com zoom legível`, async () => {
      // Área do canvas no app (1750×1125 menos sidebar e header).
      const viewport = { width: 1688, height: 1030 }
      const b = contentBounds(await layoutOf(template.id))!
      const v = frameViewport(b, viewport)
      expect(v.zoom).toBeGreaterThanOrEqual(0.55)
      const left = (b.minX + v.scrollX) * v.zoom
      const right = (b.maxX + v.scrollX) * v.zoom
      const top = (b.minY + v.scrollY) * v.zoom
      const bottom = (b.maxY + v.scrollY) * v.zoom
      expect(left).toBeCloseTo(viewport.width - right)
      expect(top - VIEWPORT_TOP_INSET).toBeCloseTo(viewport.height - bottom)
      expect(left).toBeGreaterThan(0)
      expect(top).toBeGreaterThanOrEqual(VIEWPORT_TOP_INSET)
    })

    it(`${template.id}: nenhuma seta cruza a faixa do título de um frame`, async () => {
      const elements = await layoutOf(template.id)
      const arrows = elements.filter((el) => el.type === 'arrow')
      for (const frame of elements.filter((el) => el.type === 'frame')) {
        const band = frameTitleBand(frame)
        for (const a of arrows) {
          for (const [p, q] of segmentsOf(a)) {
            expect(segmentHitsBox(p, q, band), `${a.id} × título de ${frame.id}`).toBe(false)
          }
        }
      }
    })

    it(`${template.id}: labels de seta (onde o Excalidraw desenha) não encostam em nós, labels nem outras setas`, async () => {
      const elements = await layoutOf(template.id)
      const byId = new Map(elements.map((el) => [el.id, el]))
      const nodes = elements.filter((el) => SHAPES.has(el.type) && !(el.customData?.pitwall as { kind?: string })?.kind)
      const labels: { arrow: ExElement; box: Box }[] = []
      for (const a of elements.filter((el) => el.type === 'arrow')) {
        const ref = (a.boundElements ?? []).find((b) => b.type === 'text')
        if (!ref) continue
        const text = byId.get(ref.id)!
        const box = labelBox(renderedLabelCenter(absolutePoints(a as ExLinear)), text)
        // O texto gravado bate com a posição renderizada.
        expect(text.x).toBeCloseTo(box.x)
        expect(text.y).toBeCloseTo(box.y)
        labels.push({ arrow: a, box })
      }
      expect(labels.length).toBeGreaterThan(0)
      for (const { arrow, box } of labels) {
        for (const n of nodes) expect(overlaps(box as ExElement, n), `${arrow.id} × ${n.id}`).toBe(false)
        for (const other of labels) {
          if (other.arrow === arrow) continue
          expect(overlaps(box as ExElement, other.box as ExElement), `${arrow.id} × ${other.arrow.id}`).toBe(false)
        }
        for (const other of elements.filter((el) => el.type === 'arrow' && el !== arrow)) {
          for (const [p, q] of segmentsOf(other)) {
            expect(segmentHitsBox(p, q, box), `label de ${arrow.id} × ${other.id}`).toBe(false)
          }
        }
      }
    })

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
