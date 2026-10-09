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
})
