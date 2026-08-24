import { act, render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AdoptedSession, LiveSessionInfo, Repo } from '../../../shared/types/ipc'

// O que se trava aqui: o AVISO de reinício (o custo que o usuário aceitou, mas
// precisa ver antes de confirmar) e a guarda de confirmação — adotar sem mãe
// escolhida não pode disparar nada, porque sem mãe não há endereço de volta.
const adoptSession = vi.fn()
vi.mock('@/lib/ipc', () => ({ handoffsApi: { adoptSession } }))

const liveSessions: LiveSessionInfo[] = [
  {
    id: 'sess-mae',
    ccSessionId: 'cc-1',
    name: null,
    title: 'orquestrador',
    status: 'idle',
    repo: { label: 'legal-core' } as Repo,
    projectName: 'lexter',
    projectIcon: null,
    projectColor: null,
    lastActivityAt: null,
    lastText: null,
  },
]
vi.mock('@/store/appStore', () => ({
  useAppStore: (selector: (s: { liveSessions: LiveSessionInfo[] }) => unknown) =>
    selector({ liveSessions }),
}))

const { AdoptSessionDialog } = await import('./AdoptSessionDialog')

function setup(onAdopted = vi.fn(), onClose = vi.fn()) {
  render(
    <AdoptSessionDialog
      open
      onClose={onClose}
      sessionId="sess-alvo"
      displayTitle="legal-core / investigação"
      onAdopted={onAdopted}
    />,
  )
  return { onAdopted, onClose }
}

beforeEach(() => {
  adoptSession.mockReset()
  adoptSession.mockResolvedValue({
    handoff: {},
    alias: 'renata-auth',
    childSessionId: 'sess-nova',
  } as unknown as AdoptedSession)
})

describe('AdoptSessionDialog', () => {
  it('avisa que a sessão reinicia e que o turno em andamento se perde', () => {
    setup()
    const warning = screen.getByTestId('adopt-restart-warning')
    expect(warning.textContent).toMatch(/REINICIADA/)
    expect(warning.textContent).toMatch(/turno em andamento se perde/)
  })

  it('confirmar sem mãe escolhida não dispara a adoção', () => {
    setup()
    fireEvent.change(screen.getByTestId('adopt-task'), { target: { value: 'arrumar o auth' } })
    const confirm = screen.getByRole('button', { name: /Adotar e reiniciar/ })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(adoptSession).not.toHaveBeenCalled()
  })

  it('confirmar sem tarefa também não dispara (o apelido precisa de escopo)', () => {
    setup()
    fireEvent.change(screen.getByTestId('mother-session-picker'), {
      target: { value: 'sess-mae' },
    })
    expect(screen.getByRole('button', { name: /Adotar e reiniciar/ })).toBeDisabled()
    expect(adoptSession).not.toHaveBeenCalled()
  })

  it('com mãe e tarefa, adota e devolve o controle ao caller (a pane fecha)', async () => {
    const { onAdopted, onClose } = setup()
    fireEvent.change(screen.getByTestId('mother-session-picker'), {
      target: { value: 'sess-mae' },
    })
    fireEvent.change(screen.getByTestId('adopt-task'), { target: { value: '  arrumar o auth  ' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Adotar e reiniciar/ }))
    })
    expect(adoptSession).toHaveBeenCalledWith({
      sessionId: 'sess-alvo',
      motherSessionId: 'sess-mae',
      task: 'arrumar o auth',
    })
    expect(onAdopted).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('erro do main aparece no diálogo, sem fechar a pane', async () => {
    adoptSession.mockRejectedValue(new Error('Transcript da sessão não foi encontrado no disco'))
    const { onAdopted } = setup()
    fireEvent.change(screen.getByTestId('mother-session-picker'), {
      target: { value: 'sess-mae' },
    })
    fireEvent.change(screen.getByTestId('adopt-task'), { target: { value: 'arrumar o auth' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Adotar e reiniciar/ }))
    })
    expect(screen.getByTestId('adopt-error').textContent).toMatch(/Transcript/)
    expect(onAdopted).not.toHaveBeenCalled()
  })
})
