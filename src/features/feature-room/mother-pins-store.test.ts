import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY = 'pitwall.room.mother-pins'

async function freshStore() {
  vi.resetModules()
  return (await import('./mother-pins-store')).useMotherPins
}

describe('mother-pins-store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('lê a ordem salva e ignora lixo', async () => {
    localStorage.setItem(KEY, JSON.stringify(['cc-a', 3, 'cc-b']))
    const pins = await freshStore()
    expect(pins.getState().order).toEqual(['cc-a', 'cc-b'])
  })

  it('JSON inválido no storage → []', async () => {
    localStorage.setItem(KEY, '{nope')
    expect((await freshStore()).getState().order).toEqual([])
  })

  it('toggle fixa no fim, solta e persiste', async () => {
    const pins = await freshStore()
    pins.getState().toggle('cc-a')
    pins.getState().toggle('cc-b')
    expect(pins.getState().order).toEqual(['cc-a', 'cc-b'])
    pins.getState().toggle('cc-a')
    expect(pins.getState().order).toEqual(['cc-b'])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['cc-b'])
  })

  it('storage lançando: order = [] e toggle funciona em memória', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const pins = await freshStore()
    expect(pins.getState().order).toEqual([])
    pins.getState().toggle('cc-a')
    expect(pins.getState().order).toEqual(['cc-a'])
  })

  it('prune não escreve quando nada sumiu, e poda o que sumiu', async () => {
    const pins = await freshStore()
    pins.getState().toggle('cc-a')
    pins.getState().toggle('cc-b')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    const before = pins.getState().order
    pins.getState().prune(new Set(['cc-a', 'cc-b', 'cc-c']))
    expect(setItem).not.toHaveBeenCalled()
    expect(pins.getState().order).toBe(before)

    pins.getState().prune(new Set(['cc-b']))
    expect(pins.getState().order).toEqual(['cc-b'])
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('prune com alive vazio (grafo ainda não carregou) não apaga os pins', async () => {
    const pins = await freshStore()
    pins.getState().toggle('cc-a')
    pins.getState().prune(new Set())
    expect(pins.getState().order).toEqual(['cc-a'])
  })
})
