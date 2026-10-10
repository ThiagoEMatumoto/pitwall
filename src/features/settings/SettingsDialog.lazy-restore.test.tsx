import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Lazy restore é opt-in: um toggle desligado por padrão, gravando só o booleano
// que o main lê (sessions.lazyRestore).
const prefs = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  set: vi.fn(),
}))
// ipc.ts lê window.api no module-eval: o mock precisa existir antes do import.
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
      get: (_t, ns) =>
        ns === 'prefs'
          ? {
              get: (key: string) => Promise.resolve(prefs.store.get(key)),
              set: (key: string, value: unknown) => {
                prefs.set(key, value)
                prefs.store.set(key, value)
                return Promise.resolve()
              },
            }
          : anyNamespace,
    },
  ),
})

const { SettingsDialog } = await import('./SettingsDialog')
const { useSessionPrefsStore } = await import('@/lib/session-prefs-store')

const LABEL = 'Restaurar abas dormindo (economiza memória; experimental)'

async function openSessionTab() {
  render(<SettingsDialog open onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /Sessão\/Chat/ }))
  return screen.findByRole('switch', { name: LABEL })
}

describe('Configurações → lazy restore', () => {
  beforeEach(() => {
    prefs.store.clear()
    prefs.set.mockClear()
    useSessionPrefsStore.setState({ loaded: false, lazyRestore: false })
  })

  it('sem pref salva o toggle nasce desligado, com o texto exato', async () => {
    const toggle = await openSessionTab()
    await vi.waitFor(() => expect(useSessionPrefsStore.getState().loaded).toBe(true))
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(LABEL)).toBeInTheDocument()
  })

  it('ligar grava sessions.lazyRestore=true; desligar grava false', async () => {
    const toggle = await openSessionTab()
    await vi.waitFor(() => expect(useSessionPrefsStore.getState().loaded).toBe(true))
    fireEvent.click(toggle)
    expect(prefs.set).toHaveBeenLastCalledWith('sessions.lazyRestore', true)
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(prefs.set).toHaveBeenLastCalledWith('sessions.lazyRestore', false)
  })

  it('valor legado não booleano conta como desligado', async () => {
    prefs.store.set('sessions.lazyRestore', 'lazy')
    const toggle = await openSessionTab()
    await vi.waitFor(() => expect(useSessionPrefsStore.getState().loaded).toBe(true))
    expect(toggle).not.toBeChecked()
  })
})
