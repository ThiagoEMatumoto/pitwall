import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  chatApi: { watch: vi.fn(), unwatch: vi.fn() },
}))

import { chatApi } from '@/lib/ipc'
import {
  acquireChatWatch,
  chatWatchCountForTest,
  noteChatWatchCcSessionId,
  releaseChatWatch,
} from './chat-watch-refs'

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

  // O main descarta o watch sem ccSessionId: se o 1º consumidor chegou sem ele,
  // alguém precisa refazer o watch quando o id aparecer.
  it('1º watch sem ccSessionId: o próximo consumidor com cc id refaz o watch, uma vez', () => {
    vi.mocked(chatApi.watch).mockClear()
    acquireChatWatch('s3', null)
    expect(chatApi.watch).toHaveBeenCalledTimes(1)

    acquireChatWatch('s3', 'cc-3')
    expect(chatApi.watch).toHaveBeenCalledTimes(2)
    expect(chatApi.watch).toHaveBeenLastCalledWith('s3')

    acquireChatWatch('s3', 'cc-3')
    expect(chatApi.watch).toHaveBeenCalledTimes(2)
  })

  it('cc id que chega depois do mount (sem novo consumidor) refaz o watch', () => {
    vi.mocked(chatApi.watch).mockClear()
    acquireChatWatch('s4', null)
    noteChatWatchCcSessionId('s4', null)
    expect(chatApi.watch).toHaveBeenCalledTimes(1)

    noteChatWatchCcSessionId('s4', 'cc-4')
    expect(chatApi.watch).toHaveBeenCalledTimes(2)
    noteChatWatchCcSessionId('s4', 'cc-4')
    expect(chatApi.watch).toHaveBeenCalledTimes(2)

    // Sessão não assistida: não abre watch por conta própria.
    noteChatWatchCcSessionId('s5', 'cc-5')
    expect(chatApi.watch).toHaveBeenCalledTimes(2)
  })
})
