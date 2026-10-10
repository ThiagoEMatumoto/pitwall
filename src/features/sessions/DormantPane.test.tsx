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

function Wired({ tabTitle, target = pane }: { tabTitle?: string; target?: ActivePane }) {
  const wake = useAppStore((s) => s.wakeDormantPane)
  return <DormantPane pane={target} tabTitle={tabTitle} onWake={() => void wake(target.paneId)} />
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

    fireEvent.click(screen.getByRole('button', { name: 'Retomar infra' }))
    await new Promise((r) => setTimeout(r, 0))

    expect(resumed).toEqual(['cc-1'])
    const [after] = useAppStore.getState().panes
    expect(after.paneId).toBe('pane-1')
    expect(after.dormant).toBeUndefined()
  })

  it('o badge também acorda e é um botão (teclado)', async () => {
    render(<Wired />)

    const badge = screen.getByRole('button', { name: DORMANT_BADGE })
    expect(badge.tagName).toBe('BUTTON')
    fireEvent.click(badge)
    await new Promise((r) => setTimeout(r, 0))

    expect(resumed).toEqual(['cc-1'])
  })

  it('título = rótulo da aba; repo só como subtítulo; ícone decorativo oculto', () => {
    const { container } = render(<Wired tabTitle="lazy-B" />)

    expect(screen.getByText('lazy-B')).toBeTruthy()
    expect(screen.getByText('Infra · infra')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retomar lazy-B' })).toBeTruthy()
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('session.title (do sync) ganha do rótulo da aba, que pode ter caído em "Avulsa"', () => {
    const titled: ActivePane = {
      ...pane,
      repo: null,
      projectName: null,
      session: { ...pane.session, title: 'lazy-C' },
    }
    render(<Wired target={titled} tabTitle="Avulsa" />)

    expect(screen.getByText('lazy-C')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retomar lazy-C' })).toBeTruthy()
  })

  it('avulsa sem rótulo de aba: "Avulsa" aparece uma vez só', () => {
    const avulsa: ActivePane = { ...pane, repo: null, projectName: null }
    useAppStore.setState({ panes: [avulsa] })
    render(<Wired target={avulsa} />)

    expect(screen.getAllByText('Avulsa')).toHaveLength(1)
  })
})

describe('wakeIfDormant (onDidActivePanelChange)', () => {
  it('ativar a aba dormant acorda; ativar aba acordada ou inexistente não faz nada', async () => {
    useAppStore.setState({ lazyRestore: true })
    wakeIfDormant('pane-1')
    await new Promise((r) => setTimeout(r, 0))
    wakeIfDormant('pane-1')
    wakeIfDormant('pane-x')
    wakeIfDormant(null)
    await new Promise((r) => setTimeout(r, 0))

    expect(resumed).toEqual(['cc-1'])
  })

  it('pref desligada: ativar a aba não acorda (só o botão Retomar)', async () => {
    useAppStore.setState({ lazyRestore: false })
    wakeIfDormant('pane-1')
    await new Promise((r) => setTimeout(r, 0))
    expect(resumed).toEqual([])
    useAppStore.setState({ lazyRestore: null })
    wakeIfDormant('pane-1')
    await new Promise((r) => setTimeout(r, 0))
    expect(resumed).toEqual([])
  })
})
