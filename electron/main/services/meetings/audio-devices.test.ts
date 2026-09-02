/** @vitest-environment node */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  hasPipewire,
  parseNodeName,
  resolveDefaultDevices,
  resolveSourceForStream,
  sourceForStream,
  type Exec,
} from './audio-devices'

const realDump = readFileSync(resolve(__dirname, '__fixtures__/pw-dump-arecord-real.json'), 'utf8')

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

describe('resolveSourceForStream', () => {
  it('segue o Link input-node-id=stream → output-node-id → node.name da Audio/Source (dump real)', async () => {
    const exec = vi.fn<Exec>(async () => ({ stdout: realDump }))
    expect(await resolveSourceForStream(147, exec)).toBe(
      'alsa_input.usb-Actions_USB_Audio___HID_0123456789AC-01.mono-fallback',
    )
    expect(exec).toHaveBeenCalledWith('pw-dump', [])
  })

  it('null sem link pro stream, quando o alvo não é Audio/Source, ou quando pw-dump falha', async () => {
    const dump = JSON.parse(realDump) as unknown[]
    expect(sourceForStream(dump, 999)).toBeNull()
    // link apontando pro sink (61) em vez da source
    const toSink = dump.map((o) =>
      (o as { id: number }).id === 144
        ? { ...(o as object), info: { 'output-node-id': 61, 'input-node-id': 147 } }
        : o,
    )
    expect(sourceForStream(toSink, 147)).toBeNull()
    expect(sourceForStream('não é array', 147)).toBeNull()
    expect(
      await resolveSourceForStream(147, async () => {
        throw new Error('ENOENT')
      }),
    ).toBeNull()
    expect(await resolveSourceForStream(147, async () => ({ stdout: '{nope' }))).toBeNull()
  })
})
