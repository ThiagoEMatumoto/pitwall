import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FeatureIssues } from './FeatureIssues'
import type { FeatureIssue } from './feature-issues'

function renderBand(issues: FeatureIssue[], suspect?: { candidateId: string; title: string }) {
  const props = {
    issues,
    suspect,
    onEditPulse: vi.fn(),
    onEditObjective: vi.fn(),
    onLinkOkr: vi.fn(),
    onOpenCandidate: vi.fn(),
    onArchive: vi.fn(),
  }
  const { container } = render(<FeatureIssues {...props} />)
  return { ...props, container }
}

describe('FeatureIssues', () => {
  it('sem issue não renderiza nada (faixa vazia é ruído)', () => {
    const { container } = renderBand([])
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('feature-issues')).not.toBeInTheDocument()
  })

  it('ordena por nível: error, depois warn, depois info', () => {
    renderBand([
      { level: 'info', code: 'no_repo_linked', message: 'Sem repo.' },
      { level: 'warn', code: 'pulse_missing', message: 'Sem pulso.' },
      { level: 'error', code: 'pulse_too_long', message: 'Pulso longo demais.' },
    ])
    const rows = screen.getAllByTestId('feature-issue')
    expect(rows.map((r) => r.getAttribute('data-level'))).toEqual(['error', 'warn', 'info'])
  })

  it('duplicate_suspect nomeia o candidato e leva até ele', () => {
    const props = renderBand(
      [
        {
          level: 'warn',
          code: 'duplicate_suspect',
          message: 'Possível duplicata de «Extração TRF4» (afinidade 82%).',
        },
      ],
      { candidateId: 'f9', title: 'Extração TRF4' },
    )
    const open = screen.getByTestId('feature-issue-open-candidate')
    expect(open).toHaveTextContent('Extração TRF4')
    fireEvent.click(open)
    expect(props.onOpenCandidate).toHaveBeenCalledWith('f9')

    // Mesclar é de outra fase; o que dá pra fazer aqui é arquivar esta.
    fireEvent.click(screen.getByTestId('feature-issue-archive'))
    expect(props.onArchive).toHaveBeenCalled()
  })

  it('sem candidato resolvido a duplicata vira aviso sem link morto', () => {
    renderBand([
      { level: 'warn', code: 'duplicate_suspect', message: 'Possível duplicata de «f9».' },
    ])
    expect(screen.getByTestId('feature-issue')).toBeInTheDocument()
    expect(screen.queryByTestId('feature-issue-open-candidate')).not.toBeInTheDocument()
  })

  it('cada issue de higiene dispara o editor correspondente', () => {
    const props = renderBand([
      { level: 'warn', code: 'pulse_missing', message: 'Sem pulso.' },
      { level: 'warn', code: 'objective_missing', message: 'Objetivo vazio.' },
      { level: 'info', code: 'okr_missing', message: 'Sem OKR.' },
    ])
    fireEvent.click(screen.getByTestId('feature-issue-pulse'))
    fireEvent.click(screen.getByTestId('feature-issue-objective'))
    fireEvent.click(screen.getByTestId('feature-issue-okr'))
    expect(props.onEditPulse).toHaveBeenCalled()
    expect(props.onEditObjective).toHaveBeenCalled()
    expect(props.onLinkOkr).toHaveBeenCalled()
  })

  it('issue sem ação conhecida mostra a mensagem e nenhum botão', () => {
    renderBand([
      { level: 'error', code: 'metric_point_orphan', message: '2 pontos sem coluna declarada.' },
    ])
    expect(screen.getByText('2 pontos sem coluna declarada.')).toBeInTheDocument()
    expect(screen.getByTestId('feature-issue').querySelector('button')).toBeNull()
  })
})
