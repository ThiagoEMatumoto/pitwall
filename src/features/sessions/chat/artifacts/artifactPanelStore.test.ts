import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_MIN_WIDTH, PANEL_STORAGE_KEY } from './artifactPanelStore'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

async function freshStore() {
  return (await import('./artifactPanelStore')).useArtifactPanelStore
}

describe('artifactPanelStore', () => {
  it('lembra o último artefato de cada sessão entre reloads', async () => {
    const store = await freshStore()
    store.getState().show('s1', { kind: 'diagram', id: 'd1' })
    store.getState().show('s2', { kind: 'design', id: 'doc' })
    store.getState().close('s1')

    const reloaded = await freshStore()
    expect(reloaded.getState().sessions.s1).toEqual({
      ref: { kind: 'diagram', id: 'd1' },
      open: false,
    })
    expect(reloaded.getState().sessions.s2).toEqual({
      ref: { kind: 'design', id: 'doc' },
      open: true,
    })
  })

  it('largura respeita o mínimo e sobrevive a storage corrompido', async () => {
    localStorage.setItem(PANEL_STORAGE_KEY, '{nope')
    const store = await freshStore()
    store.getState().setWidth(10)
    expect(store.getState().width).toBe(PANEL_MIN_WIDTH)
  })
})
