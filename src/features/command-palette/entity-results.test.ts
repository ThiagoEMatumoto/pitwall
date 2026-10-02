import { describe, expect, it } from 'vitest'
import { matchesQuery } from '@/lib/text-match'
import {
  ENTITY_GROUP_CAPS,
  FEATURE_GROUP,
  featureHint,
  featureSearchText,
  searchableTasks,
  showEntityResults,
  taskSearchText,
} from './entity-results'
import { capByGroup } from './session-results'

describe('paleta — features e tarefas', () => {
  it('só aparecem com 2+ caracteres digitados', () => {
    expect(showEntityResults('')).toBe(false)
    expect(showEntityResults(' a ')).toBe(false)
    expect(showEntityResults('ab')).toBe(true)
  })

  it('feature casa por título e objetivo', () => {
    const f = { title: 'Design Studio', slug: 'design-studio', objective: 'reduzir abandono pós-protocolo' }
    expect(matchesQuery('Design Studio', featureSearchText(f))).toBe(true)
    expect(matchesQuery('abandono', featureSearchText(f))).toBe(true)
  })

  it('tarefa casa por tag; concluídas e canceladas ficam de fora', () => {
    expect(matchesQuery('infra', taskSearchText({ title: 'subir proxy', tags: ['infra'] }))).toBe(true)
    const tasks = [{ status: 'todo' }, { status: 'done' }, { status: 'cancelled' }, { status: 'blocked' }] as const
    expect(searchableTasks([...tasks]).map((t) => t.status)).toEqual(['todo', 'blocked'])
  })

  it('teto por grupo', () => {
    const items = Array.from({ length: 10 }, () => ({ group: FEATURE_GROUP }))
    expect(capByGroup(items, ENTITY_GROUP_CAPS)).toHaveLength(6)
  })
})

describe('featureHint', () => {
  const names = new Map([['p1', 'Assistente']])
  it('cross-project: repos e sessões vivas no lugar do projeto dono', () => {
    const f = { id: 'f', projectId: 'p1', repos: [{}, {}, {}] } as never
    expect(featureHint(f, names, ['f', 'f', 'g', null, 'f'])).toBe('3 repos · 3 sessões')
    expect(featureHint(f, names, [])).toBe('3 repos')
  })
  it('um repo só: o nome do projeto', () => {
    const f = { id: 'f', projectId: 'p1', repos: [{}] } as never
    expect(featureHint(f, names, ['f'])).toBe('Assistente')
  })
})
