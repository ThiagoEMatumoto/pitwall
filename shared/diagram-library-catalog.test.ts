import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_LIBRARY_CATALOG,
  DIAGRAM_LIBRARY_RAW_BASE,
  findCatalogEntry,
  findCatalogEntryByUrl,
} from './diagram-library-catalog'

describe('diagram-library-catalog', () => {
  it('toda URL aponta para o repo oficial excalidraw-libraries e termina em .excalidrawlib', () => {
    for (const e of DIAGRAM_LIBRARY_CATALOG) {
      const u = new URL(e.url)
      expect(u.protocol).toBe('https:')
      expect(u.host).toBe('raw.githubusercontent.com')
      expect(u.pathname.startsWith('/excalidraw/excalidraw-libraries/')).toBe(true)
      expect(e.url).toBe(`${DIAGRAM_LIBRARY_RAW_BASE}${e.source}`)
      expect(e.source.endsWith('.excalidrawlib')).toBe(true)
      expect(e.license).toBe('MIT')
    }
  })

  it('ids e URLs são únicos', () => {
    const ids = DIAGRAM_LIBRARY_CATALOG.map((e) => e.id)
    const urls = DIAGRAM_LIBRARY_CATALOG.map((e) => e.url)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('cobre as quatro categorias da UI', () => {
    const cats = new Set(DIAGRAM_LIBRARY_CATALOG.map((e) => e.category))
    expect([...cats].sort()).toEqual(['architecture', 'cloud', 'flow', 'uml-er'])
  })

  it('busca por id e por url', () => {
    const aws = findCatalogEntry('aws-architecture')
    expect(aws?.name).toBe('AWS Architecture Icons')
    expect(findCatalogEntryByUrl(aws!.url)?.id).toBe('aws-architecture')
    expect(findCatalogEntry('nope')).toBeUndefined()
  })
})
