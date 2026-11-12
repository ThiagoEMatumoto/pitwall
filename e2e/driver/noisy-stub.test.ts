// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import xtermHeadless from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { lastNoiseOutput, noisyStub } from './noisy-stub'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

let root = ''
let child: ChildProcess | null = null
afterEach(() => {
  child?.kill()
  child = null
  rmSync(root, { recursive: true, force: true })
})

// O stub real, com o stdin aberto (sem TTY), até ele ter escrito `outputs` saídas.
function stubOutput(noise: boolean, outputs: number): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'noisy-stub-'))
  const noiseFlag = join(root, 'noise')
  for (const dir of ['sessions', 'logs']) mkdirSync(join(root, dir))
  const stub = join(root, 'perf-claude.sh')
  writeFileSync(stub, noisyStub(join(root, 'sessions'), join(root, 'logs'), noiseFlag))
  chmodSync(stub, 0o755)
  if (noise) writeFileSync(noiseFlag, '')
  const running = spawn(stub, ['--session-id', 'cc-noise', '-n', 'A'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child = running
  return new Promise((resolve) => {
    let out = ''
    running.stdout!.setEncoding('utf8')
    running.stdout!.on('data', (chunk: string) => {
      out += chunk
      // A saída só conta inteira: a linha dela já fechou.
      if (noise && (out.match(/saida \d+ [^\n]*\n/g)?.length ?? 0) >= outputs) resolve(out)
    })
    // Sem a carga ligada: três voltas do laço do stub (0,2 s cada) sem saída nenhuma.
    if (!noise) setTimeout(() => resolve(out), 700)
  })
}

// O texto do buffer como o cenário o lê (readXtermBuffer): linhas juntas, sem separador.
async function screenOf(written: string, cols: number): Promise<string> {
  const term = new Terminal({ cols, rows: 6, scrollback: 1000, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(written.replaceAll('\n', '\r\n'), resolve))
  const buffer = term.buffer.active
  let screen = ''
  for (let y = 0; y < buffer.length; y++) {
    screen += buffer.getLine(y)?.translateToString(true) ?? ''
  }
  return screen
}

describe('lastNoiseOutput', () => {
  it('lê do xterm a última saída de carga que o stub escreveu, com o eco digitado no meio', async () => {
    const out = await stubOutput(true, 3)
    const complete = out.slice(0, out.lastIndexOf('\n') + 1)
    const written = complete.match(/saida \d+ /g)?.length ?? 0
    expect(written).toBeGreaterThanOrEqual(3)

    // Estreito: cada saída quebra em várias linhas do xterm.
    expect(lastNoiseOutput(await screenOf(complete, 24))).toBe(written)
    // O eco da TTY cai na mesma linha, antes da saída seguinte.
    expect(lastNoiseOutput(await screenOf(`${complete}the quick brown fox`, 24))).toBe(written)
  })

  it('sem a carga ligada o stub não escreve saída nenhuma', async () => {
    const out = await stubOutput(false, 0)

    expect(out).toContain('Fake Claude Code (stub perf) A')
    expect(lastNoiseOutput(await screenOf(out, 24))).toBe(0)
  })
})
