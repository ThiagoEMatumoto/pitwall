import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  chatApi: { watch: vi.fn(), unwatch: vi.fn(), watchTail: vi.fn(), unwatchTail: vi.fn() },
}))

import { chatApi } from '@/lib/ipc'
import {
  acquireChatWatch,
  acquireTailWatch,
  chatWatchCountForTest,
  noteChatWatchCcSessionId,
  noteTailWatchCcSessionId,
  releaseChatWatch,
  releaseTailWatch,
  tailWatchCountForTest,
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

describe('chat-watch-refs: cauda', () => {
  it('acquire×2/release×1 de cauda: watchTail 1 vez, unwatchTail 0', () => {
    acquireTailWatch('t1')
    acquireTailWatch('t1')
    expect(chatApi.watchTail).toHaveBeenCalledTimes(1)
    releaseTailWatch('t1')
    expect(chatApi.unwatchTail).not.toHaveBeenCalled()
    expect(tailWatchCountForTest('t1')).toBe(1)
    releaseTailWatch('t1')
    expect(chatApi.unwatchTail).toHaveBeenCalledTimes(1)
    expect(chatApi.unwatchTail).toHaveBeenCalledWith('t1')
  })

  it('cauda e completo são independentes na mesma sessão', () => {
    vi.mocked(chatApi.watch).mockClear()
    vi.mocked(chatApi.unwatch).mockClear()
    vi.mocked(chatApi.watchTail).mockClear()
    vi.mocked(chatApi.unwatchTail).mockClear()

    acquireChatWatch('t2')
    acquireTailWatch('t2')
    expect(chatApi.watch).toHaveBeenCalledTimes(1)
    expect(chatApi.watchTail).toHaveBeenCalledTimes(1)

    releaseTailWatch('t2')
    expect(chatApi.unwatchTail).toHaveBeenCalledTimes(1)
    expect(chatApi.unwatch).not.toHaveBeenCalled()
    expect(chatWatchCountForTest('t2')).toBe(1)

    releaseChatWatch('t2')
    expect(chatApi.unwatch).toHaveBeenCalledTimes(1)
    expect(chatApi.unwatchTail).toHaveBeenCalledTimes(1)
  })

  it('release extra de cauda não chama unwatchTail', () => {
    vi.mocked(chatApi.unwatchTail).mockClear()
    releaseTailWatch('t3')
    expect(chatApi.unwatchTail).not.toHaveBeenCalled()
    expect(tailWatchCountForTest('t3')).toBe(0)
  })

  it('cauda aberta sem cc id: o cc id que chega refaz o watchTail, uma vez', () => {
    vi.mocked(chatApi.watchTail).mockClear()
    acquireTailWatch('t4', null)
    noteTailWatchCcSessionId('t4', 'cc-4')
    noteTailWatchCcSessionId('t4', 'cc-4')
    expect(chatApi.watchTail).toHaveBeenCalledTimes(2)
  })
})
