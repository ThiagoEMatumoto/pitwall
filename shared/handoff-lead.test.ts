import { describe, expect, it } from 'vitest'
import { isLedByMother } from './handoff-lead'

const base = { dismissedAt: null, resumable: false }

describe('isLedByMother', () => {
  it('conta os status ativos', () => {
    for (const status of ['pending', 'approved', 'running', 'needs_input'] as const) {
      expect(isLedByMother({ ...base, status })).toBe(true)
    }
  })

  it('interrompida só conta se retomável', () => {
    expect(isLedByMother({ ...base, status: 'interrupted' })).toBe(false)
    expect(isLedByMother({ ...base, status: 'interrupted', resumable: true })).toBe(true)
  })

  it('terminais não contam', () => {
    for (const status of ['done', 'failed', 'rejected'] as const) {
      expect(isLedByMother({ ...base, status, resumable: true })).toBe(false)
    }
  })

  it('dispensada nunca conta, nem ativa', () => {
    expect(isLedByMother({ status: 'running', dismissedAt: 1, resumable: false })).toBe(false)
    expect(isLedByMother({ status: 'interrupted', dismissedAt: 1, resumable: true })).toBe(false)
  })
})
