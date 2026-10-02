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
const { useProjectsViewStore } = await import('@/features/session-canvas/projects-view-store')

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
  useProjectsViewStore.setState({ view: 'terminals' })
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

    expect(screen.getByTestId('baton-error')).toHaveTextContent(
      'Não deu para resumir esta sessão automaticamente — escreva o briefing abaixo',
    )
    expect(screen.getByTestId('baton-error')).not.toHaveTextContent('timeout de 90s')
    // O campo segue disponível: a falha da destilação não tranca o bastão.
    expect(screen.getByTestId('baton-briefing')).toHaveValue('')

    distill.mockResolvedValueOnce('briefing na segunda tentativa')
    await act(async () => {
      fireEvent.click(screen.getByText('Tentar de novo'))
    })
    expect(screen.queryByTestId('baton-error')).toBeNull()
    expect(screen.getByTestId('baton-briefing')).toHaveValue('briefing na segunda tentativa')
  })

  it('erro da destilação não mostra erro cru (prefixo do IPC, UUID, caminho)', async () => {
    distill.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'baton:distill': Error: Transcript não encontrado: /home/u/.claude/projects/x/3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f.jsonl",
      ),
    )
    await setup()

    const box = screen.getByTestId('baton-error')
    expect(box).toHaveTextContent('escreva o briefing abaixo')
    expect(box).not.toHaveTextContent('remote method')
    expect(box).not.toHaveTextContent('Error:')
    expect(box).not.toHaveTextContent('3f2a9c1e')
    expect(box).not.toHaveTextContent('/home/u')
  })

  it('fallback da destilação é aviso (amber), com "Tentar de novo" na mesma linha', async () => {
    distill.mockRejectedValueOnce(new Error('timeout'))
    await setup()
    const box = screen.getByTestId('baton-error')
    expect(box.getAttribute('style')).toContain('--color-warning')
    expect(box.getAttribute('style')).not.toContain('--color-danger')
    expect(box.className).toContain('items-center')
    expect(box.className).not.toContain('flex-col')
    expect(box).toContainElement(screen.getByRole('button', { name: 'Tentar de novo' }))
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

  it('com o mapa na frente, NÃO foca a aba da sucessora (o mapa e a coluna da mãe ficam)', async () => {
    useProjectsViewStore.setState({ view: 'map' })
    distill.mockResolvedValue('briefing')
    pass.mockResolvedValue(result())
    liveSessions = [{ id: 'sess-nova', ccSessionId: 'cc-nova' } as LiveSessionInfo]
    await setup()

    await act(async () => {
      fireEvent.click(screen.getByText('Subir a sucessora'))
    })
    expect(refreshLiveSessions).toHaveBeenCalled()
    expect(focusOrOpenSession).not.toHaveBeenCalled()
    expect(useProjectsViewStore.getState().view).toBe('map')
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'A sucessora subiu' }))
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

  it('destilação falhou: o briefing escrito à mão sobe a sucessora', async () => {
    distill.mockRejectedValue(new Error('Transcript não encontrado'))
    pass.mockResolvedValue(result())
    await setup()

    expect(screen.getByTestId('baton-confirm')).toBeDisabled()
    // Botão desabilitado diz por quê (no print 09 ele só parecia apagado).
    expect(screen.getByTestId('baton-briefing-required')).toBeInTheDocument()
    // Uma ação de regerar só: o "Tentar de novo" do aviso.
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Destilar de novo' })).toBeNull()
    fireEvent.change(screen.getByTestId('baton-briefing'), {
      target: { value: 'escrito à mão' },
    })
    expect(screen.getByTestId('baton-confirm')).toBeEnabled()
    expect(screen.queryByTestId('baton-briefing-required')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('baton-confirm'))
    })
    expect(pass).toHaveBeenCalledWith(expect.objectContaining({ briefing: 'escrito à mão' }))
    expect(screen.queryByTestId('baton-pass-error')).toBeNull()
  })

  it('"Escrever à mão" sai da espera e a destilação atrasada não sobrescreve', async () => {
    let resolveDistill: (text: string) => void = () => {}
    distill.mockReturnValue(
      new Promise<string>((res) => {
        resolveDistill = res
      }),
    )
    await setup()
    fireEvent.click(screen.getByTestId('baton-write-manual'))
    fireEvent.change(screen.getByTestId('baton-briefing'), { target: { value: 'meu texto' } })
    await act(async () => {
      resolveDistill('destilado atrasado')
    })
    expect(screen.getByTestId('baton-briefing')).toHaveValue('meu texto')
  })

  it('modo mãe: lista as filhas e avisa da liderança', async () => {
    distill.mockResolvedValue('briefing')
    handoffs = [
      {
        id: 'h1',
        motherSessionId: 'sess-velha',
        childSessionId: 'c1',
        status: 'running',
        task: 'Mapa',
      },
      {
        id: 'h2',
        motherSessionId: 'sess-velha',
        childSessionId: 'c2',
        status: 'needs_input',
        task: 'Modal',
      },
      {
        id: 'h3',
        motherSessionId: 'sess-velha',
        childSessionId: 'c3',
        status: 'done',
        task: 'Velha',
      },
      // Mesmo recorte do bastão (isLedByMother): interrompida sem retomada e
      // dispensada não são filhas.
      {
        id: 'h4',
        motherSessionId: 'sess-velha',
        childSessionId: 'c4',
        status: 'interrupted',
        resumable: false,
        task: 'Morta',
      },
      {
        id: 'h5',
        motherSessionId: 'sess-velha',
        childSessionId: 'c5',
        status: 'running',
        dismissedAt: 1,
        task: 'Dispensada',
      },
    ] as Handoff[]
    liveSessions = [
      { id: 'c1', title: 'mauricio-mapa' },
      { id: 'c2', title: 'otavio-modal' },
    ] as LiveSessionInfo[]
    await setup()

    const box = screen.getByTestId('baton-mother-mode')
    expect(box).toHaveTextContent('2 filhas')
    expect(box).toHaveTextContent('mauricio-mapa')
    expect(box).toHaveTextContent('otavio-modal')
    expect(box).not.toHaveTextContent('Velha')
    expect(box).not.toHaveTextContent('Morta')
    expect(box).not.toHaveTextContent('Dispensada')
    expect(screen.getByText('Passar o bastão da mãe')).toBeInTheDocument()
  })

  it('bastão da mãe passado: toast com quantas filhas e o alias novo', async () => {
    distill.mockResolvedValue('briefing')
    pass.mockResolvedValue(result({ alias: 'ana-mc', relinkedChildren: 2 }))
    const { onClose } = await setup()
    await act(async () => {
      fireEvent.click(screen.getByTestId('baton-confirm'))
    })
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Bastão da mãe passado',
        body: expect.stringContaining('ana-mc'),
      }),
    )
    expect(onClose).toHaveBeenCalled()
  })

  // Mãe que também é filha de um handoff: o endereço muda para a avó também, e o
  // aviso 'passed' (o SendMessage da avó ainda aponta para o nome antigo) não
  // pode sumir atrás do toast das filhas.
  it('mãe que também é filha: toast das filhas E aviso de endereço trocado', async () => {
    distill.mockResolvedValue('briefing')
    pass.mockResolvedValue(result({ alias: 'ana-mc', aliasChanged: true, relinkedChildren: 2 }))
    const { onClose } = await setup()
    await act(async () => {
      fireEvent.click(screen.getByTestId('baton-confirm'))
    })
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bastão da mãe passado' }),
    )
    expect(screen.getByTestId('baton-alias-changed')).toHaveTextContent('ana-mc')
    expect(onClose).not.toHaveBeenCalled()
  })
})
