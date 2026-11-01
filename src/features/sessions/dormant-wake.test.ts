import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DockviewApi, DockviewComponent } from 'dockview-core'
import { createActivationWaker, WAKE_DWELL_MS } from './dormant-wake'

// O wake injetado substitui o do store; o store real precisaria de window.api.
vi.mock('@/store/appStore', () => ({ useAppStore: {} }))

// jsdom não tem ResizeObserver; o dockview só o usa para relayout.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// O wake por ativação de aba só vale como escolha do usuário: a aba precisa
// ficar ativa pelo dwell, e a reativação que o dockview faz ao fechar (X) ou
// arrastar um painel não conta.

function dockview() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const component = new DockviewComponent(el, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  })
  component.layout(800, 600)
  return new DockviewApi(component)
}

// Mesma fiação do AppShell.onReady, contra o dockview real.
function wire(api: DockviewApi) {
  const woke: string[] = []
  const waker = createActivationWaker(
    (id) => api.activePanel?.id === id,
    (id) => woke.push(id),
  )
  api.onDidActivePanelChange(() => waker.activated(api.activePanel?.id ?? null))
  api.onDidMovePanel(() => waker.panelRemovedOrMoved())
  api.onDidRemovePanel(() => waker.panelRemovedOrMoved())
  return { woke, waker }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('createActivationWaker', () => {
  it('acorda só depois do dwell; ativação que muda antes cancela', () => {
    const woke: string[] = []
    let active = 'a'
    const waker = createActivationWaker(
      (id) => id === active,
      (id) => woke.push(id),
    )

    // Ctrl+Tab passando por a → b → c: só c fica.
    waker.activated('a')
    vi.advanceTimersByTime(100)
    active = 'b'
    waker.activated('b')
    vi.advanceTimersByTime(100)
    active = 'c'
    waker.activated('c')
    vi.advanceTimersByTime(WAKE_DWELL_MS - 1)
    expect(woke).toEqual([])
    vi.advanceTimersByTime(1)
    expect(woke).toEqual(['c'])
  })

  it('null (layout/reconcile) cancela o pendente', () => {
    const woke: string[] = []
    const waker = createActivationWaker(
      () => true,
      (id) => woke.push(id),
    )
    waker.activated('a')
    waker.activated(null)
    vi.advanceTimersByTime(WAKE_DWELL_MS * 2)
    expect(woke).toEqual([])
  })
})

describe('dockview real', () => {
  it('fechar a aba ativa (X) não acorda a que o dockview reativa', async () => {
    const api = dockview()
    api.addPanel({ id: 'sleeping', component: 'x' })
    api.addPanel({ id: 'closing', component: 'x' })
    expect(api.activePanel?.id).toBe('closing')
    const { woke } = wire(api)

    api.getPanel('closing')!.api.close()
    expect(api.activePanel?.id).toBe('sleeping')
    await Promise.resolve()
    vi.advanceTimersByTime(WAKE_DWELL_MS * 2)

    expect(woke).toEqual([])
  })

  it('arrastar uma aba dormindo para outro grupo não acorda', async () => {
    const api = dockview()
    api.addPanel({ id: 'left', component: 'x' })
    api.addPanel({ id: 'sleeping', component: 'x' })
    api.addPanel({ id: 'right', component: 'x', position: { direction: 'right' } })
    expect(api.activePanel?.id).toBe('right')
    const { woke } = wire(api)

    api.getPanel('sleeping')!.api.moveTo({ group: api.getPanel('right')!.group })
    expect(api.activePanel?.id).toBe('sleeping')
    await Promise.resolve()
    vi.advanceTimersByTime(WAKE_DWELL_MS * 2)

    expect(woke).toEqual([])
  })

  it('clicar na aba (ativação explícita) acorda depois do dwell', async () => {
    const api = dockview()
    api.addPanel({ id: 'sleeping', component: 'x' })
    api.addPanel({ id: 'other', component: 'x' })
    const { woke } = wire(api)

    api.getPanel('sleeping')!.api.setActive()
    await Promise.resolve()
    vi.advanceTimersByTime(WAKE_DWELL_MS)

    expect(woke).toEqual(['sleeping'])
  })

  it('depois de um fechamento, a próxima ativação do usuário volta a acordar', async () => {
    const api = dockview()
    api.addPanel({ id: 'sleeping', component: 'x' })
    api.addPanel({ id: 'b', component: 'x' })
    api.addPanel({ id: 'closing', component: 'x' })
    const { woke } = wire(api)

    api.getPanel('closing')!.api.close()
    await Promise.resolve()
    api.getPanel('sleeping')!.api.setActive()
    vi.advanceTimersByTime(WAKE_DWELL_MS)

    expect(woke).toEqual(['sleeping'])
  })
})
