import { afterEach, describe, expect, it } from 'vitest'
import type { DesignAgentActivity } from '../../../../shared/types/design'
import { MAX_ACTIVITY_ENTRIES, listActivity, resetLiveState, setActivity } from './live-state'

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
