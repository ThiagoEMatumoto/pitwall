import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDb } from '../services/db'
import { broadcast, onBroadcast } from '../services/notify'
import { ptyManager } from '../services/pty-manager'
import { buildSessionsFileIndex, isPidAlive, mapStatus } from '../services/session-activity'
import * as handoffStore from '../services/handoff-store'
import {
  buildSessionGraph,
  readSessionGraphInput,
  type LiveSessionState,
} from '../services/session-graph'
import { readFirstPrompt, readLastPrompt } from '../services/session-purpose'
import { transcriptIndex } from '../services/transcript-index'
import type { HandoffEvent, SessionGraph } from '../../../shared/types/session-graph'

// O que muda o grafo: handoffs (despacho, bastão, progresso), dependências entre
// repos e o ciclo de vida/status das sessões (spawn aparece no índice global de
// atividade; morte chega por pty:exit). O session:activity POR sessão fica de
// fora: sai a cada ~250ms durante um turno e não traz nada que o global não traga.
const GRAPH_CHANNEL_PREFIXES = [
  'handoff:',
  'repo-deps:',
  'session:activity:global',
  'session:feature-changed',
  'session:renamed',
  'pty:exit',
  // Propósito, grupo e "onde parei" da sessão (P8) viajam no nó do grafo.
  'canvas:',
] as const
export const GRAPH_PUSH_DELAY_MS = 300

// PTY viva neste app = sessão viva; o status vem do session file do CLI. PTY sem
// session file ainda é uma sessão que está subindo.
function liveSessionStates(): Map<string, LiveSessionState> {
  const running = ptyManager.runningIds()
  const rows = getDb()
    .prepare(`SELECT id, cc_session_id FROM sessions WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(running)) as Array<{ id: string; cc_session_id: string | null }>
  const index = buildSessionsFileIndex()
  const out = new Map<string, LiveSessionState>()
  for (const row of rows) {
    const entry = row.cc_session_id ? index.get(row.cc_session_id) : undefined
    const alive = entry ? isPidAlive(entry.pid) : false
    out.set(row.id, {
      status: entry && alive ? mapStatus(entry.status) : 'starting',
      lastActivityAt: entry?.updatedAt ?? null,
      name: entry?.name ?? null,
    })
  }
  return out
}

export function loadSessionGraph(): SessionGraph {
  const db = getDb()
  return buildSessionGraph(readSessionGraphInput(db, liveSessionStates(), Date.now(), readFirstPrompt, readLastPrompt))
}

// Coalesce em vez de debounce puro: o 1º evento arma o timer e os seguintes na
// janela pegam carona. Um debounce que reinicia a cada evento nunca dispararia
// com uma sessão emitindo atividade sem parar.
export function watchSessionGraph(push: () => void, delayMs = GRAPH_PUSH_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      push()
    }, delayMs)
  }
  const offs = GRAPH_CHANNEL_PREFIXES.map((prefix) => onBroadcast(prefix, schedule))
  // Transcript novo no índice = 1º prompt que agora dá pra ler.
  offs.push(transcriptIndex.onGrow(schedule))
  return () => {
    for (const off of offs) off()
    if (timer) clearTimeout(timer)
    timer = null
  }
}

const handoffEventsSchema = z.object({ handoffId: z.string().min(1) })

export function registerSessionGraphIpc(): void {
  ipcMain.handle('session-graph:get', (): SessionGraph => loadSessionGraph())
  ipcMain.handle('handoff-events:list', (_e, input: unknown): HandoffEvent[] => {
    const { handoffId } = handoffEventsSchema.parse(input)
    return handoffStore.listEvents(handoffId)
  })
  // Cada tick de atividade reconstrói o grafo; só vai pras janelas quando mudou.
  let last = ''
  watchSessionGraph(() => {
    const graph = loadSessionGraph()
    const serialized = JSON.stringify(graph)
    if (serialized === last) return
    last = serialized
    broadcast('session-graph:updated', graph)
  })
}
