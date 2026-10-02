import { describe, expect, it } from 'vitest'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useFeaturePanelStore } from './feature-panel-store'

describe('um painel à direita por vez', () => {
  it('abrir o painel da feature recolhe a Equipe', () => {
    useCrewDockStore.getState().expand()
    useFeaturePanelStore.getState().open('f1')
    expect(useCrewDockStore.getState().collapsed).toBe(true)
    expect(useFeaturePanelStore.getState().openFeatureId).toBe('f1')
  })

  it('expandir a Equipe (clique ou Ctrl+J) fecha o painel da feature', () => {
    useFeaturePanelStore.getState().open('f1')
    useCrewDockStore.getState().requestFocus()
    expect(useCrewDockStore.getState().collapsed).toBe(false)
    expect(useFeaturePanelStore.getState().openFeatureId).toBeNull()
  })
})
