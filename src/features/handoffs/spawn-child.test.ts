import { beforeEach, describe, expect, it, vi } from 'vitest'

// A sequência de nascimento da filha toca dois seams: o spawn (appStore) e o
// registro do handoff (IPC). Ambos falsos aqui — o que se testa é a ORDEM e,
// principalmente, o carimbo de failed quando algo no caminho quebra.
const { markRunning, fail, spawnSessionBackground } = vi.hoisted(() => ({
  markRunning: vi.fn(),
  fail: vi.fn(),
  spawnSessionBackground: vi.fn(),
}))

vi.mock('@/lib/ipc', () => ({
  handoffsApi: {
    markRunning: (...args: unknown[]) => markRunning(...args),
    fail: (...args: unknown[]) => fail(...args),
  },
}))
vi.mock('@/store/appStore', () => ({
  useAppStore: { getState: () => ({ spawnSessionBackground }) },
}))

const { dispatchHandoffChild, handoffKickoff, handoffModeForPermission, permissionModeFor } =
  await import('./spawn-child')

beforeEach(() => {
  markRunning.mockReset().mockResolvedValue(undefined)
  fail.mockReset().mockResolvedValue(undefined)
  spawnSessionBackground.mockReset().mockResolvedValue('sess-child')
})

const plan = {
  repoId: 'repo-1',
  alias: 'mauricio-refatorar-auth',
  systemPromptText: 'briefing completo',
  featureId: 'feat-1',
  permissionMode: 'plan' as const,
}

describe('dispatchHandoffChild — caminho feliz', () => {
  it('spawna em background com o alias como nome e marca running', async () => {
    const childSessionId = await dispatchHandoffChild('h1', () => plan)

    expect(childSessionId).toBe('sess-child')
    expect(spawnSessionBackground).toHaveBeenCalledWith({
      repoId: 'repo-1',
      name: 'mauricio-refatorar-auth',
      featureId: 'feat-1',
      initialPrompt: handoffKickoff('h1'),
      systemPromptText: 'briefing completo',
      permissionMode: 'plan',
      handoffChild: true,
    })
    expect(markRunning).toHaveBeenCalledWith({ id: 'h1', childSessionId: 'sess-child' })
    expect(fail).not.toHaveBeenCalled()
  })

  it('aceita plano assíncrono (o approve resolve repo/alias por IPC)', async () => {
    await dispatchHandoffChild('h1', async () => plan)
    expect(markRunning).toHaveBeenCalledTimes(1)
  })

  it('o kickoff manda reportar com o handoffId', () => {
    expect(handoffKickoff('h9')).toContain('handoff_report com handoffId="h9"')
  })
})

describe('dispatchHandoffChild — carimbo de failed', () => {
  it('erro na preparação do plano falha o handoff e nem chega a spawnar', async () => {
    const boom = new Error('spawn-context explodiu')
    await expect(
      dispatchHandoffChild('h1', () => {
        throw boom
      }),
    ).rejects.toThrow('spawn-context explodiu')

    expect(spawnSessionBackground).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith({ id: 'h1', error: 'spawn-context explodiu' })
  })

  it('erro de spawn falha o handoff e propaga', async () => {
    spawnSessionBackground.mockRejectedValue(new Error('PTY não subiu'))
    await expect(dispatchHandoffChild('h1', () => plan)).rejects.toThrow('PTY não subiu')
    expect(fail).toHaveBeenCalledWith({ id: 'h1', error: 'PTY não subiu' })
    expect(markRunning).not.toHaveBeenCalled()
  })

  it('erro no mark-running também falha o handoff (filha viva, registro preso)', async () => {
    markRunning.mockRejectedValue(new Error('IPC caiu'))
    await expect(dispatchHandoffChild('h1', () => plan)).rejects.toThrow('IPC caiu')
    expect(fail).toHaveBeenCalledWith({ id: 'h1', error: 'IPC caiu' })
  })

  it('fail() falhando não engole o erro original', async () => {
    spawnSessionBackground.mockRejectedValue(new Error('PTY não subiu'))
    fail.mockRejectedValue(new Error('IPC indisponível'))
    await expect(dispatchHandoffChild('h1', () => plan)).rejects.toThrow('PTY não subiu')
  })
})

describe('handoffModeForPermission', () => {
  it('plan → plan e acceptEdits → auto-edits', () => {
    expect(handoffModeForPermission('plan')).toBe('plan')
    expect(handoffModeForPermission('acceptEdits')).toBe('auto-edits')
  })

  it('default e bypassPermissions caem em interactive', () => {
    expect(handoffModeForPermission('default')).toBe('interactive')
    expect(handoffModeForPermission('bypassPermissions')).toBe('interactive')
  })

  it('é o inverso de permissionModeFor nos modos que têm par', () => {
    expect(permissionModeFor(handoffModeForPermission('plan'))).toBe('plan')
    expect(permissionModeFor(handoffModeForPermission('acceptEdits'))).toBe('acceptEdits')
  })
})
