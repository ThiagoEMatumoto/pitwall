import { describe, expect, it } from 'vitest'
import { layoutRestoreStep, layoutToRestore } from './dock-layout-restore'
import type { PaneSnapshot } from './types/ipc'

const snap = (paneId: string | undefined): PaneSnapshot => ({
  ccSessionId: `cc-${paneId}`,
  repo: null,
  projectName: null,
  projectIcon: null,
  paneId,
})
const layout = (...ids: string[]) =>
  JSON.stringify({ panels: Object.fromEntries(ids.map((id) => [id, { id }])) })

describe('layoutToRestore', () => {
  it('layout sem paneId em comum com o open_panes é descartado', () => {
    expect(layoutToRestore(layout('A'), [snap('B')])).toBeNull()
  })

  it('basta um paneId em comum para usar o layout', () => {
    const l = layout('A', 'C')
    expect(layoutToRestore(l, [snap('A'), snap('B')])).toBe(l)
  })

  it('snapshot antigo sem paneId, layout corrompido ou vazio: grid padrão', () => {
    expect(layoutToRestore(layout('A'), [snap('A'), snap(undefined)])).toBeNull()
    expect(layoutToRestore('{nope', [snap('A')])).toBeNull()
    expect(layoutToRestore(null, [snap('A')])).toBeNull()
    expect(layoutToRestore(layout('A'), [])).toBeNull()
  })
})

describe('layoutRestoreStep', () => {
  it('todas de volta: aplica', () => {
    expect(layoutRestoreStep(['A', 'B'], new Set(['A', 'B']), false)).toBe('apply')
  })

  it('parte de volta: arma o fallback do parcial', () => {
    expect(layoutRestoreStep(['A', 'B'], new Set(['A']), false)).toBe('arm-fallback')
  })

  it('nenhuma ainda, restore em curso: espera', () => {
    expect(layoutRestoreStep(['A'], new Set(['B']), false)).toBe('wait')
  })

  it('restore terminou sem nenhuma do layout: nunca fica pendurado', () => {
    expect(layoutRestoreStep(['A'], new Set(['B']), true)).toBe('arm-fallback')
    expect(layoutRestoreStep([], new Set(), true)).toBe('arm-fallback')
  })
})
