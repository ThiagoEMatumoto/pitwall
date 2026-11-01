import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    { get: (_t, k: string) => (k.startsWith('on') ? () => () => {} : () => Promise.resolve(null)) },
  )
  return new Proxy({}, { get: () => inert })
})
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '0' } }))

import { formatWakeEnvelope } from '../../../electron/main/services/handoff/handoff-wake'
import { TailLine } from './MotherTile'

describe('MotherTile — linha do tail', () => {
  it('atualização das filhas vira uma linha legível, sem XML', () => {
    const env = formatWakeEnvelope(
      [
        {
          handoffId: 'h-1',
          alias: 'mauricio-greet',
          status: 'done',
          reasons: ['reported'],
          body: 'PR aberto',
          truncated: false,
        },
      ],
      0,
    )
    const { container } = render(<TailLine m={{ kind: 'user', text: env }} title="Mãe" />)
    expect(container.textContent).toBe('filhas: mauricio-greet reportou')
  })
})
