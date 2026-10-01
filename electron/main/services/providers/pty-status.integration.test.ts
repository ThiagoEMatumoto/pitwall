/** @vitest-environment node */
// O gate de 'quando terminar' do Codex decide pelo pty-status: aqui ele roda
// contra o produtor REAL — PtyManager + node-pty + o stub fake-codex numa PTY
// de verdade (bytes, \r\n, eco do tty) — e não contra chunks montados à mão.
import { afterEach, describe, expect, it } from 'vitest'
import { ptyManager } from '../pty-manager'
import { derivePtyStatus, PTY_IDLE_MS } from './pty-status'
import { createFakeHome, FAKE_CODEX_DONE, type FakeHome } from '../../../../e2e/driver/fake-home'
import type { LiveStatus } from '../../../../shared/tui/attention-reason'

let fake: FakeHome | null = null
const SESSION = 'pty-status-integration'

afterEach(() => {
  ptyManager.kill(SESSION)
  fake?.cleanup()
  fake = null
})

function statusNow(): LiveStatus {
  const sample = ptyManager.getActivitySample(SESSION)
  return sample ? derivePtyStatus(sample, Date.now()) : 'ended'
}

async function waitStatus(want: LiveStatus, timeoutMs: number): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (statusNow() === want) return Date.now()
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`status ${want} não chegou em ${timeoutMs}ms (atual: ${statusNow()})`)
}

describe('pty-status contra a PTY real do fake-codex', () => {
  it('working durante o turno, idle depois que a tela para', async () => {
    fake = createFakeHome()
    let screen = ''
    const onData = (e: { sessionId: string; data: string }) => {
      if (e.sessionId === SESSION) screen += e.data
    }
    ptyManager.on('data', onData)
    try {
      ptyManager.spawn({
        sessionId: SESSION,
        command: fake.fakeCliPath('codex'),
        args: ['--no-alt-screen', 'tarefa inicial'],
        cwd: fake.root,
        // Como sessions.ts spawna provider sem índice nativo.
        sampleActivity: true,
      })
      await waitStatus('working', 3_000)
      const doneAt = await (async () => {
        const started = Date.now()
        while (!screen.includes(FAKE_CODEX_DONE)) {
          if (Date.now() - started > 8_000) throw new Error('turno do stub não terminou')
          await new Promise((r) => setTimeout(r, 50))
        }
        return Date.now()
      })()
      // Ainda dentro da janela: o fim do turno acabou de mudar a tela.
      expect(statusNow()).toBe('working')
      const idleAt = await waitStatus('idle', PTY_IDLE_MS + 1_500)
      expect(idleAt - doneAt).toBeGreaterThanOrEqual(PTY_IDLE_MS - 300)

      // Eco do tty + novo turno: volta a trabalhar.
      ptyManager.write(SESSION, 'oi\r')
      await waitStatus('working', 2_000)
    } finally {
      ptyManager.off('data', onData)
    }
  }, 20_000)

  // O claude tem índice nativo de status: a PTY dele não paga o hash por chunk.
  it('PTY spawnada sem sampleActivity não é amostrada', () => {
    fake = createFakeHome()
    const id = `${SESSION}-unsampled`
    try {
      ptyManager.spawn({
        sessionId: id,
        command: fake.fakeCliPath('codex'),
        args: ['--no-alt-screen'],
        cwd: fake.root,
      })
      expect(ptyManager.getActivitySample(id)).toBeNull()
    } finally {
      ptyManager.kill(id)
    }
  })
})
