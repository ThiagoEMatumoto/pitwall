import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// O nível "Todas as mães" lê o grafo e a fila que o main produz. Aqui os dois
// saem dos produtores reais: banco migrado, handoffStore, tela capturada do
// claude 2.1.286 no tuiMenuWatch, buildSessionGraph e projectAndCount.
let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))
vi.mock('./transcript-path', () => ({ findTranscriptPath: () => null }))
vi.mock('./session-activity', () => ({ buildSessionsFileIndex: () => new Map() }))
vi.mock('./live-session-states', () => ({ liveSessionStates: () => new Map() }))

import * as handoffStore from './handoff-store'
import { projectAndCount, readAttentionInputFrom } from './attention/attention-service'
import {
  applyAllMigrations,
  seedFeature,
  seedRepos,
  seedSession,
} from './attention/attention-test-harness'
import { buildSessionGraph, readSessionGraphInput, type LiveSessionState } from './session-graph'
import { tuiMenuWatch } from './tui-menu-watch'
import { countAttentionSubjects, humanQueue, isAskItem } from '../../../shared/attention/selectors'
import {
  allMothers,
  childIdsByMother,
  needYouFor,
} from '../../../src/features/feature-room/all-mothers-model'

const FIXTURES = join(__dirname, '../../../shared/tui/__fixtures__')
const fakePty = new EventEmitter() as EventEmitter & { write: () => void }
fakePty.write = () => {}

async function showScreen(sessionId: string, capture: string): Promise<void> {
  const raw = readFileSync(join(FIXTURES, `claude-2.1.286-${capture}.ansi`), 'utf8')
  fakePty.emit('spawn', { sessionId, cols: 80, rows: 24 })
  fakePty.emit('data', { sessionId, data: raw })
  await tuiMenuWatch.snapshot(sessionId)
}

function dispatch(motherId: string, childId: string, repoId: string): string {
  const h = handoffStore.create({
    motherSessionId: motherId,
    targetRepoId: repoId,
    task: `task ${childId}`,
    composedPrompt: 'p',
  })
  handoffStore.markRunning(h.id, childId)
  return h.id
}

const ALL = ['lume', 'nori', 'sora', 'lume-kid', 'avulsa', 'solo', 'solo-kid']

function liveAll(over: Record<string, Partial<LiveSessionState>> = {}) {
  return new Map<string, LiveSessionState>(
    ALL.map((id) => [id, { status: 'idle', lastActivityAt: 5_000, name: null, ...over[id] }]),
  )
}

// 3 mães em 2 features (Lume com 1 filha, Nori e Sora sem filhas), uma sessão
// de topo sem feature e sem filhas, e uma sem feature com filha.
function seedScenario(): { lumeHandoff: string } {
  seedFeature(testDb, 'F1')
  seedFeature(testDb, 'F2')
  seedSession(testDb, 'lume', { repoId: 'r1', featureId: 'F1' })
  seedSession(testDb, 'nori', { repoId: 'r2', featureId: 'F1' })
  seedSession(testDb, 'sora', { repoId: 'r3', featureId: 'F2' })
  seedSession(testDb, 'lume-kid', { repoId: 'r4', featureId: 'F1' })
  seedSession(testDb, 'avulsa', { repoId: 'r5', featureId: null })
  seedSession(testDb, 'solo', { repoId: 'r1', featureId: null })
  seedSession(testDb, 'solo-kid', { repoId: 'r6', featureId: null })
  const lumeHandoff = dispatch('lume', 'lume-kid', 'r4')
  dispatch('solo', 'solo-kid', 'r6')
  return { lumeHandoff }
}

function produce(live: Map<string, LiveSessionState>) {
  const attention = projectAndCount(readAttentionInputFrom(testDb, live))
  const graph = buildSessionGraph({ ...readSessionGraphInput(testDb, live), attention })
  // O mesmo corte do switcherInUse sem o lado do renderer: nós vivos do grafo.
  const inUse = new Set(graph.nodes.filter((n) => n.status !== 'ended').map((n) => n.sessionId))
  return { graph, attention, inUse }
}

describe('all-mothers-model sobre o grafo e a fila do main', () => {
  beforeAll(() => tuiMenuWatch.attach(fakePty as never))

  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
  })

  afterEach(() => {
    for (const id of ALL) fakePty.emit('exit', { sessionId: id })
    testDb.close()
  })

  it('allMothers: toda sessão que o humano abriu (com ou sem feature/filhas); filhas ficam de fora', () => {
    seedScenario()
    const { graph, inUse } = produce(liveAll())
    const ids = allMothers(graph, inUse).map((n) => n.sessionId)
    expect(new Set(ids)).toEqual(new Set(['lume', 'nori', 'sora', 'avulsa', 'solo']))
  })

  it('a sessão sem feature e sem filhas entra; encerrada sai', () => {
    seedScenario()
    const avulsa = (live: Map<string, LiveSessionState>) => {
      const { graph, inUse } = produce(live)
      return allMothers(graph, inUse).some((n) => n.sessionId === 'avulsa')
    }
    expect(avulsa(liveAll())).toBe(true)
    const ended = liveAll()
    ended.delete('avulsa')
    expect(avulsa(ended)).toBe(false)
  })

  it('mãe recém-criada com 0 filhas (isMother false) entra pela feature', () => {
    seedScenario()
    const { graph, inUse } = produce(liveAll())
    const nori = graph.nodes.find((n) => n.sessionId === 'nori')
    expect(nori?.isMother).toBeFalsy()
    expect(allMothers(graph, inUse).map((n) => n.sessionId)).toContain('nori')
  })

  it('sessão fora de uso não vira tile', () => {
    seedScenario()
    const { graph, inUse } = produce(liveAll())
    inUse.delete('sora')
    expect(allMothers(graph, inUse).map((n) => n.sessionId)).not.toContain('sora')
  })

  // Mãe encerrada: a filha segue viva e passa a ser dirigida pelo humano — vira
  // tile próprio, com os pedidos dela contados ali (e não em lugar nenhum antes).
  it('filha cuja mãe encerrou continua visível como tile próprio', () => {
    const { lumeHandoff } = seedScenario()
    handoffStore.ask(lumeHandoff, 'posso apagar a tabela?')
    const live = liveAll()
    live.delete('lume')
    const { graph, attention, inUse } = produce(live)
    const mothers = allMothers(graph, inUse)
    expect(mothers.map((n) => n.sessionId)).toContain('lume-kid')
    expect(mothers.map((n) => n.sessionId)).not.toContain('lume')
    const needYou = humanQueue(attention)
    const kids = childIdsByMother(graph.edges, inUse)
    const perTile = mothers.map((m) =>
      countAttentionSubjects(needYouFor(needYou, m, (id) => kids.get(id) ?? new Set<string>())),
    )
    expect(perTile.reduce((a, b) => a + b, 0)).toBe(countAttentionSubjects(needYou))
  })

  it('com a mãe em uso, a filha não vira tile', () => {
    seedScenario()
    const { graph, inUse } = produce(liveAll())
    expect(allMothers(graph, inUse).map((n) => n.sessionId)).not.toContain('lume-kid')
  })

  it('needYouFor: menu da Lume + pergunta da filha dela → 2 itens na Lume, 0 na Nori', async () => {
    const { lumeHandoff } = seedScenario()
    handoffStore.ask(lumeHandoff, 'posso apagar a tabela?')
    await showScreen('lume', 'permission-bash')

    const { graph, attention, inUse } = produce(
      liveAll({ lume: { status: 'waiting' }, 'lume-kid': { status: 'working' } }),
    )
    const needYou = humanQueue(attention)
    const kids = childIdsByMother(graph.edges, inUse)
    const childIdsOf = (id: string) => kids.get(id) ?? new Set<string>()
    const byId = new Map(graph.nodes.map((n) => [n.sessionId, n]))

    const lume = needYouFor(needYou, byId.get('lume')!, childIdsOf)
    expect(lume.map((i) => i.sessionId).sort()).toEqual(['lume', 'lume-kid'])
    expect(lume.find((i) => i.sessionId === 'lume')?.kind).toBe('session_menu')
    expect(isAskItem(lume.find((i) => i.sessionId === 'lume-kid')!)).toBe(true)
    expect(needYouFor(needYou, byId.get('nori')!, childIdsOf)).toEqual([])

    // A soma dos recortes por tile bate com o badge do topo (mesmo needYou).
    const mothers = allMothers(graph, inUse)
    const perTile = mothers.map((m) => countAttentionSubjects(needYouFor(needYou, m, childIdsOf)))
    expect(perTile.reduce((a, b) => a + b, 0)).toBe(countAttentionSubjects(needYou))
    expect(countAttentionSubjects(needYou)).toBe(2)
  })
})
