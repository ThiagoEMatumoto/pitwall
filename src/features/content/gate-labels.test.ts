import { describe, expect, it } from 'vitest'
import type { ContentGateKind, ContentGateRun, ContentGateStatus } from '../../../shared/types/ipc'
import { GATE_KIND_LABEL, GATE_OUTCOME_COLOR, GATE_OUTCOME_LABEL, gateOutcome } from './gate-labels'

function run(status: ContentGateStatus, blockingCount: number) {
  return { status, blockingCount } satisfies Pick<ContentGateRun, 'status' | 'blockingCount'>
}

describe('gateOutcome', () => {
  it('passa quando o gate passou sem achado bloqueante', () => {
    expect(gateOutcome(run('passed', 0))).toBe('passed')
    expect(GATE_OUTCOME_LABEL[gateOutcome(run('passed', 0))]).toBe('Passou')
  })

  it('reprova sem bloquear quando só há aviso', () => {
    expect(gateOutcome(run('failed', 0))).toBe('failed')
    expect(GATE_OUTCOME_LABEL[gateOutcome(run('failed', 0))]).toBe('Reprovou')
  })

  // O caso que a tela existe pra tornar legível: passed:false + blocking:true é
  // NÃO ENTREGÁVEL, e precisa de rótulo próprio — "reprovou" não diz isso.
  it('rotula bloqueio quando reprovou com achado bloqueante', () => {
    expect(gateOutcome(run('failed', 2))).toBe('blocked')
    expect(GATE_OUTCOME_LABEL[gateOutcome(run('failed', 2))]).toBe('Bloqueante')
    expect(GATE_OUTCOME_COLOR[gateOutcome(run('failed', 2))]).toBe('var(--color-danger)')
  })

  // Defesa contra gravação inconsistente: achado bloqueante nunca pode ser lido
  // como aprovação, mesmo que o status tenha sido persistido como 'passed'.
  it('bloqueia mesmo com status passed quando há bloqueante contado', () => {
    expect(gateOutcome(run('passed', 1))).toBe('blocked')
  })

  it('mantém skipped e error fora do eixo passou/reprovou', () => {
    expect(gateOutcome(run('skipped', 0))).toBe('skipped')
    // Falha de execução do gate não é aprovação nem reprovação do material.
    expect(gateOutcome(run('error', 0))).toBe('error')
    expect(gateOutcome(run('error', 3))).toBe('error')
  })
})

describe('GATE_KIND_LABEL', () => {
  it('cobre os seis gates', () => {
    const kinds: ContentGateKind[] = [
      'tone-lint',
      'forbidden-facts',
      'scope',
      'scope-checklist',
      'delivery-limit',
      'positive-evidence',
    ]
    for (const k of kinds) expect(GATE_KIND_LABEL[k]).toBeTruthy()
  })
})
