import { ipcMain } from 'electron'
import { z } from 'zod'
import { getDb } from '../services/db'
import { broadcast, onBroadcast } from '../services/notify'
import { buildSessionsFileIndex } from '../services/session-activity'
import { liveSessionStates } from '../services/live-session-states'
import { projectAndCount, readAttentionInputFrom } from '../services/attention/attention-service'
import * as handoffStore from '../services/handoff-store'
import { buildSessionGraph, readSessionGraphInput } from '../services/session-graph'
import { readFirstPrompt, readLastPrompt, summarizeSessionTitle } from '../services/session-purpose'
import { createAutoTitler } from '../services/session-auto-title'
import { setSessionAutoTitle } from '../services/canvas-store'
import { transcriptIndex } from '../services/transcript-index'
import { onSessionLinkPulse } from '../services/session-link-pulse'
import { resolveLiveSessionFeatures } from '../services/feature-session-live'
import type { HandoffEvent, SessionGraph } from '../../../shared/types/session-graph'

type SessionsFileIndex = ReturnType<typeof buildSessionsFileIndex>

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
  // Título, status, foco e pulso do card da feature também viajam no grafo.
  'feature:updated',
  'loop:updated',
  // "Essa é a mãe" viaja no nó (isPinnedMother).
  'mother-pins:',
] as const
export const GRAPH_PUSH_DELAY_MS = 300
// A branch muda no transcript, que nem sempre acorda um broadcast: este tick
// garante que a troca de branch leva a sessão pro card certo em poucos segundos.
const FEATURE_RESOLVE_TICK_MS = 3000

function resolveFeaturesSafely(index?: SessionsFileIndex): void {
  try {
    resolveLiveSessionFeatures(index)
  } catch (err) {
    console.error('[feature-resolver] falhou:', err)
  }
}

export function loadSessionGraph(
  index: SessionsFileIndex = buildSessionsFileIndex(),
): SessionGraph {
  const db = getDb()
  const states = liveSessionStates(index)
  return buildSessionGraph({
    ...readSessionGraphInput(db, states, Date.now(), readFirstPrompt, readLastPrompt),
    // Mesmos estados vivos da fila única: o nó e o HUD não podem discordar.
    attention: projectAndCount(readAttentionInputFrom(db, states)),
  })
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

// Auto-título das sessões não-filhas: cada grafo novo é a chance de achar o 1º
// prompt de uma sessão viva. Gravou → canvas:updated refaz o grafo e
// session:auto-titled atualiza a lista viva do renderer sem refetch.
const autoTitler = createAutoTitler({
  readPrompt: (cc) => readFirstPrompt(cc, true),
  summarize: (cc) => summarizeSessionTitle(cc),
  save: (sessionId, title) => setSessionAutoTitle(sessionId, title, 'llm', Date.now()),
  onSaved: (sessionId, ccSessionId, title) => {
    broadcast('session:auto-titled', {
      sessionId,
      ccSessionId,
      autoTitle: title,
      autoTitleSource: 'llm',
    })
    broadcast('canvas:updated', { scope: null })
  },
})

function considerAutoTitles(graph: SessionGraph): void {
  try {
    autoTitler.consider(graph.nodes)
  } catch (err) {
    console.error('[auto-title] falhou ao avaliar o grafo:', err)
  }
}

const handoffEventsSchema = z.object({ handoffId: z.string().min(1) })

export function registerSessionGraphIpc(): void {
  ipcMain.handle('session-graph:get', (): SessionGraph => loadSessionGraph())
  // Bolinha no fio do mapa: evento efêmero, direto pra janela (sem grafo novo).
  onSessionLinkPulse((pulse) => broadcast('session-link:pulse', pulse))
  ipcMain.handle('handoff-events:list', (_e, input: unknown): HandoffEvent[] => {
    const { handoffId } = handoffEventsSchema.parse(input)
    return handoffStore.listEvents(handoffId)
  })
  // Cada tick de atividade reconstrói o grafo; só vai pras janelas quando mudou.
  let last = ''
  const tick = setInterval(() => resolveFeaturesSafely(), FEATURE_RESOLVE_TICK_MS)
  tick.unref?.()
  watchSessionGraph(() => {
    // Antes do grafo: a sessão que trocou de branch já sai no card novo. Um
    // índice de session files só para os dois.
    const index = buildSessionsFileIndex()
    resolveFeaturesSafely(index)
    const graph = loadSessionGraph(index)
    considerAutoTitles(graph)
    const serialized = JSON.stringify(graph)
    if (serialized === last) return
    last = serialized
    broadcast('session-graph:updated', graph)
  })
}
