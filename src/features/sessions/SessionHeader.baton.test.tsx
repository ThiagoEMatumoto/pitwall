import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { SessionActivity } from '../../../shared/types/ipc'

// O chip da feature navega por @/lib/nav, que puxa a cadeia de stores (e o
// window.api, inexistente em jsdom). O alvo aqui é o bastão, não a navegação.
vi.mock('@/lib/nav', () => ({
  navigateToFeature: vi.fn(),
  navigateToObjective: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}))

const { SessionHeader } = await import('./SessionHeader')

// usePanelTier observa a largura REAL do painel; jsdom não implementa
// ResizeObserver, e sem o stub o header explode no mount. Sem callback = tier
// fica no default 'wide' (que é o caso onde as ações aparecem).
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

// haiku = janela de 200k, então `context` vira pct direto (170k = 85%).
function activityWithContext(context: number): SessionActivity {
  return {
    model: 'claude-haiku-4-5-20251001',
    tokens: { output: 0, context },
  } as SessionActivity
}

function renderHeader(over: Partial<Parameters<typeof SessionHeader>[0]> = {}) {
  const onPassBaton = vi.fn()
  render(
    <SessionHeader
      projectName="pitwall"
      repoLabel="claude-manager"
      repoPath="/repo"
      displayTitle="sessão"
      nameValue="sessão"
      isNamed
      canRename
      onCommitRename={() => {}}
      exited={false}
      activity={null}
      now={Date.now()}
      claudeNotFound={false}
      exitCode={null}
      error={null}
      mode="terminal"
      onMinimize={() => {}}
      onEndSession={() => {}}
      onPassBaton={onPassBaton}
      {...over}
    />,
  )
  return { onPassBaton }
}

describe('SessionHeader — gatilho de passar o bastão', () => {
  it('fica discreto (só ícone) com a janela de contexto folgada', () => {
    renderHeader({ activity: activityWithContext(40_000) })
    const baton = screen.getByTestId('header-pass-baton')
    expect(baton).toHaveAttribute('data-critical', 'false')
    expect(baton).not.toHaveTextContent('bastão')
    expect(baton).toHaveAttribute('aria-label', 'Passar o bastão')
  })

  it('ganha realce e rótulo a partir de 85% (o limiar do /compact)', () => {
    renderHeader({ activity: activityWithContext(170_000) })
    const baton = screen.getByTestId('header-pass-baton')
    expect(baton).toHaveAttribute('data-critical', 'true')
    expect(baton).toHaveTextContent('bastão')
    expect(baton).toHaveAttribute('aria-label', 'Passar o bastão — contexto quase cheio')
    // A distinção pro /compact é lida AQUI: o tooltip precisa carregá-la.
    expect(baton.getAttribute('title')).toContain('/compact')
    expect(baton.getAttribute('title')).toContain('continua viva')
  })

  it('sem atividade ainda (sem tokens/modelo) não promove o botão', () => {
    renderHeader({ activity: null })
    expect(screen.getByTestId('header-pass-baton')).toHaveAttribute('data-critical', 'false')
  })

  it('clique dispara a passagem de bastão', () => {
    const { onPassBaton } = renderHeader({ activity: activityWithContext(170_000) })
    fireEvent.click(screen.getByTestId('header-pass-baton'))
    expect(onPassBaton).toHaveBeenCalled()
  })

  it('sessão encerrada não oferece bastão — sem PTY viva não há o que destilar', () => {
    renderHeader({ activity: activityWithContext(170_000), exited: true })
    expect(screen.queryByTestId('header-pass-baton')).toBeNull()
  })

  it('caller que não sabe passar o bastão não vê a ação', () => {
    renderHeader({ activity: activityWithContext(170_000), onPassBaton: undefined })
    expect(screen.queryByTestId('header-pass-baton')).toBeNull()
  })

  it('convive com a ação de adoção (as duas coexistem no header)', () => {
    renderHeader({ activity: activityWithContext(170_000), onAdopt: vi.fn() })
    expect(screen.getByTestId('header-pass-baton')).toBeInTheDocument()
    expect(screen.getByLabelText('Tornar sessão filha')).toBeInTheDocument()
  })
})
