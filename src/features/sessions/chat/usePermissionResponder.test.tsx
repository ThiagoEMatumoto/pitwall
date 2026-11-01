import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { parseTuiMenu } from '../../../../shared/tui/tui-menu-parser'

const { sessionsApiMock } = vi.hoisted(() => ({
  sessionsApiMock: { attentionMenu: vi.fn(), attentionRespond: vi.fn() },
}))
vi.mock('@/lib/ipc', () => ({ sessionsApi: sessionsApiMock, handoffsApi: {} }))

import { useMainPermissionMenu, usePermissionResponder } from './usePermissionResponder'
import type { TuiMenu } from '../../../../shared/types/ipc'

const capture = (name: string) =>
  parseTuiMenu(
    readFileSync(
      join(__dirname, `../../../../shared/tui/__fixtures__/claude-2.1.316-${name}.txt`),
      'utf8',
    ),
  )!
const curl = capture('permission-bash-curl')

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

describe('usePermissionResponder — "Enviado" pertence ao pedido respondido', () => {
  beforeEach(() => {
    sessionsApiMock.attentionMenu.mockReset()
    sessionsApiMock.attentionRespond.mockReset()
    sessionsApiMock.attentionMenu.mockImplementation(async () => ({
      sessionId: 's1',
      fingerprint: 'fp',
      menuSeq: 1,
      menu: current,
    }))
    sessionsApiMock.attentionRespond.mockResolvedValue({ ok: true })
  })
  let current: TuiMenu = curl

  function mount(first: TuiMenu) {
    current = first
    return renderHook(({ menu }) => usePermissionResponder({ sessionId: 's1', menu }), {
      initialProps: { menu: first },
    })
  }

  it('pedido novo dentro dos 3s não herda o "Enviado" do anterior', async () => {
    const { result, rerender } = mount(curl)
    await act(() => result.current.decide({ type: 'select', optionIndex: 0, label: 'Yes' }))
    expect(result.current.sentLabel).toBe('Yes')
    const next = capture('named-permission-bash')
    current = next
    rerender({ menu: next })
    expect(result.current.sentLabel).toBeUndefined()
  })

  it('amend: a TUI reescrevendo o label do No não reabre o card', async () => {
    const open = capture('permission-bash-amend-open')
    const { result, rerender } = mount(open)
    await act(() =>
      result.current.decide({
        type: 'amend',
        optionIndex: 3,
        label: 'Negado: use wget em vez de curl',
        text: 'use wget em vez de curl',
      }),
    )
    const typed = capture('permission-bash-amend-typed')
    current = typed
    rerender({ menu: typed })
    expect(result.current.sentLabel).toBe('Negado: use wget em vez de curl')
  })
})
