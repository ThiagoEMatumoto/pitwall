import { beforeEach, describe, expect, it, vi } from 'vitest'

// O appStore lê window.api no import: um dublê que responde a qualquer canal.
const anyApi: unknown = new Proxy(
  {},
  {
    get: () =>
      new Proxy(
        {},
        {
          get: (_t, m: string) =>
            m.startsWith('on') ? () => () => {} : () => new Promise(() => {}),
        },
      ),
  },
)
vi.stubGlobal('window', Object.assign(window, { api: anyApi }))

// O estado do painel é lido do localStorage ao carregar o módulo (como o
// projects-view-store): cada caso importa um módulo novo.
async function freshStore() {
  vi.resetModules()
  return import('./room-panel-store')
}

describe('room-panel-store', () => {
  beforeEach(() => localStorage.clear())

  it('sem nada salvo: fechado, largura padrão', async () => {
    const { useRoomPanelStore, ROOM_PANEL_DEFAULT } = await freshStore()
    expect(useRoomPanelStore.getState()).toMatchObject({ open: false, width: ROOM_PANEL_DEFAULT })
  })

  it('reabre como foi deixado, com a largura dentro dos limites', async () => {
    localStorage.setItem('cm:room-panel', JSON.stringify({ open: true, width: 9999 }))
    const { useRoomPanelStore, ROOM_PANEL_MAX } = await freshStore()
    expect(useRoomPanelStore.getState()).toMatchObject({ open: true, width: ROOM_PANEL_MAX })
  })

  it('valor corrompido cai no padrão em vez de quebrar', async () => {
    localStorage.setItem('cm:room-panel', '{nope')
    const { useRoomPanelStore, ROOM_PANEL_DEFAULT } = await freshStore()
    expect(useRoomPanelStore.getState()).toMatchObject({ open: false, width: ROOM_PANEL_DEFAULT })
  })

  it('show() leva à visão de projeto (terminais) com o painel aberto e o pedido de foco', async () => {
    const { useRoomPanelStore } = await freshStore()
    const { useAppStore } = await import('@/store/appStore')
    const { useProjectsViewStore } = await import('@/features/session-canvas/projects-view-store')
    useAppStore.setState({ area: 'overview' })
    useProjectsViewStore.getState().setView('map')
    useRoomPanelStore.getState().show({ featureId: 'F1' })
    expect(useAppStore.getState().area).toBe('projects')
    expect(useProjectsViewStore.getState().view).toBe('terminals')
    expect(useRoomPanelStore.getState()).toMatchObject({
      open: true,
      featureFilter: 'F1',
      focus: { featureId: 'F1', motherId: null },
    })
    expect(JSON.parse(localStorage.getItem('cm:room-panel')!).open).toBe(true)
  })

  it('compacta abaixo do limiar e só sai com folga (histerese)', async () => {
    const {
      shouldCompactRoomPanel,
      DOCKVIEW_MIN_WITH_PANEL: MIN,
      ROOM_PANEL_HYSTERESIS: H,
    } = await freshStore()
    const W = 380
    // availableWidth = dockview + painel na tela; com o painel cheio sobra available - W.
    expect(shouldCompactRoomPanel(MIN + W, W, false)).toBe(false)
    expect(shouldCompactRoomPanel(MIN + W - 1, W, false)).toBe(true)
    // Já compacto: na faixa [MIN, MIN + H) continua compacto; sai a partir de MIN + H.
    expect(shouldCompactRoomPanel(MIN + W, W, true)).toBe(true)
    expect(shouldCompactRoomPanel(MIN + W + H - 1, W, true)).toBe(true)
    expect(shouldCompactRoomPanel(MIN + W + H, W, true)).toBe(false)
  })

  it('não reage à mudança de largura que ele mesmo causa', async () => {
    const { shouldCompactRoomPanel, ROOM_PANEL_COMPACT: C } = await freshStore()
    // Janela de 1050 com painel de 380 -> dockview 670 (abaixo de 720): compacta.
    // Compacto, o dockview cresce para 1002, mas a soma dockview + faixa segue 1050.
    const W = 380
    const total = 1050
    let compact = shouldCompactRoomPanel(670 + W, W, false)
    expect(compact).toBe(true)
    for (let i = 0; i < 10; i++) {
      const dockview = total - (compact ? C : W)
      compact = shouldCompactRoomPanel(dockview + (compact ? C : W), W, compact)
      expect(compact).toBe(true)
    }
  })

  it('o arrasto para no teto que ainda deixa o dockview no limiar', async () => {
    const {
      roomPanelFitMax,
      clampRoomPanelWidth,
      DOCKVIEW_MIN_WITH_PANEL: MIN,
      ROOM_PANEL_MIN,
      ROOM_PANEL_MAX,
    } = await freshStore()
    expect(roomPanelFitMax(MIN + 400)).toBe(400)
    expect(roomPanelFitMax(MIN + 100)).toBe(ROOM_PANEL_MIN)
    expect(roomPanelFitMax(5000)).toBe(ROOM_PANEL_MAX)
    expect(clampRoomPanelWidth(500, 400)).toBe(400)
    expect(clampRoomPanelWidth(100, 400)).toBe(ROOM_PANEL_MIN)
    expect(clampRoomPanelWidth(9999)).toBe(ROOM_PANEL_MAX)
  })

  it('padrão 300 e mínimo 260: o painel não come o dockview', async () => {
    const { ROOM_PANEL_DEFAULT, ROOM_PANEL_MIN, clampRoomPanelWidth } = await freshStore()
    expect(ROOM_PANEL_DEFAULT).toBe(300)
    expect(clampRoomPanelWidth(100)).toBe(ROOM_PANEL_MIN)
    expect(ROOM_PANEL_MIN).toBe(260)
  })

  it('inset da direita (toasts recuam por ele): largura cheia, faixa compacta ou 0 fora de Projetos', async () => {
    const { renderHook } = await import('@testing-library/react')
    const { useRoomPanelStore, useRoomPanelInset, ROOM_PANEL_COMPACT } = await freshStore()
    const { useAppStore } = await import('@/store/appStore')
    useAppStore.setState({ area: 'projects' })
    useRoomPanelStore.setState({ open: true, width: 320, compact: false })
    const { result, rerender } = renderHook(() => useRoomPanelInset())
    expect(result.current).toBe(320)
    useRoomPanelStore.setState({ compact: true })
    rerender()
    expect(result.current).toBe(ROOM_PANEL_COMPACT)
    useAppStore.setState({ area: 'overview' })
    rerender()
    expect(result.current).toBe(0)
    useAppStore.setState({ area: 'projects' })
    useRoomPanelStore.setState({ open: false })
    rerender()
    expect(result.current).toBe(0)
  })
})
