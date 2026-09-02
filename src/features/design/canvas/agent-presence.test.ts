import { describe, expect, it } from 'vitest'
import type { DesignAgentActivity } from '@shared/types/design'
import {
  DONE_HOLD_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  MIN_ACTIVE_MS,
  PRESENCE_STALE_MS,
  actionLabel,
  presenceStage,
  presenceTargets,
  presenceText,
  reconcilePresence,
  type PresenceItem,
} from './agent-presence'

function row(over: Partial<DesignAgentActivity>): DesignAgentActivity {
  return {
    docId: 'd1',
    artboardId: 'a1',
    nodeIds: [],
    tool: 'design_styles_update',
    phase: 'start',
    sessionId: 's1',
    at: 1000,
    ...over,
  }
}

describe('actionLabel', () => {
  it('maps the write tools to a human verb', () => {
    expect(actionLabel('design_styles_update')).toBe('ajustando estilo')
    expect(actionLabel('design_text_set')).toBe('escrevendo texto')
    expect(actionLabel('design_write_html')).toBe('escrevendo')
    expect(actionLabel('design_nodes_move')).toBe('movendo')
    expect(actionLabel('design_nodes_duplicate')).toBe('duplicando')
    expect(actionLabel('design_nodes_delete')).toBe('removendo')
    expect(actionLabel('design_tokens_set')).toBe('atualizando tokens')
  })

  it('falls back to the bare tool name', () => {
    expect(actionLabel('design_something_new')).toBe('something new')
  })
})

describe('presenceTargets', () => {
  it('yields one active target per touched node', () => {
    const targets = presenceTargets({ a1: [row({ nodeIds: ['n1', 'n2'] })] }, ['a1'], 1100)
    expect(targets.map((t) => [t.nodeId, t.phase])).toEqual([
      ['n1', 'active'],
      ['n2', 'active'],
    ])
  })

  it('targets the whole artboard when the call has no node ids', () => {
    const targets = presenceTargets(
      { a1: [row({ tool: 'design_write_html', nodeIds: [] })] },
      ['a1'],
      1100,
    )
    expect(targets).toHaveLength(1)
    expect(targets[0].nodeId).toBeNull()
    expect(targets[0].key).toBe('a1:*')
  })

  it('spreads document-level activity over every artboard on the page', () => {
    const targets = presenceTargets(
      { '*': [row({ artboardId: null, tool: 'design_tokens_set' })] },
      ['a1', 'a2'],
      1100,
    )
    expect(targets.map((t) => t.key)).toEqual(['a1:*', 'a2:*'])
  })

  it('lets the newest row per node win and marks end as done', () => {
    const targets = presenceTargets(
      {
        a1: [
          row({ nodeIds: ['n1'], phase: 'end', at: 2000 }),
          row({
            nodeIds: ['n1'],
            tool: 'design_text_set',
            phase: 'start',
            at: 2500,
          }),
        ],
      },
      ['a1'],
      2600,
    )
    expect(targets).toHaveLength(1)
    expect(targets[0].tool).toBe('design_text_set')
    expect(targets[0].phase).toBe('active')
  })

  it('drops stale active rows and expired done rows', () => {
    const targets = presenceTargets(
      {
        a1: [
          row({ nodeIds: ['old'], at: 0 }),
          row({ nodeIds: ['ended'], phase: 'end', at: 0 }),
          row({ nodeIds: ['live'], at: PRESENCE_STALE_MS - 1 }),
        ],
      },
      ['a1'],
      PRESENCE_STALE_MS,
    )
    expect(targets.map((t) => t.nodeId)).toEqual(['live'])
  })
})

describe('reconcilePresence', () => {
  const active = (nodeId: string, at = 1000) =>
    presenceTargets({ a1: [row({ nodeIds: [nodeId], at })] }, ['a1'], at)

  it('keeps startedAt across ticks so the fade-in runs once', () => {
    const first = reconcilePresence([], active('n1'), 1000)
    const second = reconcilePresence(first, active('n1'), 1300)
    expect(first[0].startedAt).toBe(1000)
    expect(second[0].startedAt).toBe(1000)
    expect(presenceStage(first[0], 1000 + FADE_IN_MS - 1)).toBe('enter')
    expect(presenceStage(second[0], 1300)).toBe('steady')
  })

  it('turns a vanished target (finish) into a done item that fades and expires', () => {
    const live = reconcilePresence([], active('n1'), 1000)
    const gone = reconcilePresence(live, [], 5000)
    expect(gone).toHaveLength(1)
    expect(gone[0].doneAt).toBe(5000)
    expect(presenceStage(gone[0], 5000)).toBe('done')
    expect(presenceStage(gone[0], 5000 + DONE_HOLD_MS)).toBe('leave')
    const later = reconcilePresence(gone, [], 5000 + DONE_HOLD_MS + FADE_OUT_MS)
    expect(later).toHaveLength(0)
  })

  it('stamps doneAt from the end row and restarts on a new start', () => {
    const ended = presenceTargets(
      { a1: [row({ nodeIds: ['n1'], phase: 'end', at: 2000 })] },
      ['a1'],
      2100,
    )
    const done = reconcilePresence([], ended, 2100)
    // Never seen active: the end row alone still earns MIN_ACTIVE_MS of veil.
    expect(done[0].startedAt).toBe(2000)
    expect(done[0].doneAt).toBe(2000 + MIN_ACTIVE_MS)
    expect(presenceStage(done[0], 2100 + FADE_IN_MS)).toBe('steady')
    expect(presenceStage(done[0], 2000 + MIN_ACTIVE_MS)).toBe('done')
    const again = reconcilePresence(done, active('n1', 2500), 2500)
    expect(again[0].doneAt).toBeNull()
    expect(again[0].startedAt).toBe(2500)
  })
})

describe('reconcilePresence — synchronous calls', () => {
  it('holds a call that ended right after it started in the active stage', () => {
    const live = reconcilePresence(
      [],
      presenceTargets({ a1: [row({ nodeIds: ['n1'] })] }, ['a1'], 1000),
      1000,
    )
    const ended = presenceTargets(
      { a1: [row({ nodeIds: ['n1'], phase: 'end', at: 1005 })] },
      ['a1'],
      1005,
    )
    const done = reconcilePresence(live, ended, 1005)
    expect(done[0].doneAt).toBe(1000 + MIN_ACTIVE_MS)
    expect(presenceStage(done[0], 1300)).toBe('steady')
    expect(presenceStage(done[0], 1000 + MIN_ACTIVE_MS)).toBe('done')
    // The end row stays a target long enough to cover the hold and the fade.
    expect(ended).toHaveLength(1)
    expect(
      presenceTargets(
        { a1: [row({ nodeIds: ['n1'], phase: 'end', at: 1005 })] },
        ['a1'],
        1005 + MIN_ACTIVE_MS + DONE_HOLD_MS + FADE_OUT_MS - 1,
      ),
    ).toHaveLength(1)
  })

  it('a target that vanishes right after starting is held active before terminou', () => {
    const live = reconcilePresence(
      [],
      presenceTargets({ a1: [row({ nodeIds: ['n1'] })] }, ['a1'], 1000),
      1000,
    )
    const gone = reconcilePresence(live, [], 1010)
    expect(gone[0].doneAt).toBe(1000 + MIN_ACTIVE_MS)
    expect(presenceStage(gone[0], 1300)).toBe('steady')
  })
})

describe('presenceText', () => {
  const item = (nodeId: string | null, tool: string): PresenceItem => ({
    key: 'k',
    artboardId: 'a1',
    nodeId,
    tool,
    phase: 'active',
    at: 0,
    startedAt: 0,
    doneAt: null,
  })

  it('phrases the artboard root and a node differently', () => {
    expect(presenceText(item(null, 'design_write_html'), 'Home', 'steady')).toBe(
      'Claude está escrevendo Home…',
    )
    expect(presenceText(item('n1', 'design_styles_update'), 'Botão', 'steady')).toBe(
      'Claude · ajustando estilo · Botão',
    )
  })

  it('phrases a root-node target as the whole artboard', () => {
    expect(presenceText(item('root', 'design_write_html'), 'Promoções', 'steady', true)).toBe(
      'Claude está escrevendo Promoções…',
    )
  })

  it('says terminou while done or leaving', () => {
    expect(presenceText(item('n1', 'design_text_set'), 'x', 'done')).toBe('Claude terminou')
    expect(presenceText(item(null, 'design_write_html'), 'x', 'leave')).toBe('Claude terminou')
  })
})
