import { describe, expect, it, vi } from 'vitest'
import { clearSharedAtlas, registerTerminal, type AtlasTerminal } from './terminal-atlas'

function fakeTerminal(rows = 24): AtlasTerminal {
  return { rows, clearTextureAtlas: vi.fn(), refresh: vi.fn() }
}

describe('clearSharedAtlas', () => {
  it('clears and repaints every live terminal, not just the caller', () => {
    const a = fakeTerminal(24)
    const b = fakeTerminal(40)
    const c = fakeTerminal(10)
    const off = [a, b, c].map(registerTerminal)

    clearSharedAtlas()

    for (const t of [a, b, c]) expect(t.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(a.refresh).toHaveBeenCalledWith(0, 23)
    expect(b.refresh).toHaveBeenCalledWith(0, 39)
    expect(c.refresh).toHaveBeenCalledWith(0, 9)

    off.forEach((fn) => fn())
  })

  it('does not touch a terminal that was unregistered (disposed pane)', () => {
    const alive = fakeTerminal()
    const disposed = fakeTerminal()
    const offAlive = registerTerminal(alive)
    const offDisposed = registerTerminal(disposed)

    offDisposed()
    clearSharedAtlas()

    expect(disposed.clearTextureAtlas).not.toHaveBeenCalled()
    expect(disposed.refresh).not.toHaveBeenCalled()
    expect(alive.clearTextureAtlas).toHaveBeenCalledTimes(1)

    offAlive()
  })

  it('is a no-op with no live terminals', () => {
    expect(() => clearSharedAtlas()).not.toThrow()
  })

  it('registers a terminal only once even if registered twice', () => {
    const term = fakeTerminal()
    const off1 = registerTerminal(term)
    const off2 = registerTerminal(term)

    clearSharedAtlas()
    expect(term.clearTextureAtlas).toHaveBeenCalledTimes(1)

    off1()
    off2()
  })
})
