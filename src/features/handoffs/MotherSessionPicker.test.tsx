import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveSessionInfo, Repo } from '../../../shared/types/ipc'

const liveSessions: LiveSessionInfo[] = []
vi.mock('@/store/appStore', () => ({
  useAppStore: (selector: (s: { liveSessions: LiveSessionInfo[] }) => unknown) =>
    selector({ liveSessions }),
}))

const { MotherSessionPicker, motherOptionLabel } = await import('./MotherSessionPicker')

function live(over: Partial<LiveSessionInfo> = {}): LiveSessionInfo {
  return {
    id: 's1',
    ccSessionId: 'cc-1',
    name: null,
    title: null,
    status: 'idle',
    repo: null,
    projectName: null,
    projectIcon: null,
    projectColor: null,
    lastActivityAt: null,
    lastText: null,
    ...over,
  }
}

describe('motherOptionLabel', () => {
  it('apelido primeiro (é o endereço do peer), repo como desempate', () => {
    expect(
      motherOptionLabel(live({ title: 'orquestrador', repo: { label: 'legal-core' } as Repo })),
    ).toBe('orquestrador · legal-core')
  })

  it('cai no name quando não há título, e num rótulo neutro quando não há nenhum', () => {
    expect(motherOptionLabel(live({ name: 'sessão avulsa' }))).toBe('sessão avulsa')
    expect(motherOptionLabel(live({ title: '  ' }))).toBe('sessão sem nome')
  })
})

describe('MotherSessionPicker', () => {
  it('lista as sessões vivas, ignorando as encerradas e a excluída', () => {
    liveSessions.length = 0
    liveSessions.push(
      live({ id: 's1', title: 'mae' }),
      live({ id: 's2', title: 'morta', status: 'ended' }),
      live({ id: 's3', title: 'eu-mesma' }),
    )
    render(<MotherSessionPicker value={null} onChange={() => {}} excludeSessionId="s3" />)

    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['— escolher a mãe —', 'mae'])
  })

  it('sem candidata viva, explica em vez de mostrar um select vazio', () => {
    liveSessions.length = 0
    render(<MotherSessionPicker value={null} onChange={() => {}} />)
    expect(screen.queryByTestId('mother-session-picker')).toBeNull()
    expect(screen.getByText(/Nenhuma sessão viva/)).toBeInTheDocument()
  })
})
