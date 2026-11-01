// "Tornar mãe": a filha passa a ser mãe de verdade.
//
// 1. solta os handoffs em que a conversa é filha (o mesmo release do Desvincular);
// 2. as netas que linhas antigas da conversa lideravam passam para a linha atual;
// 3. marca "essa é a mãe" (mother_pins, por conversa);
// 4. relança sem as flags de filha (o --settings com accept-inbound e a denylist
//    são do PROCESSO, não do banco). Turno em andamento não é interrompido: o
//    relance espera o fim do turno, a menos que o humano peça "Reiniciar agora".
// O worktree da filha fica onde está: o relance volta no cwd em que ela rodou.
import { getDb } from '../db'
import { broadcast } from '../notify'
import { ptyManager } from '../pty-manager'
import * as store from '../handoff-store'
import { findTranscriptPath } from '../transcript-path'
import { acceptsCrossSessionInbound } from '../session-settings'
import { buildSessionsFileIndex, onTurnEnded } from '../session-activity'
import { liveSessionStates } from '../live-session-states'
import { listMotherPins, motherPinKeyOf, setMotherPin } from '../mother-pins-store'
import { resumeConversation } from '../../ipc/sessions'
import { latestSpawnArgs, type SpawnArgs } from '../spawn-args'
import { killAndWaitExit } from './kill-and-wait'
import type {
  MotherRestartEvent,
  PromoteMotherInput,
  PromoteMotherResult,
} from '../../../../shared/types/mother-pins'

interface SessionRowLite {
  id: string
  cc_session_id: string | null
  repo_id: string | null
}

function sessionRow(sessionId: string): SessionRowLite {
  const row = getDb()
    .prepare('SELECT id, cc_session_id, repo_id FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRowLite | undefined
  if (!row) throw new Error(`Sessão não encontrada: ${sessionId}`)
  return row
}

export function broadcastMotherPins(): void {
  broadcast('mother-pins:updated', listMotherPins())
}

// Parte só de banco, síncrona e idempotente.
export function promoteInDb(sessionId: string): {
  pinKey: string
  released: number
  transferred: number
} {
  const row = sessionRow(sessionId)
  let released = 0
  for (let guard = 0; guard < 64; guard++) {
    const handoff = store.getByChildConversation(sessionId)
    if (!handoff) break
    broadcast('handoff:updated', store.release(handoff.id))
    released++
  }
  let transferred = 0
  if (row.cc_session_id) {
    const siblings = getDb()
      .prepare('SELECT id FROM sessions WHERE cc_session_id = ? AND id <> ?')
      .all(row.cc_session_id, sessionId) as Array<{ id: string }>
    for (const s of siblings) {
      if (ptyManager.isRunning(s.id)) continue
      for (const moved of store.transferMother(s.id, sessionId)) {
        broadcast('handoff:updated', moved)
        transferred++
      }
    }
    // O resume copia o spawn_args da linha anterior e o wake de hibernada o
    // reaplica: sem isto a mãe acordaria com o --settings de filha de novo.
    getDb()
      .prepare(
        `UPDATE sessions SET spawn_args = json_set(spawn_args, '$.handoffChild', json('false'))
          WHERE cc_session_id = ? AND spawn_args IS NOT NULL AND json_valid(spawn_args)`,
      )
      .run(row.cc_session_id)
  }
  const pinKey = motherPinKeyOf(sessionId)!
  setMotherPin(pinKey, true)
  broadcastMotherPins()
  return { pinKey, released, transferred }
}

// Ainda roda com o exec de filha? (o arquivo de --settings dela aceita inbound).
export function needsMotherRestart(sessionId: string): boolean {
  return ptyManager.isRunning(sessionId) && acceptsCrossSessionInbound(sessionId)
}

function emit(e: MotherRestartEvent): void {
  broadcast('mother-pins:restart', e)
}

export async function restartAsMother(sessionId: string): Promise<string> {
  // "Reiniciar agora" com relance agendado: o agendado não dispara de novo.
  cancelPendingOf(sessionId)
  const row = sessionRow(sessionId)
  if (!row.cc_session_id || !findTranscriptPath(row.cc_session_id)) {
    throw new Error(
      'Transcript da sessão não foi encontrado no disco — reiniciar perderia o histórico.',
    )
  }
  const relaunchAs = motherSpawnArgs(latestSpawnArgs(getDb(), row.cc_session_id))
  await killAndWaitExit(sessionId)
  const { session } = resumeConversation(
    { repoId: row.repo_id, ccSessionId: row.cc_session_id },
    'main',
    { relaunchAs },
  )
  return session.id
}

// O resume manual volta com as flags default: a mãe promovida perdia o modelo e o
// modo de permissão. Mantém os da sessão e tira só o que é de filha: o --settings
// (handoffChild), o briefing do handoff e o 'plan' imposto pelo modo de investigação.
export function motherSpawnArgs(args: SpawnArgs | null): SpawnArgs | null {
  if (!args) return null
  return {
    ...args,
    handoffChild: false,
    systemPromptText: null,
    permissionMode: args.permissionMode === 'plan' ? null : args.permissionMode,
  }
}

// ccSessionId → sessions.id com relance pendente até o fim do turno.
const pendingRestarts = new Map<string, string>()
let offTurnEnded: (() => void) | null = null
let exitWatch: ((e: { sessionId: string }) => void) | null = null

// Sessão encerrada antes do fim do turno: o relance agendado morre junto (senão um
// turn-ended tardio, de outra linha da conversa, relançaria quem o humano fechou).
function cancelPendingOf(sessionId: string): void {
  for (const [cc, id] of pendingRestarts) if (id === sessionId) pendingRestarts.delete(cc)
}

function runRestart(sessionId: string): void {
  restartAsMother(sessionId)
    .then((newId) => emit({ sessionId, state: 'restarted', newSessionId: newId }))
    .catch((err: unknown) =>
      emit({ sessionId, state: 'failed', error: err instanceof Error ? err.message : String(err) }),
    )
}

function scheduleRestart(sessionId: string, cc: string): void {
  pendingRestarts.set(cc, sessionId)
  offTurnEnded ??= onTurnEnded((ccSessionId) => {
    const pending = pendingRestarts.get(ccSessionId)
    if (!pending) return
    pendingRestarts.delete(ccSessionId)
    runRestart(pending)
  })
  if (!exitWatch) {
    exitWatch = (e) => cancelPendingOf(e.sessionId)
    ptyManager.on('exit', exitWatch)
  }
  emit({ sessionId, state: 'scheduled' })
}

export function pendingMotherRestart(sessionId: string): boolean {
  return [...pendingRestarts.values()].includes(sessionId)
}

function isWorking(sessionId: string): boolean {
  const status = liveSessionStates(buildSessionsFileIndex()).get(sessionId)?.status
  // waiting = parada num prompt de permissão/pergunta NO MEIO do turno: matar agora
  // perderia o pedido. Só idle (fim de turno) relança na hora.
  return status === 'working' || status === 'starting' || status === 'waiting'
}

export function promoteToMother(input: PromoteMotherInput): PromoteMotherResult {
  const { pinKey, released, transferred } = promoteInDb(input.sessionId)
  const base = { pinKey, released, transferred }
  if (!needsMotherRestart(input.sessionId)) return { ...base, restart: 'not-needed' }
  const cc = sessionRow(input.sessionId).cc_session_id
  if (input.restart === 'now' || !cc || !isWorking(input.sessionId)) {
    runRestart(input.sessionId)
    return { ...base, restart: 'restarting' }
  }
  scheduleRestart(input.sessionId, cc)
  return { ...base, restart: 'scheduled' }
}
