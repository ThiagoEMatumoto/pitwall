import { beforeEach, describe, expect, it } from 'vitest'
import type { LiveSessionInfo } from '../../shared/types/ipc'

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          {},
          {
            get: (_t, prop) =>
              typeof prop === 'string' && prop.startsWith('on')
                ? () => () => {}
                : () => Promise.resolve(),
          },
        ),
    },
  ),
})

const { useAppStore } = await import('./appStore')

const liveOf = (id: string): LiveSessionInfo => ({
  id,
  ccSessionId: `cc-${id}`,
  name: null,
  title: null,
  status: 'working',
  repo: null,
  projectName: null,
  projectIcon: null,
  projectColor: null,
  lastActivityAt: null,
  lastText: null,
})

const mother = liveOf('s-mae')
const child = liveOf('s-child')

const paneOf = (sessionId: string) =>
  useAppStore.getState().panes.find((p) => p.session.id === sessionId)

describe('focusOrOpenSession — abrir em segundo plano', () => {
  beforeEach(async () => {
    useAppStore.setState({ panes: [], liveSessions: [mother, child] })
    // A aba em que o usuário está; depois ele foi para outra área.
    await useAppStore.getState().focusOrOpenSession(mother)
    useAppStore.setState({ area: 'features', focusPaneId: null })
  })

  it('sem a opção, cria a aba e leva o usuário até ela', async () => {
    await useAppStore.getState().focusOrOpenSession(child)

    const pane = paneOf('s-child')
    expect(pane?.background).toBeUndefined()
    expect(useAppStore.getState().area).toBe('projects')
    expect(useAppStore.getState().focusPaneId).toBe(pane?.paneId)
  })

  it('em segundo plano cria a aba, marcada, sem tirar o usuário de onde está', async () => {
    await useAppStore.getState().focusOrOpenSession(child, { background: true })

    expect(paneOf('s-child')?.background).toBe(true)
    expect(useAppStore.getState().area).toBe('features')
    expect(useAppStore.getState().focusPaneId).toBeNull()
  })

  it('em segundo plano, aba que já existe fica como está', async () => {
    const before = useAppStore.getState().panes

    await useAppStore.getState().focusOrOpenSession(mother, { background: true })

    expect(useAppStore.getState().panes).toBe(before)
    expect(useAppStore.getState().area).toBe('features')
    expect(useAppStore.getState().focusPaneId).toBeNull()
  })

  // Aba inativa precisa de outra ao lado: sozinha, o layout a mostraria vazia.
  it('em segundo plano sem nenhuma aba: entra como aba comum, sem navegar', async () => {
    useAppStore.setState({ panes: [] })

    await useAppStore.getState().focusOrOpenSession(child, { background: true })

    expect(paneOf('s-child')?.background).toBeUndefined()
    expect(useAppStore.getState().area).toBe('features')
    expect(useAppStore.getState().focusPaneId).toBeNull()
  })
})
