import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingLiveState, MeetingSetupStatus } from '../../../shared/types/ipc'

vi.mock('@/lib/ipc', () => ({ meetingsApi: { state: vi.fn(), onEvent: vi.fn(() => () => {}) } }))

const { MIC_GAIN_COMMAND, SetupBanner, micLow, setupProblems } = await import('./SetupBanner')
const { useMeetingsStore } = await import('@/store/meetingsStore')

const ok: MeetingSetupStatus = {
  pipewire: true,
  sink: 'alsa_output.x',
  source: 'alsa_input.headset',
  stt: { ok: true, url: 'https://stt', error: null },
  micLevel: { dbfs: -20, source: 'alsa_input.headset', low: false },
  diarization: { supported: false, addon: false, models: { segmentation: 'missing', embedding: 'missing', progress: null } },
}

const live: MeetingLiveState = {
  active: null,
  elapsedMs: 0,
  levels: { me: 0, them: 0 },
  sttOk: true,
  lastError: null,
  captureMode: 'pipewire',
  detection: null,
  linkedStreamId: null,
  micWarning: null,
  diarization: 'off',
}

describe('SetupBanner', () => {
  beforeEach(() => {
    useMeetingsStore.setState({ live: null })
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('não renderiza nada com setup ok e mic normal', () => {
    const { container } = render(<SetupBanner setup={ok} ignorePipewire={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('mic baixo no setup mostra o aviso com o comando e copia sem alterar volume', async () => {
    const setup = { ...ok, micLevel: { dbfs: -48.4, source: 'alsa_input.headset', low: true } }
    render(<SetupBanner setup={setup} ignorePipewire={false} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Microfone muito baixo (-48 dBFS em alsa_input.headset). Suba o ganho:')
    expect(alert).toHaveTextContent('wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 0.7')
    fireEvent.click(screen.getByTitle('Copiar comando'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(MIC_GAIN_COMMAND)
    // mic baixo não bloqueia o start: não entra nos problemas do setup
    expect(setupProblems(setup, false)).toEqual([])
  })

  it('micWarning da gravação em curso vence a medição do setup', () => {
    useMeetingsStore.setState({ live: { ...live, micWarning: { dbfs: -51, source: 'alsa_input.usb' } } })
    render(<SetupBanner setup={ok} ignorePipewire={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('-51 dBFS em alsa_input.usb')
    expect(micLow(ok, null)).toBeNull()
    expect(micLow(null, { dbfs: -50, source: 's' })).toEqual({ dbfs: -50, source: 's' })
  })

  it('problemas de setup continuam listados junto do aviso de mic', () => {
    const setup = { ...ok, stt: { ok: false, url: null, error: null }, micLevel: { dbfs: -45, source: 's', low: true } }
    render(<SetupBanner setup={setup} ignorePipewire={false} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('VOZ_STT_URL')
    expect(alert).toHaveTextContent('Microfone muito baixo')
  })
})
