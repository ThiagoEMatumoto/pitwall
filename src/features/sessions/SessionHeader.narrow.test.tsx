import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionActivity } from '../../../shared/types/ipc'

vi.mock('@/lib/ipc', () => ({
  featuresApi: { listWithStats: vi.fn().mockResolvedValue([]), get: vi.fn() },
  sessionsApi: { setFeature: vi.fn().mockResolvedValue(undefined), listByFeature: vi.fn() },
  loopApi: { onUpdated: vi.fn(() => () => {}) },
  motherPinsApi: new Proxy(
    {},
    {
      get: (_t, k: string) => (k.startsWith('on') ? () => () => {} : vi.fn().mockResolvedValue([])),
    },
  ),
  sessionGraphApi: {
    get: vi.fn().mockResolvedValue({ nodes: [], lanes: [], edges: [] }),
    onUpdated: vi.fn(() => () => {}),
  },
}))
vi.mock('@/lib/nav', () => ({
  navigateToFeature: vi.fn(),
  navigateToObjective: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}))

const { SessionHeader } = await import('./SessionHeader')

// O header mede a largura real do painel; aqui o observer entrega a largura do teste.
let paneWidth = 1000
const observers: Array<() => void> = []
beforeEach(() => {
  observers.length = 0
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      const fire = () =>
        this.cb(
          [{ contentRect: { width: paneWidth } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      observers.push(fire)
      fire()
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

function mount(width: number) {
  paneWidth = width
  const handlers = { onPassBaton: vi.fn(), onAdopt: vi.fn(), onToggleMode: vi.fn() }
  render(
    <SessionHeader
      projectName="pitwall"
      repoLabel="claude-manager"
      repoPath="/repo"
      displayTitle="mauricio-crie-src-greet-com-nome-bem-comprido"
      nameValue="x"
      isNamed
      canRename
      onCommitRename={() => {}}
      exited={false}
      activity={
        {
          model: 'claude-haiku-4-5-20251001',
          tokens: { output: 0, context: 40_000 },
        } as SessionActivity
      }
      now={Date.now()}
      claudeNotFound={false}
      exitCode={null}
      error={null}
      mode="chat"
      sessionId="s1"
      {...handlers}
      onMinimize={() => {}}
      onEndSession={() => {}}
    />,
  )
  return handlers
}

describe('SessionHeader em painel estreito (4 panes)', () => {
  it('720px: ações na linha, sem menu "…"', () => {
    mount(720)
    expect(screen.queryByTestId('header-overflow')).toBeNull()
    expect(screen.getByTestId('header-pass-baton')).toBeTruthy()
    expect(screen.getByText('vincular a uma frente')).toBeTruthy()
  })

  it('480px: vínculo só com ícone, secundárias no "…" e nada some', () => {
    const h = mount(480)
    expect(screen.queryByText('vincular a uma frente')).toBeNull()
    expect(screen.getByLabelText('Vincular a uma frente')).toBeTruthy()
    expect(screen.queryByTestId('header-pass-baton')).toBeNull()
    expect(screen.queryByTestId('header-mother-pin')).toBeNull()
    expect(screen.getByLabelText('Mudar para Terminal')).toBeTruthy()
    fireEvent.click(screen.getByTestId('header-overflow'))
    fireEvent.click(screen.getByText('Passar o bastão'))
    expect(h.onPassBaton).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('header-overflow'))
    expect(screen.getByText('Marcar como mãe')).toBeTruthy()
    fireEvent.click(screen.getByText('Tornar sessão filha'))
    expect(h.onAdopt).toHaveBeenCalled()
  })

  it('320px: o toggle Chat⇄Terminal também vai para o "…"; o título trunca com tooltip', () => {
    const h = mount(320)
    expect(screen.queryByLabelText('Mudar para Terminal')).toBeNull()
    fireEvent.click(screen.getByTestId('header-overflow'))
    fireEvent.click(screen.getByText('Mudar para Terminal'))
    expect(h.onToggleMode).toHaveBeenCalled()
    const left = screen.getByTestId('header-identity')
    expect(left.className).toContain('overflow-hidden')
    expect(screen.getByTitle(/mauricio-crie-src-greet-com-nome-bem-comprido/)).toBeTruthy()
  })

  it('crescer o painel devolve as ações para a linha', () => {
    mount(480)
    paneWidth = 900
    act(() => observers.forEach((f) => f()))
    expect(screen.queryByTestId('header-overflow')).toBeNull()
    expect(screen.getByTestId('header-pass-baton')).toBeTruthy()
  })
})
