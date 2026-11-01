import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hibernação por ociosidade (H1/H5): o controle mora ao lado do toggle de lazy
// restore, só vale com ele ligado, grava sessions.hibernateAfterMin e mostra os
// contadores de sessions:hibernate-stats ao abrir.
const prefs = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  set: vi.fn(),
}))
const stats = vi.hoisted(() => ({ value: {} as unknown, calls: 0 }))
const anyNamespace = new Proxy(
  {},
  {
    get: (_t, prop) =>
      typeof prop === 'string' && prop.startsWith('on')
        ? () => () => {}
        : () => Promise.resolve({}),
  },
)
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) => {
        if (ns === 'prefs')
          return {
            get: (key: string) => Promise.resolve(prefs.store.get(key)),
            set: (key: string, value: unknown) => {
              prefs.set(key, value)
              prefs.store.set(key, value)
              return Promise.resolve()
            },
          }
        if (ns === 'sessions')
          return new Proxy(
            {},
            {
              get: (_t2, prop) =>
                prop === 'hibernateStats'
                  ? () => {
                      stats.calls += 1
                      return Promise.resolve(stats.value)
                    }
                  : (anyNamespace as Record<string | symbol, unknown>)[prop],
            },
          )
        return anyNamespace
      },
    },
  ),
})

const { SettingsDialog } = await import('./SettingsDialog')
const { useSessionPrefsStore } = await import('@/lib/session-prefs-store')
const { HIBERNATE_LABEL, HIBERNATE_NEEDS_LAZY_HINT } = await import('./HibernateSetting')

async function openSessionTab() {
  render(<SettingsDialog open onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /Sessão\/Chat/ }))
  await vi.waitFor(() => expect(useSessionPrefsStore.getState().loaded).toBe(true))
  return screen.getByRole('combobox', { name: HIBERNATE_LABEL }) as HTMLSelectElement
}

describe('Configurações → hibernar sessões ociosas', () => {
  beforeEach(() => {
    prefs.store.clear()
    prefs.set.mockClear()
    stats.calls = 0
    stats.value = {
      hibernated: 0,
      refusals: {},
      enabled: false,
      reasonDisabled: 'lazy-restore-off-at-boot',
    }
    useSessionPrefsStore.setState({ loaded: false, lazyRestore: false, hibernateAfterMin: 0 })
  })

  it('com lazy restore off: desabilitado, com a dica, nasce em Desligado', async () => {
    const select = await openSessionTab()
    expect(select).toBeDisabled()
    expect(select.value).toBe('0')
    expect(select).toHaveAttribute('title', HIBERNATE_NEEDS_LAZY_HINT)
    expect(screen.getByText(HIBERNATE_LABEL)).toBeInTheDocument()
    expect(screen.getByText(HIBERNATE_NEEDS_LAZY_HINT)).toBeInTheDocument()
  })

  it('com lazy restore on: habilitado e grava sessions.hibernateAfterMin', async () => {
    prefs.store.set('sessions.lazyRestore', true)
    const select = await openSessionTab()
    expect(select).toBeEnabled()
    expect([...select.options].map((o) => o.value)).toEqual(['0', '60', '120', '240'])
    fireEvent.change(select, { target: { value: '120' } })
    expect(prefs.set).toHaveBeenLastCalledWith('sessions.hibernateAfterMin', 120)
    expect(select.value).toBe('120')
    fireEvent.change(select, { target: { value: '0' } })
    expect(prefs.set).toHaveBeenLastCalledWith('sessions.hibernateAfterMin', 0)
  })

  it('ligar o lazy restore na mesma tela habilita o controle', async () => {
    const select = await openSessionTab()
    expect(select).toBeDisabled()
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Restaurar abas dormindo (economiza memória; experimental)',
      }),
    )
    expect(select).toBeEnabled()
  })

  it('valor salvo fora das sugestões continua selecionado', async () => {
    prefs.store.set('sessions.lazyRestore', true)
    prefs.store.set('sessions.hibernateAfterMin', 90)
    const select = await openSessionTab()
    await vi.waitFor(() => expect(select.value).toBe('90'))
  })

  it('mostra os contadores e o motivo de estar desligada ao abrir', async () => {
    stats.value = {
      hibernated: 3,
      refusals: { 'io-recent': 5, 'status-not-idle': 2, handoff: 0 },
      enabled: true,
    }
    await openSessionTab()
    const line = await screen.findByTestId('hibernate-stats')
    expect(line).toHaveTextContent('Hibernadas: 3 · Recusas: io-recent×5, status-not-idle×2')
    expect(line.textContent).not.toContain('handoff')
    expect(stats.calls).toBeGreaterThan(0)
  })

  it('desligada pelo boot: o motivo aparece na linha de status', async () => {
    await openSessionTab()
    const line = await screen.findByTestId('hibernate-stats')
    expect(line).toHaveTextContent('Hibernadas: 0 · Recusas: nenhuma · desligada:')
    expect(line).toHaveTextContent('vale após reiniciar')
  })
})
