import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPrefMock, pullAllWithToastsMock } = vi.hoisted(() => ({
  getPrefMock: vi.fn(),
  pullAllWithToastsMock: vi.fn(() => Promise.resolve([])),
}))

vi.mock('./prefs-store', () => ({ getPref: getPrefMock }))
vi.mock('../ipc/git', () => ({ pullAllWithToasts: pullAllWithToastsMock }))

const {
  AUTO_PULL_ENABLED_KEY,
  AUTO_PULL_INTERVAL_MINUTES_KEY,
  rescheduleAutoPull,
  runAutoPullNow,
  stopAutoPull,
} = await import('./repo-pull-scheduler')

// Default: pref lida por chave, caindo pro fallback passado por quem chama —
// espelha o comportamento real do getPref(key, fallback).
function setPrefs(overrides: Record<string, unknown>): void {
  getPrefMock.mockImplementation((key: string, fallback: unknown) => overrides[key] ?? fallback)
}

describe('repo-pull-scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getPrefMock.mockReset()
    pullAllWithToastsMock.mockClear()
    setPrefs({})
  })

  afterEach(() => {
    stopAutoPull()
    vi.useRealTimers()
  })

  it('ligado: cria interval com o período configurado', () => {
    setPrefs({ [AUTO_PULL_ENABLED_KEY]: true, [AUTO_PULL_INTERVAL_MINUTES_KEY]: 15 })
    rescheduleAutoPull()

    expect(vi.getTimerCount()).toBe(1)
    // Menos de 15min ainda não dispara.
    vi.advanceTimersByTime(15 * 60 * 1000 - 1)
    expect(pullAllWithToastsMock).not.toHaveBeenCalled()
    // No marco dos 15min dispara.
    vi.advanceTimersByTime(1)
    expect(pullAllWithToastsMock).toHaveBeenCalledTimes(1)
  })

  it('pref ausente: agenda mesmo assim (ligado por padrão)', () => {
    setPrefs({})
    rescheduleAutoPull()

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(pullAllWithToastsMock).toHaveBeenCalledTimes(1)
  })

  it('pref ausente: runAutoPullNow roda', async () => {
    setPrefs({})
    await runAutoPullNow()
    expect(pullAllWithToastsMock).toHaveBeenCalledTimes(1)
  })

  it('desligado: não cria timer', () => {
    setPrefs({ [AUTO_PULL_ENABLED_KEY]: false })
    rescheduleAutoPull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('desligado: limpa o timer existente', () => {
    setPrefs({ [AUTO_PULL_ENABLED_KEY]: true, [AUTO_PULL_INTERVAL_MINUTES_KEY]: 10 })
    rescheduleAutoPull()
    expect(vi.getTimerCount()).toBe(1)

    setPrefs({ [AUTO_PULL_ENABLED_KEY]: false })
    rescheduleAutoPull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('mudar intervalo: reagenda com o novo período', () => {
    setPrefs({ [AUTO_PULL_ENABLED_KEY]: true, [AUTO_PULL_INTERVAL_MINUTES_KEY]: 30 })
    rescheduleAutoPull()

    setPrefs({ [AUTO_PULL_ENABLED_KEY]: true, [AUTO_PULL_INTERVAL_MINUTES_KEY]: 5 })
    rescheduleAutoPull()

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(pullAllWithToastsMock).toHaveBeenCalledTimes(1)
  })

  it('runAutoPullNow: gated pela pref, best-effort quando ligado', async () => {
    setPrefs({ [AUTO_PULL_ENABLED_KEY]: false })
    await runAutoPullNow()
    expect(pullAllWithToastsMock).not.toHaveBeenCalled()

    setPrefs({ [AUTO_PULL_ENABLED_KEY]: true })
    await runAutoPullNow()
    expect(pullAllWithToastsMock).toHaveBeenCalledTimes(1)
  })

  it('stopAutoPull: limpa o timer', () => {
    setPrefs({ [AUTO_PULL_ENABLED_KEY]: true, [AUTO_PULL_INTERVAL_MINUTES_KEY]: 10 })
    rescheduleAutoPull()
    expect(vi.getTimerCount()).toBe(1)

    stopAutoPull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
