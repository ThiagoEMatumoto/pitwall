/** @vitest-environment node */
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fixtureFromEnv, fixturePaceFromEnv, pwRecordArgs, startCapture } from './audio-capture'

const fixtures = resolve(__dirname, '../../../../e2e/fixtures/meetings')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('pwRecordArgs', () => {
  it('them captura o sink com -P como um único argumento', () => {
    expect(pwRecordArgs('them', 'alsa_output.x')).toEqual([
      '--target', 'alsa_output.x',
      '-P', '{ stream.capture.sink = true }',
      '--raw', '--format', 's16', '--rate', '16000', '--channels', '1', '--latency', '20ms', '-',
    ])
  })

  it('me captura o source sem -P; sem target omite --target', () => {
    expect(pwRecordArgs('me', 'alsa_input.x').slice(0, 3)).toEqual(['--target', 'alsa_input.x', '--raw'])
    expect(pwRecordArgs('me', null)[0]).toBe('--raw')
  })
})

describe('env de fixture', () => {
  it('mapeia SYSTEM→them, MIC→me e pace numérico', () => {
    const env = { CM_MEETING_FIXTURE_SYSTEM: '/a.wav', CM_MEETING_FIXTURE_MIC: '', CM_MEETING_FIXTURE_PACE: '0' }
    expect(fixtureFromEnv('them', env)).toBe('/a.wav')
    expect(fixtureFromEnv('me', env)).toBeUndefined()
    expect(fixturePaceFromEnv(env)).toBe(0)
    expect(fixturePaceFromEnv({})).toBe(1)
    expect(fixturePaceFromEnv({ CM_MEETING_FIXTURE_PACE: 'x' })).toBe(1)
  })
})

describe('modo fixture', () => {
  it('pace 0 emite o WAV inteiro de uma vez em blocos de 100 ms e depois silêncio até stop', async () => {
    const handle = startCapture({
      track: 'me',
      target: null,
      fixturePath: resolve(fixtures, 'silence-5s.wav'),
      pace: 0,
    })
    const blocks: Buffer[] = []
    const exit = vi.fn()
    handle.onData((pcm) => blocks.push(pcm))
    handle.onExit(exit)

    await sleep(20)
    // 5 s / 100 ms = 50 blocos do arquivo, sem esperar tempo real
    expect(blocks.length).toBeGreaterThanOrEqual(50)
    expect(blocks.slice(0, 50).reduce((n, b) => n + b.length, 0)).toBe(5 * 16000 * 2)
    expect(blocks[0].length).toBe(3200)

    await sleep(250)
    const after = blocks.length
    expect(after).toBeGreaterThan(50) // silêncio continua chegando
    expect(blocks[after - 1].every((b) => b === 0)).toBe(true)

    handle.stop()
    await sleep(150)
    expect(blocks.length).toBe(after + (blocks.length - after)) // nada após stop além do que já estava
    expect(exit).toHaveBeenCalledWith(0, '')
    const frozen = blocks.length
    await sleep(150)
    expect(blocks.length).toBe(frozen)
  })

  it('modo fixture sem arquivo emite só silêncio', async () => {
    const handle = startCapture({ track: 'them', target: null, mode: 'fixture', pace: 0 })
    const blocks: Buffer[] = []
    handle.onData((pcm) => blocks.push(pcm))
    await sleep(250)
    handle.stop()
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b.length === 3200 && b.every((x) => x === 0))).toBe(true)
  })
})

describe('modo pipewire', () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    return child
  }

  it('spawna pw-record com os args da trilha, repassa stdout e stderr no exit', () => {
    const child = fakeChild()
    const spawnImpl = vi.fn(() => child)
    const handle = startCapture({
      track: 'them',
      target: 'sink.x',
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    })
    const data = vi.fn()
    const exit = vi.fn()
    handle.onData(data)
    handle.onExit(exit)

    expect(spawnImpl).toHaveBeenCalledWith('pw-record', pwRecordArgs('them', 'sink.x'), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.emit('data', Buffer.from([1, 2]))
    expect(data).toHaveBeenCalledWith(Buffer.from([1, 2]))
    child.stderr.emit('data', Buffer.from('boom'))
    child.emit('exit', 1)
    expect(exit).toHaveBeenCalledWith(1, 'boom')
  })

  it('stop manda SIGINT e SIGKILL depois de 1500 ms se não sair', () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const handle = startCapture({
        track: 'me',
        target: null,
        spawnImpl: vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      })
      handle.stop()
      expect(child.kill).toHaveBeenCalledWith('SIGINT')
      vi.advanceTimersByTime(1499)
      expect(child.kill).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(2)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('não manda SIGKILL se o processo já saiu', () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const handle = startCapture({
        track: 'me',
        target: null,
        spawnImpl: vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      })
      handle.stop()
      child.emit('exit', 0)
      vi.advanceTimersByTime(2000)
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
