import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { ptyManager } from './pty-manager'

// PTY de verdade: o lastIoAt que a hibernação lê precisa andar com a saída do
// processo E com a escrita/resize do app, e sumir no exit.
const ID = 'pty-io-integration'

function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() > deadline) return reject(new Error('timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe.skipIf(process.platform !== 'linux')('ptyManager lastIoAt (PTY real)', () => {
  afterEach(() => ptyManager.kill(ID))

  it('anda com a saída, a escrita e o resize, e some no exit', async () => {
    const before = Date.now()
    ptyManager.spawn({ sessionId: ID, command: '/bin/sh', args: [], cwd: tmpdir() })
    expect(ptyManager.getPid(ID)).toBeGreaterThan(0)
    const atSpawn = ptyManager.getLastIoAt(ID)!
    expect(atSpawn).toBeGreaterThanOrEqual(before)

    await new Promise((r) => setTimeout(r, 30))
    ptyManager.write(ID, 'echo io-marker\n')
    const afterWrite = ptyManager.getLastIoAt(ID)!
    expect(afterWrite).toBeGreaterThan(atSpawn)
    await waitFor(() => ptyManager.getBacklog(ID).includes('io-marker\r\n'))

    await new Promise((r) => setTimeout(r, 30))
    ptyManager.resize(ID, 100, 30)
    expect(ptyManager.getLastIoAt(ID)!).toBeGreaterThan(afterWrite)

    const exited = new Promise<void>((resolve) =>
      ptyManager.on('exit', (e) => e.sessionId === ID && resolve()),
    )
    ptyManager.write(ID, 'exit\n')
    await exited
    expect(ptyManager.getLastIoAt(ID)).toBeNull()
    expect(ptyManager.getPid(ID)).toBeNull()
  })
})
