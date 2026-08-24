import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Handoff, LiveSessionInfo, PassBatonResult, Session } from '../../../shared/types/ipc'

const distill = vi.fn()
const pass = vi.fn()
vi.mock('@/lib/ipc', () => ({
  batonApi: {
    distill: (...args: unknown[]) => distill(...args),
    pass: (...args: unknown[]) => pass(...args),
  },
}))

const showToast = vi.fn()
vi.mock('@/features/notifications/toast-store', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}))

// A sucessora já sobe com PTY no main; o renderer só re-attacha a pane. Mockado
// pra o teste medir a UI, não o store.
const refreshLiveSessions = vi.fn().mockResolvedValue(undefined)
const focusOrOpenSession = vi.fn().mockResolvedValue(undefined)
let liveSessions: LiveSessionInfo[] = []
const appState = () => ({ liveSessions, refreshLiveSessions, focusOrOpenSession })
vi.mock('@/store/appStore', () => {
  const useAppStore = (selector: (s: ReturnType<typeof appState>) => unknown) =>
    selector(appState())
  useAppStore.getState = () => appState()
  return { useAppStore }
})

let handoffs: Handoff[] = []
vi.mock('@/store/handoffsStore', () => ({
  useHandoffsStore: (selector: (s: { handoffs: Handoff[] }) => unknown) => selector({ handoffs }),
}))

const { BatonDialog } = await import('./BatonDialog')

const successor = { id: 'sess-nova', ccSessionId: 'cc-nova' } as Session

function result(over: Partial<PassBatonResult> = {}): PassBatonResult {
  return { session: successor, handoff: null, alias: null, aliasChanged: false, ...over }
}

// act assíncrono: a destilação dispara no mount e sem esperar o tick o React
// reclama de update fora de act.
async function setup(onClose = vi.fn()) {
  await act(async () => {
    render(
      <BatonDialog
        open
        onClose={onClose}
        sessionId="sess-velha"
        ccSessionId="cc-velha"
        repoLabel="claude-manager"
      />,
    )
  })
  return { onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  liveSessions = []
  handoffs = []
  refreshLiveSessions.mockResolvedValue(undefined)
  focusOrOpenSession.mockResolvedValue(undefined)
})

describe('BatonDialog', () => {
  it('mostra estado de carga enquanto destila e some quando o briefing chega', async () => {
    let resolveDistill: (text: string) => void = () => {}
    distill.mockReturnValue(
      new Promise<string>((res) => {
        resolveDistill = res
      }),
    )
    await setup()

    expect(screen.getByTestId('baton-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('baton-briefing')).toBeNull()
    expect(distill).toHaveBeenCalledWith({ ccSessionId: 'cc-velha', note: undefined })

    await act(async () => {
      resolveDistill('## Estado atual\nmeio do refactor')
    })
    expect(screen.queryByTestId('baton-loading')).toBeNull()
    expect(screen.getByTestId('baton-briefing')).toHaveValue('## Estado atual\nmeio do refactor')
  })

  it('erro da destilação fica legível e o retry destila de novo', async () => {
    distill.mockRejectedValueOnce(new Error('timeout de 90s'))
    await setup()

    expect(screen.getByTestId('baton-error')).toHaveTextContent('timeout de 90s')
    expect(screen.queryByTestId('baton-briefing')).toBeNull()

    distill.mockResolvedValueOnce('briefing na segunda tentativa')
    await act(async () => {
      fireEvent.click(screen.getByText('Tentar de novo'))
    })
    expect(screen.queryByTestId('baton-error')).toBeNull()
    expect(screen.getByTestId('baton-briefing')).toHaveValue('briefing na segunda tentativa')
  })

  it('leva o briefing EDITADO pro baton.pass (não o destilado original)', async () => {
    distill.mockResolvedValue('briefing cru da destilação')
    pass.mockResolvedValue(result())
    const { onClose } = await setup()

    fireEvent.change(screen.getByTestId('baton-briefing'), {
      target: { value: 'briefing corrigido pelo humano' },
    })
    fireEvent.change(screen.getByTestId('baton-task'), { target: { value: 'rode os testes' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Subir a sucessora'))
    })

    expect(pass).toHaveBeenCalledWith({
      ccSessionId: 'cc-velha',
      briefing: 'briefing corrigido pelo humano',
      task: 'rode os testes',
    })
    // Sem troca de endereço não há o que avisar: fecha e o toast conta o resto.
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(screen.queryByTestId('baton-alias-changed')).toBeNull()
  })

  it('foca a sucessora e NÃO encerra a antecessora', async () => {
    distill.mockResolvedValue('briefing')
    pass.mockResolvedValue(result())
    liveSessions = [{ id: 'sess-nova', ccSessionId: 'cc-nova' } as LiveSessionInfo]
    await setup()

    await act(async () => {
      fireEvent.click(screen.getByText('Subir a sucessora'))
    })
    expect(focusOrOpenSession).toHaveBeenCalledWith(liveSessions[0])
  })

  it('avisa a troca de endereço quando o resultado traz aliasChanged', async () => {
    distill.mockResolvedValue('briefing')
    pass.mockResolvedValue(result({ alias: 'bruno-auth-refactor', aliasChanged: true }))
    const { onClose } = await setup()

    await act(async () => {
      fireEvent.click(screen.getByText('Subir a sucessora'))
    })

    const warning = screen.getByTestId('baton-alias-changed')
    expect(warning).toHaveTextContent('bruno-auth-refactor')
    // O diálogo não ENTREGA mais a nota (quem entrega é o passBaton, no main) —
    // ele continua sendo o que conta ao humano que o endereço mudou.
    expect(warning).toHaveTextContent('sessão-mãe')
    // O aviso não pode evaporar junto com o diálogo — ele fecha no "Entendi".
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Entendi'))
    expect(onClose).toHaveBeenCalled()
  })

  it('erro do pass volta pro briefing editável, sem perder o texto', async () => {
    distill.mockResolvedValue('briefing')
    pass.mockRejectedValueOnce(new Error('Briefing vazio'))
    await setup()

    fireEvent.change(screen.getByTestId('baton-briefing'), { target: { value: 'texto do humano' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Subir a sucessora'))
    })

    expect(screen.getByTestId('baton-pass-error')).toHaveTextContent('Briefing vazio')
    expect(screen.getByTestId('baton-briefing')).toHaveValue('texto do humano')
  })

  it('diz que a sucessora continua filha quando a antecessora é filha de handoff', async () => {
    distill.mockResolvedValue('briefing')
    handoffs = [
      {
        id: 'h1',
        childSessionId: 'sess-velha',
        motherSessionId: 'sess-mae',
        status: 'running',
        dismissedAt: null,
      } as Handoff,
    ]
    liveSessions = [{ id: 'sess-mae', title: 'orquestrador' } as LiveSessionInfo]
    await setup()

    expect(screen.getByTestId('baton-inherits-child')).toHaveTextContent('continua como filha')
    expect(screen.getByTestId('baton-inherits-child')).toHaveTextContent('orquestrador')
  })

  it('handoff já concluído não promete herança nenhuma', async () => {
    distill.mockResolvedValue('briefing')
    handoffs = [
      {
        id: 'h1',
        childSessionId: 'sess-velha',
        motherSessionId: 'sess-mae',
        status: 'done',
        dismissedAt: null,
      } as Handoff,
    ]
    await setup()

    expect(screen.queryByTestId('baton-inherits-child')).toBeNull()
  })
})
