import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { parseTuiMenu } from '../../../../shared/tui/tui-menu-parser'

const { sessionsApiMock } = vi.hoisted(() => ({
  sessionsApiMock: { attentionMenu: vi.fn(), attentionRespond: vi.fn() },
}))
vi.mock('@/lib/ipc', () => ({ sessionsApi: sessionsApiMock, handoffsApi: {} }))

import { useMainPermissionMenu } from './usePermissionResponder'

const curl = parseTuiMenu(
  readFileSync(
    join(__dirname, '../../../../shared/tui/__fixtures__/claude-2.1.316-permission-bash-curl.txt'),
    'utf8',
  ),
)!

describe('useMainPermissionMenu', () => {
  beforeEach(() => {
    sessionsApiMock.attentionMenu.mockReset()
    sessionsApiMock.attentionMenu.mockResolvedValue({
      sessionId: 's1',
      fingerprint: 'fp',
      menuSeq: 1,
      menu: curl,
    })
  })

  // O quick look da filha tirou permissão/trust do painel e depende deste hook;
  // o main mostra esses prompts também em starting/idle (gateMenuByStatus).
  it.each(['waiting', 'idle', 'starting'])('lê o pedido do main com status %s', async (status) => {
    const { result } = renderHook(() => useMainPermissionMenu('s1', true, status))
    await waitFor(() => expect(result.current?.kind).toBe('permission'))
  })

  it('trabalhando, não consulta nem mostra card', () => {
    const { result } = renderHook(() => useMainPermissionMenu('s1', true, 'working'))
    expect(result.current).toBeNull()
    expect(sessionsApiMock.attentionMenu).not.toHaveBeenCalled()
  })
})
