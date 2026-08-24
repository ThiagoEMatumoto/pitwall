// Adoção de uma sessão JÁ ABERTA como filha de handoff.
//
// Por que RELANÇAR e não só marcar no banco: ser filha endereçável depende de
// duas flags fixadas no EXEC do processo — o apelido (`-n <alias>`, que é o
// endereço do SendMessage) e o `crossSessionInbound: 'accept'` do
// HANDOFF_CHILD_SETTINGS_JSON. Sem a segunda, a mensagem da mãe fica `held` em
// silêncio: a filha existiria no painel mas ninguém conseguiria falar com ela.
// sessions:rename só mexe no SQLite, não no processo vivo. Logo, adotar = matar a
// PTY e subir de novo com `--resume` (o histórico volta pelo transcript; o custo
// é o turno em andamento, que o diálogo avisa antes de confirmar).

import { getDb } from '../db'
import { broadcast } from '../notify'
import { ptyManager } from '../pty-manager'
import { findTranscriptPath } from '../transcript-path'
import * as store from '../handoff-store'
import { prepareHandoff } from './prepare'
import { resumeHandoffChild } from '../../ipc/sessions'
import type { AdoptedSession, AdoptSessionInput, HandoffStatus } from '../../../../shared/types/ipc'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Statuses em que uma sessão já pertence à equipe — adotar de novo criaria um 2º
// handoff apontando pra mesma sessão (dois cards, um só processo).
const LIVE_HANDOFF_STATUSES: ReadonlySet<HandoffStatus> = new Set<HandoffStatus>([
  'pending',
  'approved',
  'running',
  'needs_input',
  'interrupted',
])

// Teto de espera pelo exit da PTY antiga. O ptyManager só remove a sessão do mapa
// no evento `exit` (assíncrono), e resumeHandoffChild tem um guard de "filha
// viva" que devolveria alreadyRunning sem relançar nada — sem esta espera, a
// adoção viraria um no-op silencioso.
const PTY_EXIT_TIMEOUT_MS = 5000

interface SessionRow {
  id: string
  repo_id: string | null
  cc_session_id: string | null
  title: string | null
  // Guardado só pra desfazer o rename: o rollback tem que devolver o título
  // EXATAMENTE como estava (inclusive a origem 'auto'/'manual', que decide se o
  // título volta a ser derivado sozinho).
  title_source: string | null
}

// O 1º turno da sessão adotada, entregue como kickoff do relance (turno ÚNICO —
// nada de segunda mensagem enfileirada, cuja ordem dependeria de timing). Função
// PURA (testável): a sessão adotada NUNCA viu o briefing — ela nasceu como sessão
// comum —, então este texto é o único lugar onde ela descobre o próprio endereço
// e o canal de volta.
export function adoptionKickoff(args: { alias: string; handoffId: string; task: string }): string {
  return [
    `Você acabou de ser ADOTADA como sessão-filha de um orquestrador (por isso o reinício: seu histórico voltou por --resume).`,
    `- Seu apelido (e endereço do SendMessage): ${args.alias}`,
    `- handoffId: ${args.handoffId}`,
    `- Escopo combinado: ${args.task}`,
    'Seu interlocutor é o remetente da primeira <cross-session-message> que chegar; responda copiando o `from` dela para o `to` do SendMessage.',
    `Ao terminar, chame a MCP tool handoff_report com handoffId="${args.handoffId}" e um summary com evidência positiva.`,
  ].join('\n')
}

// Mata a PTY e ESPERA o exit. Ver PTY_EXIT_TIMEOUT_MS: sem esperar, o resume
// enxergaria a sessão como viva e não relançaria.
function killAndWaitExit(sessionId: string): Promise<void> {
  if (!ptyManager.isRunning(sessionId)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onExit = (e: { sessionId: string }) => {
      if (e.sessionId !== sessionId) return
      clearTimeout(timer)
      ptyManager.off('exit', onExit)
      resolve()
    }
    const timer = setTimeout(() => {
      ptyManager.off('exit', onExit)
      reject(new Error('A sessão não encerrou a tempo para ser relançada como filha.'))
    }, PTY_EXIT_TIMEOUT_MS)
    ptyManager.on('exit', onExit)
    ptyManager.kill(sessionId)
  })
}

// Ordem deliberada (o estado intermediário é escolhido, não acidental):
//   1. gates puros (sessão, repo, cc_session_id, transcript) — falha aqui não
//      deixa rastro nenhum;
//   2. compõe alias+briefing e fixa o alias em sessions.title (é dele que o
//      resume tira o `-n`); o alias é resolvido ANTES do rename pra não desviar
//      do próprio nome;
//   3. MATA a PTY antiga — ainda SEM handoff criado, de propósito: o listener de
//      exit do ipc/sessions marcaria o handoff como 'interrupted' com um erro
//      enganoso ("encerrou sem chamar handoff_report") se o vínculo já existisse;
//   4. cria o handoff e o vincula à sessão (markRunning), que é o que o
//      resumeHandoffChild exige pra saber o que retomar;
//   5. relança. Se o relance falhar, failIfRunning deixa o handoff 'interrupted'
//      — estado RECUPERÁVEL: com transcript no disco ele aparece retomável no
//      Crew Dock e um clique refaz o relance.
// Os passos 3-5 vivem no MESMO try: falhar entre eles (o kill tem teto de 5s)
// deixaria a sessão do usuário morta, o título trocado e um handoff 'pending' sem
// filha — que nada fecha nem retoma. Quando a queda é ANTES do vínculo (passo 4),
// rollbackAdoption desfaz o título e encerra o registro: ou a adoção completa, ou
// o mundo volta ao que era.
export async function adoptSession(input: AdoptSessionInput): Promise<AdoptedSession> {
  const db = getDb()
  const row = db
    .prepare('SELECT id, repo_id, cc_session_id, title, title_source FROM sessions WHERE id = ?')
    .get(input.sessionId) as SessionRow | undefined
  if (!row) throw new Error(`Sessão não encontrada: ${input.sessionId}`)
  if (input.motherSessionId === input.sessionId) {
    throw new Error('Uma sessão não pode ser mãe de si mesma.')
  }
  if (!row.repo_id) {
    throw new Error(
      'Sessão sem repo vinculado não vira filha — o handoff é sempre contra um repo.',
    )
  }

  const existing = store.getByChildSession(input.sessionId)
  if (existing && LIVE_HANDOFF_STATUSES.has(existing.status)) {
    throw new Error('Esta sessão já é filha de um handoff ativo.')
  }

  // Gate de adotabilidade: sem cc_session_id + transcript no disco, o `--resume`
  // não tem de onde reconstruir o histórico — matar a PTY jogaria a conversa
  // fora. Falha ANTES de qualquer efeito colateral.
  const ccSessionId = row.cc_session_id
  if (!ccSessionId || !UUID_RE.test(ccSessionId)) {
    throw new Error(
      'Sessão ainda sem id do Claude Code — não há o que retomar (espere o 1º turno).',
    )
  }
  if (!findTranscriptPath(ccSessionId)) {
    throw new Error(
      'Transcript da sessão não foi encontrado no disco — relançar perderia o histórico.',
    )
  }

  const { handoff: created, alias } = prepareHandoffForAdoption(input, row)

  // Alias em sessions.title ANTES do relance: é daí que resumeHandoffChild tira o
  // `-n <name>`, e o `-n` é literalmente o endereço do peer.
  db.prepare('UPDATE sessions SET title = ?, title_source = ? WHERE id = ?').run(
    alias,
    'manual',
    input.sessionId,
  )

  // Kill e relance no MESMO try: o kill tem teto de 5s e PODE estourar. Se ele
  // ficasse de fora, uma adoção que falha aqui deixaria o pior estado possível —
  // sessão do usuário morta, título já sobrescrito e um handoff 'pending' sem
  // filha (card fantasma que nada fecha). Ou a adoção completa, ou o registro
  // volta ao que era.
  let linkedToChild = false
  try {
    await killAndWaitExit(input.sessionId)

    const linked = store.markRunning(created.id, input.sessionId)
    linkedToChild = true
    broadcast('handoff:updated', linked)

    const { handoff, session } = resumeHandoffChild(created.id, {
      kickoff: adoptionKickoff({ alias, handoffId: created.id, task: input.task }),
    })
    return { handoff, alias, childSessionId: session.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (linkedToChild) {
      // Relance falhou com a PTY antiga já morta MAS com a filha vinculada:
      // 'interrupted' (recuperável) em vez de 'failed' (terminal) — com
      // transcript no disco o card fica retomável no Crew Dock e o humano refaz
      // o relance com um clique.
      const interrupted = store.failIfRunning(created.id, `Adoção não conseguiu relançar: ${msg}`)
      if (interrupted) broadcast('handoff:updated', interrupted)
      throw err
    }
    rollbackAdoption({ handoffId: created.id, row, reason: msg })
    throw err
  }
}

// Desfaz os dois efeitos já persistidos quando a adoção morre ANTES de vincular a
// filha (na prática: o kill que estourou os 5s). Sem isto sobram um título
// trocado e um handoff 'pending' órfão — pending sem child_session_id não é
// retomável nem reconciliável, então o card ficaria pra sempre no Crew Dock.
// Encerrado (failed) E dispensado, porque não houve trabalho nenhum a mostrar.
// Best-effort: um erro aqui não pode mascarar o erro ORIGINAL, que é o que o
// diálogo mostra ao humano.
function rollbackAdoption(args: { handoffId: string; row: SessionRow; reason: string }): void {
  try {
    getDb()
      .prepare('UPDATE sessions SET title = ?, title_source = ? WHERE id = ?')
      .run(args.row.title, args.row.title_source, args.row.id)
  } catch (err) {
    console.error('[adopt] rollback do título falhou:', err)
  }
  try {
    store.fail(args.handoffId, `Adoção abortada antes de vincular a filha: ${args.reason}`)
    const dismissed = store.dismiss(args.handoffId)
    broadcast('handoff:updated', dismissed)
  } catch (err) {
    console.error('[adopt] rollback do handoff falhou:', err)
  }
}

// Criação do registro pelo caminho compartilhado com handoffs:create-manual. O
// contexto guarda a origem: depois do relance, child_session_id aponta pra sessão
// NOVA, então sem isto se perderia de onde a filha veio.
function prepareHandoffForAdoption(input: AdoptSessionInput, row: SessionRow) {
  return prepareHandoff({
    targetRepoId: row.repo_id!,
    motherSessionId: input.motherSessionId,
    task: input.task,
    featureId: input.featureId ?? null,
    mode: input.mode,
    context: {
      adopted: true,
      adoptedAt: Date.now(),
      adoptedFromSessionId: row.id,
      adoptedFromCcSessionId: row.cc_session_id,
      adoptedFromTitle: row.title,
    },
  })
}
