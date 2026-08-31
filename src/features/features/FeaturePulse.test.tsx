import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeaturePulse as Pulse } from '../../../shared/types/ipc'

vi.mock('@/lib/ipc', () => ({
  loopApi: {
    snapshot: vi.fn(),
    setPulse: vi.fn().mockResolvedValue(null),
    pulseHistory: vi.fn().mockResolvedValue([]),
    onUpdated: vi.fn(() => () => {}),
  },
}))

const { FeaturePulse } = await import('./FeaturePulse')
const { loopApi } = await import('@/lib/ipc')
const setPulseMock = loopApi.setPulse as unknown as ReturnType<typeof vi.fn>
const historyMock = loopApi.pulseHistory as unknown as ReturnType<typeof vi.fn>

function makePulse(over: Partial<Pulse> = {}): Pulse {
  return {
    id: 'p1',
    featureId: 'f1',
    body: 'Extração do TRF4 rodando em staging; falta calibrar.',
    source: 'human',
    sessionId: null,
    createdAt: Date.UTC(2026, 0, 20, 12, 0),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  historyMock.mockResolvedValue([])
  setPulseMock.mockResolvedValue(null)
})

describe('FeaturePulse', () => {
  it('sem pulso mostra o estado vazio e convida a escrever', () => {
    render(<FeaturePulse featureId="f1" pulse={null} />)
    expect(screen.getByText('sem pulso')).toBeInTheDocument()
    expect(screen.getByText(/escreva em uma frase/i)).toBeInTheDocument()
  })

  it('pulso vigente aparece com data e origem', () => {
    render(<FeaturePulse featureId="f1" pulse={makePulse()} />)
    expect(screen.getByText(/Extração do TRF4/)).toBeInTheDocument()
    expect(screen.getByTestId('pulse-source')).toHaveAttribute('data-source', 'human')
    expect(screen.getByTestId('pulse-source')).toHaveTextContent('você')
  })

  it('contador avisa e barra o salvamento acima de 200 caracteres', () => {
    render(<FeaturePulse featureId="f1" pulse={null} />)
    fireEvent.click(screen.getByText('sem pulso'))
    const textarea = screen.getByLabelText('Pulso da feature')

    fireEvent.change(textarea, { target: { value: 'a'.repeat(201) } })
    const counter = screen.getByTestId('pulse-counter')
    expect(counter).toHaveTextContent('201/200')
    expect(counter).toHaveAttribute('data-over', 'true')
    expect(screen.getByText(/Acima do limite/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Salvar pulso/ })).toBeDisabled()

    fireEvent.change(textarea, { target: { value: 'a'.repeat(200) } })
    expect(screen.getByTestId('pulse-counter')).toHaveAttribute('data-over', 'false')
    expect(screen.queryByText(/Acima do limite/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Salvar pulso/ })).toBeEnabled()
  })

  it('salvar grava com source human e avisa o dono do snapshot', async () => {
    const onSaved = vi.fn()
    render(<FeaturePulse featureId="f1" pulse={null} onSaved={onSaved} />)
    fireEvent.click(screen.getByText('sem pulso'))
    fireEvent.change(screen.getByLabelText('Pulso da feature'), {
      target: { value: '  calibração fechada  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Salvar pulso/ }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(setPulseMock).toHaveBeenCalledWith({
      featureId: 'f1',
      body: 'calibração fechada',
      source: 'human',
    })
  })

  it('histórico lista os anteriores e distingue o pulso de origem session', async () => {
    const current = makePulse()
    historyMock.mockResolvedValue([
      current,
      makePulse({ id: 'p0', body: 'Agente subiu o parser.', source: 'session', sessionId: 's1' }),
      makePulse({ id: 'p-1', body: 'Comecei a frente.', source: 'human' }),
    ])
    render(<FeaturePulse featureId="f1" pulse={current} />)
    fireEvent.click(screen.getByRole('button', { name: /histórico/ }))

    const entries = await screen.findAllByTestId('pulse-entry')
    // O vigente já está em destaque acima — o histórico só mostra os anteriores.
    expect(entries).toHaveLength(2)

    const sources = entries.map((e) => e.querySelector('[data-testid="pulse-source"]'))
    expect(sources[0]).toHaveAttribute('data-source', 'session')
    expect(sources[0]).toHaveTextContent('sessão')
    expect(sources[1]).toHaveAttribute('data-source', 'human')
    // Distinção é visual, não só textual: origens diferentes, cores diferentes.
    expect(sources[0]?.getAttribute('style')).not.toBe(sources[1]?.getAttribute('style'))
    expect(sources[0]?.getAttribute('style')).toContain('--color-accent2')
  })
})
