import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPrefs = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/ipc', () => ({ prefsApi: mockPrefs }))

const { MeetingsSection } = await import('./MeetingsSection')

const detectToggle = () => screen.getByRole('checkbox', { name: /Detectar reuniões automaticamente/ })
const recordToggle = () => screen.getByRole('checkbox', { name: /Gravar automaticamente ao detectar/ })

describe('MeetingsSection', () => {
  beforeEach(() => {
    mockPrefs.get.mockReset()
    mockPrefs.set.mockClear()
  })

  it('usa os defaults (detectar ligado, gravar desligado) quando não há pref salva', async () => {
    mockPrefs.get.mockResolvedValue(null)
    render(<MeetingsSection open />)
    await vi.waitFor(() => expect(mockPrefs.get).toHaveBeenCalledWith('meeting_auto_detect'))
    expect(detectToggle()).toBeChecked()
    expect(recordToggle()).not.toBeChecked()
    expect(recordToggle()).toBeEnabled()
  })

  it('carrega as prefs salvas', async () => {
    mockPrefs.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'meeting_auto_detect' ? false : true),
    )
    render(<MeetingsSection open />)
    await vi.waitFor(() => expect(detectToggle()).not.toBeChecked())
    expect(recordToggle()).toBeChecked()
    expect(recordToggle()).toBeDisabled()
  })

  it('persiste cada toggle e desabilita a gravação automática quando a detecção é desligada', async () => {
    mockPrefs.get.mockResolvedValue(null)
    render(<MeetingsSection open />)
    await vi.waitFor(() => expect(mockPrefs.get).toHaveBeenCalledTimes(2))

    fireEvent.click(recordToggle())
    expect(mockPrefs.set).toHaveBeenCalledWith('meeting_auto_record', true)

    fireEvent.click(detectToggle())
    expect(mockPrefs.set).toHaveBeenCalledWith('meeting_auto_detect', false)
    expect(recordToggle()).toBeDisabled()
  })

  it('não lê prefs enquanto fechado', () => {
    render(<MeetingsSection open={false} />)
    expect(mockPrefs.get).not.toHaveBeenCalled()
  })
})
