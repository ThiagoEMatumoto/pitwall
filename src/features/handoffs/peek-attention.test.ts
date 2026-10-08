import { describe, expect, it, vi } from 'vitest'

// O helper importa isActionableDetail do popover, que puxa os stores (e o IPC).
vi.mock('@/lib/ipc', () => new Proxy({}, { get: () => ({}) }))

import { peekAttentionItem } from './peek-attention'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

const LIVE: LiveSessionInfo = {
  id: 's1',
  ccSessionId: 'cc-1',
  name: 'mauricio-auth',
  title: null,
  status: 'waiting',
  repo: null,
  projectName: 'P',
  projectIcon: null,
  projectColor: null,
  lastActivityAt: 100,
  lastText: null,
}
const HANDOFF = { id: 'h1' } as Handoff

describe('peekAttentionItem', () => {
  it('menu respondível da filha vira item crew com o sessionId da PTY', () => {
    expect(peekAttentionItem({ ...LIVE, attentionReason: 'permission' }, HANDOFF)).toMatchObject({
      kind: 'crew',
      sessionId: 's1',
      handoffId: 'h1',
      detail: 'permission',
      liveStatus: 'waiting',
      title: 'mauricio-auth',
    })
  })

  it('sem menu (fim de turno, pergunta de handoff, sem motivo) ou sem sessão: nada', () => {
    expect(peekAttentionItem({ ...LIVE, attentionReason: 'turn-end' }, HANDOFF)).toBeNull()
    expect(peekAttentionItem({ ...LIVE, attentionReason: 'handoff-input' }, HANDOFF)).toBeNull()
    expect(peekAttentionItem(LIVE, HANDOFF)).toBeNull()
    expect(peekAttentionItem(null, HANDOFF)).toBeNull()
  })
})
