import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REFRAME_DEBOUNCE_MS, observeCanvasResize } from './reframe-on-resize'

// A gaveta "Sessão" abre/fecha ao lado do canvas: a área encolhe/cresce e o
// conteúdo ficava cortado, enquadrado para a largura antiga.
type Callback = (entries: { contentRect: { width: number; height: number } }[]) => void
let observed: Callback | null = null
let disconnected = false

class FakeResizeObserver {
  constructor(cb: Callback) {
    observed = cb
  }
  observe() {}
  disconnect() {
    disconnected = true
  }
}

const resize = (width: number, height: number) => observed!([{ contentRect: { width, height } }])

beforeEach(() => {
  vi.useFakeTimers()
  observed = null
  disconnected = false
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('observeCanvasResize', () => {
  it('a 1ª medida não reenquadra; abrir e fechar a gaveta reenquadram com o tamanho novo', () => {
    const onResize = vi.fn()
    observeCanvasResize(document.createElement('div'), onResize)
    resize(1200, 700)
    vi.advanceTimersByTime(REFRAME_DEBOUNCE_MS)
    expect(onResize).not.toHaveBeenCalled()

    resize(800, 700)
    vi.advanceTimersByTime(REFRAME_DEBOUNCE_MS)
    expect(onResize).toHaveBeenLastCalledWith({ width: 800, height: 700 })

    resize(1200, 700)
    vi.advanceTimersByTime(REFRAME_DEBOUNCE_MS)
    expect(onResize).toHaveBeenLastCalledWith({ width: 1200, height: 700 })
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  it('a animação da gaveta gera vários resizes: um reenquadramento só, no fim', () => {
    const onResize = vi.fn()
    observeCanvasResize(document.createElement('div'), onResize)
    resize(1200, 700)
    for (const w of [1100, 1000, 900, 800]) resize(w, 700)
    vi.advanceTimersByTime(REFRAME_DEBOUNCE_MS)
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize).toHaveBeenCalledWith({ width: 800, height: 700 })
  })

  it('mesmo tamanho ou área colapsada (0) não reenquadra; o cleanup desconecta', () => {
    const onResize = vi.fn()
    const stop = observeCanvasResize(document.createElement('div'), onResize)
    resize(1200, 700)
    resize(1200, 700)
    resize(0, 0)
    vi.advanceTimersByTime(REFRAME_DEBOUNCE_MS)
    expect(onResize).not.toHaveBeenCalled()
    stop()
    expect(disconnected).toBe(true)
  })
})
