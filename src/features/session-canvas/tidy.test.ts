import { describe, expect, it } from 'vitest'
import { tidyPositions } from './tidy'
import { graphToFlow, type MapInput } from './graph-to-flow'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

function node(sessionId: string, patch: Partial<SessionGraphNode> = {}): SessionGraphNode {
  return {
    sessionId,
    ccSessionId: `cc-${sessionId}`,
    title: sessionId,
    projectId: 'p1',
    repoId: 'r1',
    repoLabel: 'r1',
    provider: 'claude',
    status: 'idle',
    attentionReason: null,
    lastActivityAt: null,
    purposeHint: null,
    purpose: null,
    purposeSource: null,
    groupId: null,
    lastSummary: null,
    lastSummaryAt: null,
    childOfHandoffId: null,
    ...patch,
  }
}

const nodes = [
  node('a'),
  node('b'),
  node('c', { repoId: 'r2', repoLabel: 'r2' }),
  node('d', { projectId: 'p2', repoId: 'r3', repoLabel: 'r3' }),
  node('e', { groupId: 'g1' }),
]

const INPUT: MapInput = {
  scope: 'all',
  graph: {
    nodes,
    lanes: [
      {
        projectId: 'p1',
        name: 'P1',
        color: null,
        repos: [
          { repoId: 'r1', label: 'r1', sessionIds: ['a', 'b', 'e'] },
          { repoId: 'r2', label: 'r2', sessionIds: ['c'] },
        ],
      },
      {
        projectId: 'p2',
        name: 'P2',
        color: null,
        repos: [{ repoId: 'r3', label: 'r3', sessionIds: ['d'] }],
      },
    ],
    edges: [],
  },
  positions: [
    // Bagunça salva que o Organizar deve ignorar.
    { scope: 'all', kind: 'session', entityId: 'a', x: 999, y: -40, w: null, h: null },
    { scope: 'all', kind: 'lane', entityId: 'p:p2', x: 0, y: 0, w: null, h: null },
  ],
  notes: [
    {
      id: 'n1',
      scope: 'all',
      bodyMd: 'x',
      attachedSessionId: 'a',
      color: null,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'n2',
      scope: 'all',
      bodyMd: 'y',
      attachedSessionId: null,
      color: null,
      createdAt: 2,
      updatedAt: 2,
    },
  ],
  groups: [{ id: 'g1', scope: 'all', name: 'G', color: null, createdAt: 1 }],
}

interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

describe('tidyPositions', () => {
  it('é determinístico e ignora as posições salvas', () => {
    const first = tidyPositions(INPUT)
    expect(tidyPositions(INPUT)).toEqual(first)
    expect(tidyPositions({ ...INPUT, positions: [] })).toEqual(first)
    expect(first.find((p) => p.kind === 'session' && p.entityId === 'a')).not.toMatchObject({
      x: 999,
    })
  })

  it('persiste sessões, lanes de projeto, grupos e notas', () => {
    const keys = tidyPositions(INPUT).map((p) => `${p.kind}:${p.entityId}`)
    expect(keys).toEqual(
      expect.arrayContaining([
        'session:a',
        'session:e',
        'lane:p:p1',
        'lane:p:p2',
        'group:g1',
        'note:n1',
        'note:n2',
      ]),
    )
  })

  it('nenhum par de irmãos se sobrepõe depois de organizar', () => {
    const saved = tidyPositions(INPUT).map((p) => ({
      ...p,
      scope: 'all',
      w: p.w ?? null,
      h: p.h ?? null,
    }))
    const { nodes: flow } = graphToFlow({ ...INPUT, positions: saved })
    const byParent = new Map<string, Box[]>()
    for (const n of flow) {
      const key = n.parentId ?? '(raiz)'
      byParent.set(key, [
        ...(byParent.get(key) ?? []),
        { id: n.id, x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 },
      ])
    }
    for (const [, boxes] of byParent) {
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlaps(boxes[i], boxes[j]), `${boxes[i].id} × ${boxes[j].id}`).toBe(false)
        }
      }
    }
  })
})
