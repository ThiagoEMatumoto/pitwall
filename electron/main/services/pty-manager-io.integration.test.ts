import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { createPtyDataCoalescer } from './pty-data-coalescer'
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

// O contrato que o replay do Terminal cobra do coalescedor, com o backlog e os
// chunks do produtor real: depois de um flush, o que foi enviado é o backlog.
describe.skipIf(process.platform !== 'linux')('pty:data coalescido (PTY real)', () => {
  const STREAM_ID = 'pty-coalesce-integration'
  afterEach(() => ptyManager.kill(STREAM_ID))

  it('a soma dos envios é o backlog a cada flush e na saída', async () => {
    const sent: string[] = []
    const coalescer = createPtyDataCoalescer((e) => sent.push(e.data))
    const onData = (e: { sessionId: string; data: string }) => {
      if (e.sessionId === STREAM_ID) coalescer.push(e.sessionId, e.data)
    }
    let onExit: (e: { sessionId: string }) => void = () => {}
    const exited = new Promise<void>((resolve) => {
      onExit = (e) => {
        if (e.sessionId !== STREAM_ID) return
        coalescer.flush(STREAM_ID)
        coalescer.drop(STREAM_ID)
        resolve()
      }
    })
    ptyManager.on('data', onData)
    ptyManager.on('exit', onExit)

    // Como o sessions:get-backlog: flush e leitura do backlog no mesmo tick.
    const snapshots: Array<{ sent: string; backlog: string }> = []
    const sampler = setInterval(() => {
      coalescer.flush(STREAM_ID)
      snapshots.push({ sent: sent.join(''), backlog: ptyManager.getBacklog(STREAM_ID) })
    }, 5)

    try {
      const script =
        'i=0; while [ $i -lt 400 ]; do printf "linha-%s \\033[32mok\\033[0m\\n" $i; ' +
        'i=$((i+1)); [ $((i % 40)) -eq 0 ] && sleep 0.02; done'
      ptyManager.spawn({
        sessionId: STREAM_ID,
        command: '/bin/sh',
        args: ['-c', script],
        cwd: tmpdir(),
      })
      await exited
    } finally {
      clearInterval(sampler)
      ptyManager.off('data', onData)
      ptyManager.off('exit', onExit)
    }

    const backlog = ptyManager.getBacklog(STREAM_ID)
    expect(backlog).toContain('linha-0 \x1b[32mok')
    expect(backlog).toContain('linha-399 ')
    expect(sent.join('')).toBe(backlog)

    const midStream = snapshots.filter(
      (s) => s.backlog.length > 0 && s.backlog.length < backlog.length,
    )
    expect(midStream.length).toBeGreaterThan(0)
    for (const snapshot of midStream) expect(snapshot.sent).toBe(snapshot.backlog)
  })
})
