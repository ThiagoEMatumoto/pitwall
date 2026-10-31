import { afterEach, describe, expect, it } from 'vitest'
import type { DesignAgentActivity } from '../../../../shared/types/design'
import {
  ACTIVITY_TTL_MS,
  MAX_ACTIVITY_ENTRIES,
  MAX_RECENT_CHANGES,
  forgetDoc,
  listActivity,
  listChanges,
  recordChange,
  resetLiveState,
  setActivity,
  snapshot,
} from './live-state'

function activity(i: number): DesignAgentActivity {
  return {
    docId: 'doc',
    artboardId: 'ab',
    nodeIds: [`n${i}`],
    tool: 'design_styles_update',
    phase: 'start',
    sessionId: null,
    at: Date.now(),
  }
}

// Shape emitted by design_nodes_finish (electron/main/services/mcp/design-tools.ts).
function finish(i: number, at = Date.now(), docId = 'doc'): DesignAgentActivity {
  return {
    docId,
    artboardId: `ab${i}`,
    nodeIds: [],
    tool: 'design_nodes_finish',
    phase: 'finish',
    sessionId: 'mother-1',
    at,
    summary: `pass ${i}`,
  }
}

describe('live-state activity bound', () => {
  afterEach(() => resetLiveState())

  it('keeps at most MAX_ACTIVITY_ENTRIES per document, dropping the oldest', () => {
    for (let i = 0; i < MAX_ACTIVITY_ENTRIES + 25; i++) setActivity(activity(i))
    const list = listActivity('doc')
    expect(list).toHaveLength(MAX_ACTIVITY_ENTRIES)
    expect(list[0].nodeIds).toEqual(['n25'])
    expect(list.at(-1)!.nodeIds).toEqual([`n${MAX_ACTIVITY_ENTRIES + 24}`])
  })
})

describe('live-state recent changes', () => {
  afterEach(() => resetLiveState())

  it('keeps the last MAX_RECENT_CHANGES finishes per document', () => {
    for (let i = 0; i < MAX_RECENT_CHANGES + 5; i++) recordChange(finish(i))
    const list = listChanges('doc')
    expect(list).toHaveLength(MAX_RECENT_CHANGES)
    expect(list[0].summary).toBe('pass 5')
    expect(list.at(-1)!.summary).toBe(`pass ${MAX_RECENT_CHANGES + 4}`)
  })

  it('drops finishes older than the activity TTL', () => {
    const now = Date.now()
    recordChange(finish(1, now - ACTIVITY_TTL_MS - 1))
    recordChange(finish(2, now - 1000))
    expect(listChanges('doc', now).map((c) => c.summary)).toEqual(['pass 2'])
    expect(listChanges('doc', now + ACTIVITY_TTL_MS)).toEqual([])
  })

  it('snapshot lists only documents with something fresh, or the one asked for', () => {
    setActivity(activity(1))
    recordChange(finish(1, Date.now(), 'other'))
    const all = snapshot()
    expect(all.map((s) => s.docId).sort()).toEqual(['doc', 'other'])
    const other = all.find((s) => s.docId === 'other')!
    expect(other.activity).toEqual([])
    expect(other.changes.map((c) => c.summary)).toEqual(['pass 1'])
    expect(snapshot('quiet')).toEqual([{ docId: 'quiet', activity: [], changes: [] }])
  })

  it('forgetDoc drops activity and changes of a deleted document', () => {
    setActivity(activity(1))
    recordChange(finish(1))
    forgetDoc('doc')
    expect(snapshot()).toEqual([])
  })
})
