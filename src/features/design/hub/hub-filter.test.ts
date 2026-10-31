import { describe, expect, it } from 'vitest'
import type { DesignDocumentMeta } from '@shared/types/design'
import { dropId, parseDropId, sectionDocs, visibleDocs } from './hub-filter'

const doc = (id: string, title: string, folderId: string | null, updatedAt: number): DesignDocumentMeta => ({
  id,
  title,
  status: 'active',
  folderId,
  thumbnailVersion: null,
  createdAt: 1,
  updatedAt,
})

describe('hub-filter', () => {
  it('round-trips drop targets, "Sem pasta" included', () => {
    expect(parseDropId(dropId('f1'))).toBe('f1')
    expect(parseDropId(dropId(null))).toBeNull()
    expect(parseDropId('nav:Recentes')).toBeUndefined()
    expect(parseDropId(undefined)).toBeUndefined()
  })

  it('picks the section source', () => {
    const docs = [doc('a', 'A', 'f1', 1), doc('b', 'B', null, 2)]
    const archived = [doc('c', 'C', 'f1', 3)]
    expect(sectionDocs('recent', docs, archived).map((d) => d.id)).toEqual(['a', 'b'])
    expect(sectionDocs('unfiled', docs, archived).map((d) => d.id)).toEqual(['b'])
    expect(sectionDocs('f1', docs, archived).map((d) => d.id)).toEqual(['a'])
    expect(sectionDocs('archived', docs, archived).map((d) => d.id)).toEqual(['c'])
  })

  it('searches accent-insensitively and sorts by recency or name', () => {
    const list = [doc('a', 'Órbita', null, 1), doc('b', 'banner', null, 3), doc('c', 'Ação', null, 2)]
    expect(visibleDocs(list, 'orb', 'recent').map((d) => d.id)).toEqual(['a'])
    expect(visibleDocs(list, '', 'recent').map((d) => d.id)).toEqual(['b', 'c', 'a'])
    expect(visibleDocs(list, '', 'name').map((d) => d.id)).toEqual(['c', 'b', 'a'])
  })
})
