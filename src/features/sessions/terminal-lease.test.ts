import { beforeEach, describe, expect, it } from 'vitest'
import { leaseBlocks, useTerminalLease } from './terminal-lease'

describe('terminal-lease', () => {
  beforeEach(() => useTerminalLease.setState({ leases: {}, stacks: {} }))

  it('acquire entrega a PTY à modal e release devolve', () => {
    useTerminalLease.getState().acquire('s1', 'modal')
    expect(useTerminalLease.getState().leases.s1).toBe('modal')
    useTerminalLease.getState().release('s1', 'modal')
    expect(useTerminalLease.getState().leases.s1).toBeUndefined()
  })

  it('release de quem não é o dono não solta a lease', () => {
    useTerminalLease.getState().acquire('s1', 'modal')
    useTerminalLease.getState().release('s2', 'modal')
    expect(useTerminalLease.getState().leases.s1).toBe('modal')
  })

  it('a aba (sem host) cede à modal; a própria modal não se bloqueia', () => {
    expect(leaseBlocks(undefined, undefined)).toBe(false)
    expect(leaseBlocks('modal', undefined)).toBe(true)
    expect(leaseBlocks('modal', 'modal')).toBe(false)
  })

  it('coluna que adquire depois da modal fica POR BAIXO dela (bastão seguindo)', () => {
    const lease = useTerminalLease.getState()
    lease.acquire('s1', 'modal')
    lease.acquire('s1', 'dock')
    expect(useTerminalLease.getState().leases.s1).toBe('modal')
    expect(useTerminalLease.getState().stacks.s1).toEqual(['dock', 'modal'])
    useTerminalLease.getState().release('s1', 'modal')
    expect(useTerminalLease.getState().leases.s1).toBe('dock')
  })
})
