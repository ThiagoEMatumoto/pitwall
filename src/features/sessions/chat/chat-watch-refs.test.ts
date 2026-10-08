import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  chatApi: { watch: vi.fn(), unwatch: vi.fn() },
}))

import { chatApi } from '@/lib/ipc'
import { acquireChatWatch, chatWatchCountForTest, releaseChatWatch } from './chat-watch-refs'

describe('chat-watch-refs', () => {
  it('só faz watch no primeiro acquire e unwatch no último release', () => {
    acquireChatWatch('s1')
    acquireChatWatch('s1')
    expect(chatApi.watch).toHaveBeenCalledTimes(1)

    releaseChatWatch('s1')
    expect(chatApi.unwatch).not.toHaveBeenCalled()
    expect(chatWatchCountForTest('s1')).toBe(1)

    releaseChatWatch('s1')
    expect(chatApi.unwatch).toHaveBeenCalledTimes(1)
    expect(chatApi.unwatch).toHaveBeenCalledWith('s1')
  })

  it('release extra não chama unwatch nem fica negativo', () => {
    vi.mocked(chatApi.unwatch).mockClear()
    releaseChatWatch('s2')
    expect(chatApi.unwatch).not.toHaveBeenCalled()
    expect(chatWatchCountForTest('s2')).toBe(0)

    acquireChatWatch('s2')
    expect(chatWatchCountForTest('s2')).toBe(1)
  })
})
