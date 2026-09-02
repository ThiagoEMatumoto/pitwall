import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MeetingLiveState, MeetingSetupStatus } from '../../../shared/types/ipc'

const idleState: MeetingLiveState = {
  active: null,
  elapsedMs: 0,
  levels: { me: 0, them: 0 },
  sttOk: true,
  lastError: null,
  captureMode: 'pipewire',
  detection: null,
  linkedStreamId: null,
}

const okSetup: MeetingSetupStatus = {
  pipewire: true,
  sink: 'alsa_output',
  source: 'alsa_input',
  stt: { ok: true, url: 'http://localhost:9000', error: null },
}

vi.mock('@/lib/ipc', () => ({
  meetingsApi: {
    start: vi.fn(),
    stop: vi.fn(),
    state: vi.fn().mockResolvedValue(idleState),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    resummarize: vi.fn(),
    actionItem: vi.fn(),
    floating: vi.fn(),
    checkSetup: vi.fn().mockResolvedValue(okSetup),
    onEvent: vi.fn(() => () => {}),
  },
}))

// Evita puxar appStore/tasksStore (cadeia pesada de IPC) só pelo link de tarefa.
vi.mock('@/lib/nav', () => ({ navigateToTask: vi.fn() }))

const { MeetingsArea } = await import('./MeetingsArea')

describe('MeetingsArea', () => {
  it('mostra o empty state quando não há reuniões', async () => {
    render(<MeetingsArea />)
    expect(await screen.findByText('Nenhuma reunião ainda')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Reuniões' })).toBeInTheDocument()
    for (const b of screen.getAllByRole('button', { name: /Iniciar gravação/ })) expect(b).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
