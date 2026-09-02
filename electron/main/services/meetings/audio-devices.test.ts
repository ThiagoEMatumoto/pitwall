/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { hasPipewire, parseNodeName, resolveDefaultDevices, type Exec } from './audio-devices'

const SINK_OUTPUT = `id 58, type PipeWire:Interface:Node
    node.name = "alsa_output.usb-Actions_USB_Audio___HID_0123456789AC-01.analog-stereo"
    node.nick = "USB Audio"
  * media.class = "Audio/Sink"`

const SOURCE_OUTPUT = `id 60, type PipeWire:Interface:Node
    node.name = "alsa_input.usb-Actions_USB_Audio___HID_0123456789AC-01.mono-fallback"`

describe('parseNodeName', () => {
  it('extrai node.name entre aspas', () => {
    expect(parseNodeName(SINK_OUTPUT)).toBe(
      'alsa_output.usb-Actions_USB_Audio___HID_0123456789AC-01.analog-stereo',
    )
    expect(parseNodeName('sem nada')).toBeNull()
  })
})

describe('resolveDefaultDevices', () => {
  it('chama wpctl inspect para sink e source', async () => {
    const exec = vi.fn<Exec>(async (_cmd, args) => ({
      stdout: args[1] === '@DEFAULT_AUDIO_SINK@' ? SINK_OUTPUT : SOURCE_OUTPUT,
    }))
    const devices = await resolveDefaultDevices(exec)
    expect(devices.sink).toMatch(/^alsa_output\./)
    expect(devices.source).toMatch(/^alsa_input\./)
    expect(exec).toHaveBeenCalledWith('wpctl', ['inspect', '@DEFAULT_AUDIO_SINK@'])
    expect(exec).toHaveBeenCalledWith('wpctl', ['inspect', '@DEFAULT_AUDIO_SOURCE@'])
  })

  it('devolve null quando wpctl falha', async () => {
    const exec = vi.fn<Exec>(async () => {
      throw new Error('ENOENT')
    })
    expect(await resolveDefaultDevices(exec)).toEqual({ sink: null, source: null })
  })
})

describe('hasPipewire', () => {
  it('true quando which acha pw-record, false caso contrário', async () => {
    expect(await hasPipewire(async () => ({ stdout: '/usr/bin/pw-record\n' }))).toBe(true)
    expect(await hasPipewire(async () => ({ stdout: '' }))).toBe(false)
    expect(
      await hasPipewire(async () => {
        throw new Error('exit 1')
      }),
    ).toBe(false)
  })
})
