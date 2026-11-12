/** @vitest-environment node */
// Custo do tick da hibernação, que passou a rodar por padrão (janela da filha de
// handoff concluído). Alvo: menos de 50 ms por tick, com filhas concluídas cujos
// transcripts têm o tamanho dos maiores medidos em uso real (63 MB e 35 MB).
//
// Produtores reais: DB com as migrations, handoff-store, índice de
// ~/.claude/sessions, /proc, findTranscriptPath e o ScheduleScanner lendo os
// transcripts do disco. Fakes só na borda (PTY, fila, árvore de processos).
//
// O número sai de dois jeitos:
// - aqui, na linha "[hibernate-tick-cost] {json}" que o teste imprime;
// - no app com CM_PERF=1, em spans["hibernate.tick"] do perf.jsonl. O tick roda
//   a cada 60 s: aparece em uma de cada seis janelas de 10 s da sonda. É só o
//   gate: o que o tick espera sai em hibernate.confirm (renderer) e
//   hibernate.exit (fila), e a leitura em segundo plano em hibernate.scan, que é
//   tempo de parede. O que ela trava do event loop é o lagMs da mesma linha.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const { HOME, perfBefore } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // A sonda lê a flag uma vez, no import.
  const before = process.env.CM_PERF
  process.env.CM_PERF = '1'
  return { HOME: mkdtempSync(join(tmpdir(), 'hibernate-tick-cost-')), perfBefore: before }
})

vi.mock('electron', () => ({
  app: { getPath: () => HOME, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
}))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { closeDb, getDb } from '../db'
import { isSessionPidAlive } from '../session-activity'
import { findTranscriptPath } from '../transcript-path'
import { drainPerfWindow } from '../perf-probe'
import * as handoffStore from '../handoff-store'
import { IdleHibernator } from './idle-hibernator'
import { ScheduleScanner } from './schedule-scan'
import { claudeCandidates, sessionFileFor } from './hibernate-sources'

const TARGET_MS = 50
const MB = 1024 * 1024
// Os dois maiores transcripts vivos medidos em uso real; o resto no tamanho
// comum de uma filha.
const TRANSCRIPT_MB = [63, 35, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]
const CHILDREN = TRANSCRIPT_MB.length
const COMMON_SESSIONS = 12
// O app.db real tem perto de 290 handoffs e milhares de sessões encerradas.
const HISTORY_HANDOFFS = 280
const HISTORY_SESSIONS = 1_500
const WARM_TICKS = 10
const IDLE_SINCE = Date.now() - 2 * 60 * 60_000

const SESSIONS_DIR = join(HOME, '.claude', 'sessions')
const PROJECT_DIR = join(HOME, '.claude', 'projects', '-home-user-projetos-repo')

// Linhas com as chaves que o claude 2.1.29x grava (as mesmas de schedule-scan.test.ts).
const stamp = { isSidechain: false, timestamp: '2026-09-05T04:10:42.211Z', sessionId: 's-1' }
const filler = (chars: number): string => 'saída do comando — '.repeat(Math.ceil(chars / 19))
const assistantText = (text: string): string =>
  JSON.stringify({
    ...stamp,
    type: 'assistant',
    message: { type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
  })
const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    ...stamp,
    type: 'assistant',
    message: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
      stop_reason: 'tool_use',
    },
  })
const toolResult = (id: string, content: string, toolUseResult: unknown): string =>
  JSON.stringify({
    ...stamp,
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] },
    toolUseResult,
  })

// Perfil medido em três transcripts reais de 52 a 63 MB: linhas de 3 a 7 KB em
// média, perto de 10% delas citando ferramenta MCP, até 29% dos bytes nas linhas
// que o scanner desserializa, e uma linha de centenas de KB de vez em quando.
// Sem agendamento nem trabalho em background aberto: o veredito é 'clear'.
function transcriptBlock(): Buffer {
  const lines: string[] = []
  for (let i = 0; i < 180; i++) {
    if (i % 10 === 0) {
      lines.push(toolUse(`toolu_mcp_${i}`, 'mcp__pitwall__task_update', { id: 't1' }))
      lines.push(toolResult(`toolu_mcp_${i}`, filler(3_000), { ok: true }))
    } else if (i % 3 === 0) {
      lines.push(toolUse(`toolu_${i}`, 'Bash', { command: 'npm test' }))
      lines.push(toolResult(`toolu_${i}`, filler(6_000), { stdout: filler(6_000), stderr: '' }))
    } else {
      lines.push(assistantText(filler(1_500)))
    }
  }
  lines.push(toolUse('toolu_mcp_big', 'mcp__pitwall__feature_health_get', { id: 'f1' }))
  lines.push(toolResult('toolu_mcp_big', filler(400_000), { type: 'text' }))
  return Buffer.from(`${lines.join('\n')}\n`)
}

function writeTranscript(cc: string, megabytes: number, block: Buffer): string {
  const path = join(PROJECT_DIR, `${cc}.jsonl`)
  const fd = openSync(path, 'w')
  try {
    for (let written = 0; written < megabytes * MB; written += block.length) writeSync(fd, block)
  } finally {
    closeSync(fd)
  }
  return path
}

function seedSession(id: string, cc: string, status: 'running' | 'exited'): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at, provider)
       VALUES (?, NULL, ?, NULL, ?, ?, 'claude')`,
    )
    .run(id, cc, status, IDLE_SINCE)
}

function seedDoneChildHandoff(sessionId: string): void {
  const h = handoffStore.create({
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
    motherSessionId: null,
    mode: 'plan',
    status: 'approved',
  })
  handoffStore.markRunning(h.id, sessionId)
  handoffStore.report(h.id, 'pronto')
}

// O leitor real (buildSessionsFileIndex) indexa por sessionId e não olha o nome do
// arquivo: todas apontam para o processo do teste, o único pid vivo garantido.
function writeSessionFile(index: number, cc: string): void {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
  const real = {
    pid: process.pid,
    sessionId: cc,
    cwd: '/home/user/projetos/repo',
    startedAt: IDLE_SINCE,
    procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    version: '2.1.296',
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'repo',
    updatedAt: IDLE_SINCE,
    status: 'idle',
    statusUpdatedAt: IDLE_SINCE,
  }
  writeFileSync(join(SESSIONS_DIR, `${index}.json`), JSON.stringify(real))
}

const round = (ms: number): number => Math.round(ms * 100) / 100
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[values.length >> 1]

const children: Array<{ sessionId: string; cc: string; transcript: string }> = []
const running: string[] = []
const sessionOfCc = new Map<string, string>()

beforeAll(() => {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  mkdirSync(PROJECT_DIR, { recursive: true })
  const db = getDb()
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P1', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at)
     VALUES ('r1', 'p1', 'Repo 1', ?, 0, 1)`,
  ).run(HOME)

  const block = transcriptBlock()
  db.transaction(() => {
    for (let i = 0; i < HISTORY_SESSIONS; i++) seedSession(`old-${i}`, randomUUID(), 'exited')
    for (let i = 0; i < HISTORY_HANDOFFS; i++) {
      seedSession(`old-child-${i}`, randomUUID(), 'exited')
      seedDoneChildHandoff(`old-child-${i}`)
    }
    TRANSCRIPT_MB.forEach((megabytes, i) => {
      const child = { sessionId: `child-${i}`, cc: randomUUID(), transcript: '' }
      seedSession(child.sessionId, child.cc, 'running')
      seedDoneChildHandoff(child.sessionId)
      children.push({ ...child, transcript: writeTranscript(child.cc, megabytes, block) })
    })
    for (let i = 0; i < COMMON_SESSIONS; i++) {
      const cc = randomUUID()
      seedSession(`common-${i}`, cc, 'running')
      sessionOfCc.set(cc, `common-${i}`)
      writeTranscript(cc, 2, block)
    }
  })()
  for (const child of children) sessionOfCc.set(child.cc, child.sessionId)
  ;[...sessionOfCc].forEach(([cc, sessionId], i) => {
    running.push(sessionId)
    writeSessionFile(i, cc)
  })
}, 120_000)

afterAll(() => {
  closeDb()
  rmSync(HOME, { recursive: true, force: true })
  if (perfBefore === undefined) delete process.env.CM_PERF
  else process.env.CM_PERF = perfBefore
})

describe('custo do tick com a janela da filha ligada e a geral desligada', () => {
  it(`fica abaixo de ${TARGET_MS} ms, com o transcript frio e com ele no cache`, async () => {
    const scanner = new ScheduleScanner()
    const hibernator = new IdleHibernator({
      lazyRestore: () => false,
      afterMin: () => 0,
      childAfterMin: () => 15,
      candidates: () => claudeCandidates(running),
      hasPane: () => false,
      confirmPane: async () => null,
      registerDormant: () => {},
      persistHibernating: () => {},
      lastIoAt: () => IDLE_SINCE,
      sessionFile: sessionFileFor,
      isPidAlive: (file) => isSessionPidAlive(file),
      aliveSessionId: (cc) => sessionOfCc.get(cc) ?? null,
      activeHandoffCcSessionIds: handoffStore.activeHandoffCcSessionIds,
      handoffChildKind: handoffStore.childHandoffKindCc,
      queueHas: () => false,
      transcriptPath: findTranscriptPath,
      scanTranscript: (path) => scanner.peek(path),
      // Recusa no último gate: as filhas seguem candidatas e cada tick refaz o
      // gate inteiro, que é o pior caso em regime.
      procTree: () => ({ ok: false, blocker: 'bench' }),
      send: async () => ({ ok: false, error: 'not-running' }),
      cancel: () => {},
      replaceText: () => false,
      warn: () => {},
    })
    const timedTick = async (): Promise<number> => {
      const start = performance.now()
      await hibernator.tick()
      return performance.now() - start
    }
    // O que o tick deixou de esperar: a leitura do maior transcript, sozinha.
    const largestStart = performance.now()
    expect(await new ScheduleScanner().scan(children[0].transcript)).toBe('clear')
    const largestReadMs = performance.now() - largestStart
    drainPerfWindow(1)

    // Frio: nenhum transcript lido ainda. O tick não espera a leitura.
    const lag = monitorEventLoopDelay({ resolution: 1 })
    lag.enable()
    const coldMs = await timedTick()
    expect(hibernator.getStats().refused['transcript-reading']).toBe(CHILDREN)
    const readStart = performance.now()
    await vi.waitFor(
      async () => {
        for (const child of children) expect(await scanner.peek(child.transcript)).toBe('clear')
      },
      { timeout: 60_000, interval: 20 },
    )
    const backgroundReadMs = performance.now() - readStart
    lag.disable()

    // Em regime: o veredito de cada transcript vem do cache.
    const warm: number[] = []
    for (let i = 0; i < WARM_TICKS; i++) warm.push(await timedTick())
    expect(hibernator.getStats().refused['proc-tree']).toBe(CHILDREN * WARM_TICKS)

    const probe = drainPerfWindow(1)
    const span = probe.spans['hibernate.tick']
    console.log(
      `[hibernate-tick-cost] ${JSON.stringify({
        targetMs: TARGET_MS,
        doneChildren: CHILDREN,
        commonSessions: COMMON_SESSIONS,
        transcriptMb: TRANSCRIPT_MB,
        coldTickMs: round(coldMs),
        warmTickMs: { p50: round(median(warm)), max: round(Math.max(...warm)) },
        largestTranscriptReadMs: round(largestReadMs),
        backgroundReadMs: round(backgroundReadMs),
        loopBlockMaxMsWhileReading: round(lag.max / 1e6),
        probe: {
          'hibernate.tick': span,
          'hibernate.scan': probe.spans['hibernate.scan'],
          'hibernate.evaluated': probe.counters['hibernate.evaluated'],
        },
      })}`,
    )

    // A sonda viu todos os ticks, e só as filhas concluídas chegaram ao gate. A
    // leitura que o tick frio deixou para trás aparece, uma por transcript.
    expect(span?.n).toBe(1 + WARM_TICKS)
    expect(probe.spans['hibernate.scan']?.n).toBe(CHILDREN)
    expect(probe.counters['hibernate.evaluated']).toBe(CHILDREN * (1 + WARM_TICKS))
    expect(coldMs).toBeLessThan(TARGET_MS)
    expect(median(warm)).toBeLessThan(TARGET_MS)
  }, 120_000)
})
