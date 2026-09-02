import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPrefs = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/ipc', () => ({ prefsApi: mockPrefs }))

const { MeetingsSection } = await import('./MeetingsSection')

const PREF_KEYS = [
  'meeting_auto_detect',
  'meeting_auto_record',
  'meeting_diarization',
  'meeting_summary_model',
  'meeting_auto_create_tasks',
  'meeting_my_name',
]

const detectToggle = () => screen.getByRole('checkbox', { name: /Detectar reuniões automaticamente/ })
const recordToggle = () => screen.getByRole('checkbox', { name: /Gravar automaticamente ao detectar/ })
const diarizationToggle = () => screen.getByRole('checkbox', { name: /Diarização/ })
const autoTasksToggle = () => screen.getByRole('checkbox', { name: /Criar tarefas automaticamente/ })
const modelSelect = () => screen.getByRole('combobox', { name: /Modelo do resumo/ })
const myNameInput = () => screen.getByRole('textbox', { name: /Meu nome/ })

describe('MeetingsSection', () => {
  beforeEach(() => {
    mockPrefs.get.mockReset()
    mockPrefs.set.mockClear()
  })

  it('usa os defaults quando não há pref salva', async () => {
    mockPrefs.get.mockResolvedValue(null)
    render(<MeetingsSection open />)
    await vi.waitFor(() => expect(mockPrefs.get).toHaveBeenCalledTimes(PREF_KEYS.length))
    for (const key of PREF_KEYS) expect(mockPrefs.get).toHaveBeenCalledWith(key)
    expect(detectToggle()).toBeChecked()
    expect(recordToggle()).not.toBeChecked()
    expect(recordToggle()).toBeEnabled()
    expect(diarizationToggle()).toBeChecked()
    expect(autoTasksToggle()).not.toBeChecked()
    expect(modelSelect()).toHaveValue('sonnet')
    expect(myNameInput()).toHaveValue('')
  })

  it('carrega as prefs salvas', async () => {
    const saved: Record<string, unknown> = {
      meeting_auto_detect: false,
      meeting_auto_record: true,
      meeting_diarization: false,
      meeting_summary_model: 'opus',
      meeting_auto_create_tasks: true,
      meeting_my_name: 'Thiago',
    }
    mockPrefs.get.mockImplementation((key: string) => Promise.resolve(saved[key]))
    render(<MeetingsSection open />)
    await vi.waitFor(() => expect(detectToggle()).not.toBeChecked())
    expect(recordToggle()).toBeChecked()
    expect(recordToggle()).toBeDisabled()
    await vi.waitFor(() => expect(diarizationToggle()).not.toBeChecked())
    expect(autoTasksToggle()).toBeChecked()
    expect(modelSelect()).toHaveValue('opus')
    expect(myNameInput()).toHaveValue('Thiago')
  })

  it('modelo fora da lista cai pro sonnet', async () => {
    mockPrefs.get.mockImplementation((key: string) => Promise.resolve(key === 'meeting_summary_model' ? 'gpt-5' : null))
    render(<MeetingsSection open />)
    await vi.waitFor(() => expect(mockPrefs.get).toHaveBeenCalledTimes(PREF_KEYS.length))
    expect(modelSelect()).toHaveValue('sonnet')
  })

  it('persiste cada controle e desabilita a gravação automática quando a detecção é desligada', async () => {
    mockPrefs.get.mockResolvedValue(null)
    render(<MeetingsSection open />)
    await vi.waitFor(() => expect(mockPrefs.get).toHaveBeenCalledTimes(PREF_KEYS.length))

    fireEvent.click(recordToggle())
    expect(mockPrefs.set).toHaveBeenCalledWith('meeting_auto_record', true)

    fireEvent.click(detectToggle())
    expect(mockPrefs.set).toHaveBeenCalledWith('meeting_auto_detect', false)
    expect(recordToggle()).toBeDisabled()

    fireEvent.click(diarizationToggle())
    expect(mockPrefs.set).toHaveBeenCalledWith('meeting_diarization', false)

    fireEvent.click(autoTasksToggle())
    expect(mockPrefs.set).toHaveBeenCalledWith('meeting_auto_create_tasks', true)

    fireEvent.change(modelSelect(), { target: { value: 'opus' } })
    expect(mockPrefs.set).toHaveBeenCalledWith('meeting_summary_model', 'opus')

    fireEvent.change(myNameInput(), { target: { value: '  Thiago ' } })
    expect(mockPrefs.set).not.toHaveBeenCalledWith('meeting_my_name', expect.anything())
    fireEvent.blur(myNameInput())
    expect(mockPrefs.set).toHaveBeenCalledWith('meeting_my_name', 'Thiago')
  })

  it('não lê prefs enquanto fechado', () => {
    render(<MeetingsSection open={false} />)
    expect(mockPrefs.get).not.toHaveBeenCalled()
  })
})
