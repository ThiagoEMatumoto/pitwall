import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

// O dockview monta todas as abas (defaultRenderer="always"): montar a pane
// dormant não pode acordá-la. Acorda o clique em "Retomar" e a ativação da aba.
const resumed: string[] = []
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => (input: { ccSessionId?: string } | undefined) => {
              if (ns === 'sessions' && prop === 'resume') {
                resumed.push(input!.ccSessionId!)
                return Promise.resolve({ id: 'sess-new', ccSessionId: input!.ccSessionId })
              }
              if (typeof prop === 'string' && prop.startsWith('on')) return () => {}
              return Promise.resolve()
            },
          },
        ),
    },
  ),
})

const { useAppStore } = await import('@/store/appStore')
const { DormantPane, DORMANT_BADGE } = await import('./DormantPane')
const { wakeIfDormant } = await import('./dormant-wake')
type ActivePane = import('@/store/appStore').ActivePane

const pane: ActivePane = {
  paneId: 'pane-1',
  session: {
    id: 'dormant:cc-1',
    repoId: 'r1',
    ccSessionId: 'cc-1',
    title: null,
    titleSource: null,
    paneId: 'pane-1',
    status: 'exited',
    startedAt: 1,
    endedAt: null,
    provider: 'claude',
  },
  repo: { id: 'r1', label: 'infra', path: '/tmp/infra' } as ActivePane['repo'],
  projectName: 'Infra',
  projectIcon: null,
  projectColor: null,
  mode: 'terminal',
  dormant: true,
}

function Wired() {
  const wake = useAppStore((s) => s.wakeDormantPane)
  return <DormantPane pane={pane} onWake={() => void wake(pane.paneId)} />
}

beforeEach(() => {
  resumed.length = 0
  useAppStore.setState({ panes: [pane] })
})

describe('DormantPane', () => {
  it('mostra título/repo e o badge; montar não acorda', () => {
    render(<Wired />)

    expect(screen.getByText(DORMANT_BADGE)).toBeTruthy()
    expect(DORMANT_BADGE).toBe('dormindo — clique para acordar')
    expect(screen.getAllByText('infra').length).toBeGreaterThan(0)
    expect(resumed).toEqual([])
  })

  it('"Retomar" acorda a pane no lugar', async () => {
    render(<Wired />)

    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }))
    await new Promise((r) => setTimeout(r, 0))

    expect(resumed).toEqual(['cc-1'])
    const [after] = useAppStore.getState().panes
    expect(after.paneId).toBe('pane-1')
    expect(after.dormant).toBeUndefined()
  })
})

describe('wakeIfDormant (onDidActivePanelChange)', () => {
  it('ativar a aba dormant acorda; ativar aba acordada ou inexistente não faz nada', async () => {
    wakeIfDormant('pane-1')
    await new Promise((r) => setTimeout(r, 0))
    wakeIfDormant('pane-1')
    wakeIfDormant('pane-x')
    wakeIfDormant(null)
    await new Promise((r) => setTimeout(r, 0))

    expect(resumed).toEqual(['cc-1'])
  })
})
