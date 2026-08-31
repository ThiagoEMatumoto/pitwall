import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Liveness } from '../../../shared/feature-loop'
import { LivenessChip, livenessReason } from './LivenessChip'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 0, 30)

describe('LivenessChip', () => {
  it('cada liveness rende o rótulo pt-BR correspondente', () => {
    const expected: Array<[Liveness, string]> = [
      ['alive', 'vivo'],
      ['quiet', 'silêncio'],
      ['broken', 'quebrado'],
      ['paused', 'pausado'],
      ['done', 'concluído'],
    ]
    for (const [liveness, label] of expected) {
      const { unmount } = render(<LivenessChip liveness={liveness} lastActivityAt={NOW} now={NOW} />)
      const chip = screen.getByTestId('liveness-chip')
      expect(chip).toHaveAttribute('data-liveness', liveness)
      expect(chip).toHaveTextContent(label)
      unmount()
    }
  })

  it('tooltip de silêncio conta os dias desde a última atividade', () => {
    render(<LivenessChip liveness="quiet" lastActivityAt={NOW - 23 * DAY} now={NOW} />)
    expect(screen.getByTestId('liveness-chip')).toHaveAttribute(
      'title',
      'Silêncio: sem atividade há 23 dias.',
    )
  })

  it('tooltip de quebrado cita a issue de erro que causou o veredito', () => {
    render(
      <LivenessChip
        liveness="broken"
        lastActivityAt={NOW}
        now={NOW}
        issues={[
          { level: 'warn', code: 'objective_missing', message: 'Objetivo vazio.' },
          { level: 'error', code: 'pulse_too_long', message: 'Pulso com 240 caracteres.' },
        ]}
      />,
    )
    expect(screen.getByTestId('liveness-chip')).toHaveAttribute(
      'title',
      'Quebrado: Pulso com 240 caracteres.',
    )
  })

  it('sem timestamp de atividade o motivo não inventa contagem de dias', () => {
    expect(livenessReason('alive', null, [], NOW)).toBe('Vivo: tocada dentro da cadência esperada.')
    expect(livenessReason('alive', NOW, [], NOW)).toBe('Vivo: tocada hoje.')
    expect(livenessReason('quiet', NOW - DAY, [], NOW)).toBe('Silêncio: sem atividade há 1 dia.')
  })
})
