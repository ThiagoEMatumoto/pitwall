// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createLinkWatch, type LinkRead } from './link-watch'

const LINKED: LinkRead = { filha: 'k1', conversa: 'cc', mae: 'm' }

// Cada leitura devolve o próximo valor da fila; um Error na fila é lançado.
function readsFrom(queue: Array<LinkRead | Error>): () => LinkRead {
  const pending = [...queue]
  return () => {
    const next = pending.shift()
    if (!next) throw new Error('leitura além da fila do teste')
    if (next instanceof Error) throw next
    return next
  }
}

describe('createLinkWatch', () => {
  it('vínculo que ficou nulo e voltou antes do fim do passo fica registrado nesse passo', () => {
    const watch = createLinkWatch(
      readsFrom([LINKED, LINKED, { ...LINKED, filha: null, conversa: null }, LINKED, LINKED]),
    )

    expect(watch.mark('nascer')).toEqual([{ passo: 'nascer', ...LINKED }])
    watch.sample()
    watch.sample()
    watch.sample()

    expect(watch.mark('2 encerrar')).toEqual([
      { passo: '2 encerrar', ...LINKED },
      { passo: '2 encerrar', filha: null, conversa: null, mae: 'm' },
      { passo: '2 encerrar', ...LINKED },
    ])
  })

  it('mãe trocada no meio do passo aparece mesmo restaurada no fim', () => {
    const watch = createLinkWatch(readsFrom([{ ...LINKED, mae: 'outra' }, LINKED]))

    watch.sample()

    expect(watch.mark('3 desfazer').map((l) => l.mae)).toEqual(['outra', 'm'])
  })

  it('leituras iguais em sequência viram um vínculo só por passo', () => {
    const watch = createLinkWatch(readsFrom([LINKED, LINKED, LINKED, LINKED]))

    watch.sample()
    watch.sample()

    expect(watch.mark('1 minimizar')).toEqual([{ passo: '1 minimizar', ...LINKED }])
    expect(watch.mark('7 recado da mãe')).toEqual([{ passo: '7 recado da mãe', ...LINKED }])
  })

  it('leitura que falha no timer é contada e não lança; a do fim do passo lança', () => {
    const watch = createLinkWatch(readsFrom([new Error('SQLITE_BUSY'), LINKED, new Error('fora')]))

    expect(() => watch.sample()).not.toThrow()
    expect(watch.polled()).toEqual({ read: 0, failed: 1 })
    expect(watch.mark('1 minimizar')).toEqual([{ passo: '1 minimizar', ...LINKED }])
    expect(() => watch.mark('2 encerrar')).toThrow('fora')
    expect(watch.polled()).toEqual({ read: 0, failed: 1 })
  })

  it('conta as leituras do timer, para o cenário mostrar que vigiou', () => {
    const watch = createLinkWatch(readsFrom([LINKED, LINKED, LINKED]))

    watch.sample()
    watch.sample()
    watch.mark('1 minimizar')

    expect(watch.polled()).toEqual({ read: 2, failed: 0 })
  })
})
