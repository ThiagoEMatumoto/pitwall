import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { findTranscriptPath } from './transcript-path'
import type {
  CreateHandoffInput,
  Handoff,
  HandoffMode,
  HandoffOutcome,
  HandoffStatus,
} from '../../../shared/types/ipc'

interface HandoffRow {
  id: string
  mother_session_id: string | null
  target_repo_id: string
  child_session_id: string | null
  feature_id: string | null
  task: string
  context_json: string | null
  composed_prompt: string
  status: string
  mode: string
  current_step: string | null
  step_updated_at: number | null
  pending_question: string | null
  question_asked_at: number | null
  summary: string | null
  error: string | null
  created_at: number
  updated_at: number
  // Instrumentação (migration 026). consumed_at: quando a mãe consumiu o
  // resultado; from_repo_id: repo de origem; outcome: feedback humano.
  consumed_at: number | null
  from_repo_id: string | null
  outcome: string | null
  // Dispensa manual no Crew Dock (migration 036). Vem no h.* do SELECT_HANDOFF.
  dismissed_at: number | null
  // Resolvido via LEFT JOIN repos (null se o repo-alvo foi removido).
  target_repo_label: string | null
}

// SELECT base com o label do repo-alvo resolvido. LEFT JOIN: handoff sobrevive à
// remoção do repo (label vira null), mas continua listável.
const SELECT_HANDOFF =
  'SELECT h.*, r.label AS target_repo_label FROM handoffs h LEFT JOIN repos r ON r.id = h.target_repo_id'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Memo de existência de transcript por cc_session_id, com VALIDADE.
// findTranscriptPath varre ~/.claude/projects/*/ com existsSync — I/O SÍNCRONO —,
// e toEntity roda por LINHA no list(): sem memo, um dock com 10 filhas
// interrompidas custaria 10 varreduras de diretório a cada recarga da lista. O
// list() é recarregado a cada handoff:updated, então o ganho está justamente nas
// RAJADAS de recarga — não em lembrar do arquivo pra sempre.
//
// Só memoizamos o `true`: a ausência é sempre rebuscada, senão uma filha que
// ainda não escreveu o .jsonl ficaria marcada como não-retomável pra sempre.
//
// O `true`, porém, também apodrece: o Pitwall fica dias aberto e o transcript é
// um arquivo de TERCEIRO (o Claude Code escreve em ~/.claude/projects, e limpeza
// manual ou do próprio CLI apaga). Memo eterno = card anunciando "Retomar" pra
// uma conversa que já não existe, até reiniciar o app. Por isso o carimbo expira:
// dentro da janela o dock recarrega de graça; fora dela, uma varredura reconfere.
const TRANSCRIPT_MEMO_TTL_MS = 30_000
const transcriptSeen = new Map<string, number>()

function hasTranscript(ccSessionId: string): boolean {
  const now = Date.now()
  const seenAt = transcriptSeen.get(ccSessionId)
  if (seenAt !== undefined && now - seenAt < TRANSCRIPT_MEMO_TTL_MS) return true
  if (findTranscriptPath(ccSessionId) === null) {
    // Sumiu do disco: esquece o carimbo velho, senão ele voltaria a valer na
    // próxima chamada dentro da janela.
    transcriptSeen.delete(ccSessionId)
    return false
  }
  transcriptSeen.set(ccSessionId, now)
  return true
}

// Retomável = interrompido, com filha atrelada e transcript dela ainda no disco
// (é de onde o `claude --resume` reconstrói o histórico). Mesmo gate do
// handoffs:is-resumable, só que servido junto da lista — o Crew Dock precisa
// disto pra decidir quem CONTINUA visível, e um IPC por card não escala.
//
// Custo: o disco só é tocado por linha 'interrupted' COM child_session_id. Todo
// o resto (a esmagadora maioria: running, done, pending) sai false sem nenhum
// syscall — o short-circuit vem antes da query de cc_session_id.
function isResumable(row: HandoffRow): boolean {
  if (row.status !== 'interrupted' || !row.child_session_id) return false
  const child = getDb()
    .prepare('SELECT cc_session_id FROM sessions WHERE id = ?')
    .get(row.child_session_id) as { cc_session_id: string | null } | undefined
  const ccSessionId = child?.cc_session_id
  if (!ccSessionId || !UUID_RE.test(ccSessionId)) return false
  return hasTranscript(ccSessionId)
}

function toEntity(row: HandoffRow): Handoff {
  return {
    id: row.id,
    motherSessionId: row.mother_session_id,
    targetRepoId: row.target_repo_id,
    targetRepoLabel: row.target_repo_label,
    childSessionId: row.child_session_id,
    featureId: row.feature_id,
    task: row.task,
    contextJson: row.context_json,
    composedPrompt: row.composed_prompt,
    status: row.status as HandoffStatus,
    mode: row.mode as HandoffMode,
    currentStep: row.current_step,
    stepUpdatedAt: row.step_updated_at,
    pendingQuestion: row.pending_question,
    questionAskedAt: row.question_asked_at,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumedAt: row.consumed_at,
    fromRepoId: row.from_repo_id,
    outcome: (row.outcome as HandoffOutcome | null) ?? null,
    dismissedAt: row.dismissed_at,
    resumable: isResumable(row),
  }
}

function getRow(id: string): HandoffRow | undefined {
  return getDb().prepare(`${SELECT_HANDOFF} WHERE h.id = ?`).get(id) as HandoffRow | undefined
}

// Carrega a entidade fresca pós-mutação; lança se sumiu (id inválido).
function fresh(id: string): Handoff {
  const row = getRow(id)
  if (!row) throw new Error(`handoff not found: ${id}`)
  return toEntity(row)
}

// Status corrente sem o JOIN do label — barato pra capturar o from_status ANTES
// de uma mutação. NULL se o handoff não existe (não loga nada nesse caso).
function currentStatus(id: string): string | null {
  const row = getDb().prepare('SELECT status FROM handoffs WHERE id = ?').get(id) as
    | { status: string }
    | undefined
  return row?.status ?? null
}

// Trilha imutável: grava uma linha em handoff_events por transição/evento. É o
// ponto CENTRAL da instrumentação — todos os mutadores de status chamam aqui em
// vez de cada handler logar por conta própria. from_status é o estado ANTES da
// mutação (capturado pelo chamador); to_status é o estado resultante.
function logEvent(
  handoffId: string,
  event: string,
  toStatus: string,
  fromStatus: string | null,
  detail?: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO handoff_events (id, handoff_id, from_status, to_status, event, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), handoffId, fromStatus, toStatus, event, detail ?? null, Date.now())
}

export function create(input: CreateHandoffInput): Handoff {
  const now = Date.now()
  const id = input.id ?? randomUUID()
  getDb()
    .prepare(
      `INSERT INTO handoffs
         (id, mother_session_id, target_repo_id, from_repo_id, child_session_id, feature_id, task,
          context_json, composed_prompt, status, mode, current_step, step_updated_at,
          summary, error, created_at, updated_at)
       VALUES (@id, @mother_session_id, @target_repo_id, @from_repo_id, @child_session_id, @feature_id, @task,
               @context_json, @composed_prompt, @status, @mode, @current_step, @step_updated_at,
               @summary, @error, @created_at, @updated_at)`,
    )
    .run({
      id,
      mother_session_id: input.motherSessionId ?? null,
      target_repo_id: input.targetRepoId,
      from_repo_id: input.fromRepoId ?? null,
      child_session_id: null,
      feature_id: input.featureId ?? null,
      task: input.task,
      context_json: input.contextJson ?? null,
      composed_prompt: input.composedPrompt,
      status: 'pending',
      mode: input.mode ?? 'interactive',
      current_step: null,
      step_updated_at: null,
      summary: null,
      error: null,
      created_at: now,
      updated_at: now,
    })
  // Nascimento do handoff: from_status null (não existia antes), to pending.
  logEvent(id, 'create', 'pending', null)
  // Re-lê via JOIN pra preencher target_repo_label.
  return fresh(id)
}

export function get(id: string): Handoff | null {
  const row = getRow(id)
  return row ? toEntity(row) : null
}

// Nomes já ocupados por sessões VIVAS — base de unicidade do alias da filha (o
// alias vira o `-n <name>` e é espelhado em sessions.title). Colisão de nome faz
// a CLI desambiguar com hex ilegível no ListAgents, então é o que evitamos aqui.
export function activeSessionNames(): string[] {
  const rows = getDb()
    .prepare("SELECT title FROM sessions WHERE status = 'running' AND title IS NOT NULL")
    .all() as { title: string }[]
  return rows.map((r) => r.title)
}

// Alias da filha de um handoff (null se ainda não spawnou ou se a sessão sumiu).
// Fonte da verdade = sessions.title, fixado como 'manual' no spawn.
export function childAlias(childSessionId: string | null): string | null {
  if (!childSessionId) return null
  const row = getDb()
    .prepare('SELECT title FROM sessions WHERE id = ?')
    .get(childSessionId) as { title: string | null } | undefined
  return row?.title ?? null
}

export function list(opts?: { status?: HandoffStatus | HandoffStatus[] }): Handoff[] {
  const db = getDb()
  let rows: HandoffRow[]
  if (opts?.status !== undefined) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status]
    const placeholders = statuses.map(() => '?').join(', ')
    rows = db
      .prepare(
        `${SELECT_HANDOFF} WHERE h.status IN (${placeholders}) ORDER BY h.created_at DESC`,
      )
      .all(...statuses) as HandoffRow[]
  } else {
    rows = db.prepare(`${SELECT_HANDOFF} ORDER BY h.created_at DESC`).all() as HandoffRow[]
  }
  return rows.map(toEntity)
}

// Marca approved. Permite sobrescrever o composed_prompt editado pelo humano no
// gate. A transição para running + child_session_id vem numa wave posterior.
export function approve(id: string, opts: { composedPrompt?: string }): Handoff {
  const db = getDb()
  const from = currentStatus(id)
  if (opts.composedPrompt !== undefined) {
    db.prepare(
      'UPDATE handoffs SET status = ?, composed_prompt = ?, updated_at = ? WHERE id = ?',
    ).run('approved', opts.composedPrompt, Date.now(), id)
  } else {
    db.prepare('UPDATE handoffs SET status = ?, updated_at = ? WHERE id = ?').run(
      'approved',
      Date.now(),
      id,
    )
  }
  logEvent(id, 'approve', 'approved', from)
  return fresh(id)
}

export function reject(id: string): Handoff {
  const from = currentStatus(id)
  getDb()
    .prepare('UPDATE handoffs SET status = ?, updated_at = ? WHERE id = ?')
    .run('rejected', Date.now(), id)
  logEvent(id, 'reject', 'rejected', from)
  return fresh(id)
}

// Adquire a filha e passa a running. Zera dismissed_at DE PROPÓSITO.
//
// INVARIANTE DE VISIBILIDADE: um handoff com filha VIVA nunca pode estar
// invisível em todas as superfícies ao mesmo tempo. Dispensar um card é
// permitido justamente quando não há filha (ex.: ainda pending, esperando o
// gate) — mas se depois o gate aprova e a filha nasce, o carimbo antigo tiraria
// esse card do dock (dockCrew), tiraria a sessão da strip/switcher/Home
// (childSessionIds) e ainda calaria a notificação nativa (isActiveCrewChild):
// uma PTY rodando e queimando token sem NENHUM lugar onde ser encontrada.
// Adquirir filha viva é, portanto, voltar a ser visível.
export function markRunning(id: string, childSessionId: string): Handoff {
  const from = currentStatus(id)
  getDb()
    .prepare(
      'UPDATE handoffs SET status = ?, child_session_id = ?, dismissed_at = NULL, updated_at = ? WHERE id = ?',
    )
    .run('running', childSessionId, Date.now(), id)
  logEvent(id, 'markRunning', 'running', from)
  return fresh(id)
}

export function report(id: string, summary: string): Handoff {
  const from = currentStatus(id)
  // Report duplicado: o handoff já está done. NÃO sobrescreve o summary original
  // (o primeiro resultado é o autoritativo, e é o que a mãe pode já ter consumido)
  // e registra um evento próprio — antes o segundo report passava como sucesso e
  // apagava o primeiro summary sem deixar rastro distinguível.
  if (from === 'done') {
    logEvent(id, 'reportDuplicate', 'done', 'done', summary)
    return fresh(id)
  }
  getDb()
    .prepare('UPDATE handoffs SET status = ?, summary = ?, updated_at = ? WHERE id = ?')
    .run('done', summary, Date.now(), id)
  logEvent(id, 'report', 'done', from)
  return fresh(id)
}

// Progresso NÃO-terminal: a filha reporta o passo atual sem virar done. Grava se
// estiver em estado VIVO (running OU needs_input) e PRESERVA o status — progresso
// NÃO é resposta a pergunta. Uma filha que perguntou e seguiu trabalhando continua
// needs_input com a pergunta intacta (a UI precisa continuar mostrando o bloqueio);
// só a resposta da mãe (resume, via handoff_message ou pelo inbox) encerra a
// pergunta. done segue exclusivo de report.
export function progress(id: string, step: string): Handoff {
  const now = Date.now()
  const from = currentStatus(id)
  const res = getDb()
    .prepare(
      `UPDATE handoffs
         SET current_step = ?, step_updated_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('running','needs_input')`,
    )
    .run(step, now, now, id)
  // Só loga se a transição valeu (estava vivo). to_status = from porque progress
  // não muda status. detail = o passo reportado.
  if (res.changes > 0 && from) logEvent(id, 'progress', from, from, step)
  return fresh(id)
}

// A filha levanta uma pergunta (handoff_ask) e passa pra needs_input, gravando a
// pergunta + timestamp. Aceita running E needs_input: uma segunda pergunta antes
// da resposta é EMPILHADA no mesmo campo (separada por linha em branco) em vez de
// virar no-op invisível — a mãe precisa ver todos os bloqueios abertos, e
// question_asked_at guarda o instante do PRIMEIRO (é o "bloqueada desde"). Empilha
// só a partir de needs_input: em running a pergunta pendente pode ser resíduo de
// um ciclo anterior (ex.: handoff interrompido e retomado). Fora do estado vivo
// (pending/done/...) segue no-op.
export function ask(id: string, question: string): Handoff {
  const now = Date.now()
  const row = getDb()
    .prepare('SELECT status, pending_question, question_asked_at FROM handoffs WHERE id = ?')
    .get(id) as
    | { status: string; pending_question: string | null; question_asked_at: number | null }
    | undefined
  if (!row || (row.status !== 'running' && row.status !== 'needs_input')) return fresh(id)

  const stacked = row.status === 'needs_input' && !!row.pending_question
  getDb()
    .prepare(
      `UPDATE handoffs
         SET status = 'needs_input', pending_question = ?, question_asked_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      stacked ? `${row.pending_question}\n\n${question}` : question,
      stacked ? row.question_asked_at : now,
      now,
      id,
    )
  logEvent(id, 'ask', 'needs_input', row.status, question)
  return fresh(id)
}

// A mãe respondeu (handoff_message) e a filha deve retomar: needs_input → running,
// limpa a pergunta pendente. Só age se estava needs_input (idempotente fora dele).
export function resume(id: string): Handoff {
  const now = Date.now()
  const from = currentStatus(id)
  const res = getDb()
    .prepare(
      `UPDATE handoffs
         SET status = 'running', pending_question = NULL, question_asked_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'needs_input'`,
    )
    .run(now, id)
  if (res.changes > 0) logEvent(id, 'resume', 'running', from)
  return fresh(id)
}

export function fail(id: string, error: string): Handoff {
  const from = currentStatus(id)
  getDb()
    .prepare('UPDATE handoffs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
    .run('failed', error, Date.now(), id)
  logEvent(id, 'fail', 'failed', from, error)
  return fresh(id)
}

// Reconciliação: a sessão-filha morreu (PTY exit/crash). Só transiciona para
// 'interrupted' (estado RECUPERÁVEL, NÃO 'failed') se ainda estava VIVA (running
// OU needs_input) — NÃO sobrescreve um done/rejected já gravado. Uma filha que
// perguntou (needs_input) e cuja PTY morreu de fato também é interrompida (senão
// trava o dedup do repo-alvo pra sempre). 'interrupted' não conta como ativo
// (libera o dedup) e pode ser RETOMADO pelo humano. 'failed' fica reservado a erro REAL reportado
// pela própria filha (handoff_report de falha / fail()).
// Retorna o handoff atualizado, ou null se nada foi alterado (não estava vivo).
export function failIfRunning(id: string, error: string): Handoff | null {
  const from = currentStatus(id)
  const res = getDb()
    .prepare(
      "UPDATE handoffs SET status = 'interrupted', error = ?, updated_at = ? WHERE id = ? AND status IN ('running','needs_input')",
    )
    .run(error, Date.now(), id)
  if (res.changes === 0) return null
  logEvent(id, 'interrupt', 'interrupted', from, error)
  return fresh(id)
}

// Reconciliação em runtime, independente do evento PTY exit: pega filhas
// fechadas/crashadas (ou nunca atreladas) sem esperar o exit. SEGURA por design —
// só interrompe handoffs cuja session-filha NÃO está 'running' na tabela sessions.
// Um filho VIVO em trabalho longo OU aguardando a mãe (needs_input) NÃO pode ser
// morto enquanto a session-filha segue 'running'. Cobre tanto running quanto
// needs_input (ambos in-flight). Marca 'interrupted' (RECUPERÁVEL, não 'failed'):
// a filha morreu sem reportar erro real, então o handoff sai do ativo (libera o
// dedup) mas fica retomável. Como 'interrupted' não entra no predicado
// ('running','needs_input'), passadas seguintes NÃO o re-reconciliam.
// Retorna o nº de handoffs reconciliados.
export function reconcileStuck(): number {
  const db = getDb()
  const error = 'Sessão-filha encerrada sem reportar conclusão'
  // UPDATE em lote: SELECionar os ids + status ANTES, pra capturar o from_status
  // de cada um e logar uma linha por handoff reconciliado (o lote em si não diz
  // quem mudou). O predicado é idêntico ao do UPDATE.
  const stuck = db
    .prepare(
      `SELECT id, status FROM handoffs
       WHERE status IN ('running','needs_input')
         AND (child_session_id IS NULL
              OR child_session_id NOT IN (SELECT id FROM sessions WHERE status = 'running'))`,
    )
    .all() as Array<{ id: string; status: string }>
  const res = db
    .prepare(
      `UPDATE handoffs SET status = 'interrupted', error = ?, updated_at = ?
       WHERE status IN ('running','needs_input')
         AND (child_session_id IS NULL
              OR child_session_id NOT IN (SELECT id FROM sessions WHERE status = 'running'))`,
    )
    .run(error, Date.now())
  for (const h of stuck) {
    logEvent(h.id, 'reconcileStuck', 'interrupted', h.status, error)
  }
  return res.changes
}

// Busca o handoff cuja filha é esta sessão (pra reconciliar no PTY exit). NULL se
// a sessão não veio de um handoff.
export function getByChildSession(childSessionId: string): Handoff | null {
  const row = getDb()
    .prepare(`${SELECT_HANDOFF} WHERE h.child_session_id = ?`)
    .get(childSessionId) as HandoffRow | undefined
  return row ? toEntity(row) : null
}

// A mãe consumiu o resultado: proxy = leu via handoff_result com status='done'.
// Idempotente: o WHERE consumed_at IS NULL garante uma única marcação (e um único
// evento 'consume'), mesmo com polling repetido. Só conta pra handoffs done.
export function markConsumed(id: string): Handoff {
  const res = getDb()
    .prepare(
      "UPDATE handoffs SET consumed_at = ?, updated_at = ? WHERE id = ? AND consumed_at IS NULL AND status = 'done'",
    )
    .run(Date.now(), Date.now(), id)
  if (res.changes > 0) logEvent(id, 'consume', 'done', 'done')
  return fresh(id)
}

// Motivo gravado quando soltar encerra um handoff que ainda estava vivo. Texto
// PRÓPRIO (e não o do reconcileStuck) porque a filha não morreu: ela foi solta.
const RELEASE_ERROR = 'Solta do painel: a sessão deixou de ser filha deste handoff'

// Dispensa manual: o humano tira o card do Crew Dock. NÃO mexe em `status` de
// propósito — a filha pode estar viva, e forjar um 'rejected'/'failed' só pra
// esconder o card corromperia a trilha de eventos e a instrumentação. O que muda
// é só a EXIBIÇÃO (quem filtra por dismissed_at é a camada de cima).
// Idempotente: o WHERE dismissed_at IS NULL garante um único carimbo e um único
// evento 'dismiss' (to_status = from_status, porque não houve transição).
export function dismiss(id: string): Handoff {
  const status = currentStatus(id)
  if (status === null) throw new Error(`handoff not found: ${id}`)
  const res = getDb()
    .prepare(
      'UPDATE handoffs SET dismissed_at = ?, updated_at = ? WHERE id = ? AND dismissed_at IS NULL',
    )
    .run(Date.now(), Date.now(), id)
  if (res.changes > 0) logEvent(id, 'dismiss', status, status)
  return fresh(id)
}

// Desfaz a dispensa: apaga o carimbo e o card volta ao dock. Operação SIMÉTRICA
// de `dismiss` — mesmo alcance (só exibição, `status` intocado) e mesma trilha.
// Existe porque dispensar virou reversível na UI (toast "Desfazer"): antes disso
// o único caminho que zerava dismissed_at era o markRunning, e desfazer um clique
// errado exigia esperar a filha renascer.
// Idempotente pelo mesmo motivo do dismiss: o WHERE dismissed_at IS NOT NULL
// garante um único evento 'undismiss' por dispensa desfeita.
export function undismiss(id: string): Handoff {
  const status = currentStatus(id)
  if (status === null) throw new Error(`handoff not found: ${id}`)
  const res = getDb()
    .prepare(
      'UPDATE handoffs SET dismissed_at = NULL, updated_at = ? WHERE id = ? AND dismissed_at IS NOT NULL',
    )
    .run(Date.now(), id)
  if (res.changes > 0) logEvent(id, 'undismiss', status, status)
  return fresh(id)
}

// Soltar do painel: o humano CORTA o vínculo mãe→filha, de propósito, devolvendo
// a sessão à condição de sessão normal. É onde difere de `dismiss`, que só tira o
// card de vista MANTENDO handoffs.child_session_id apontando pra sessão: aqui o
// ponteiro é ZERADO, e é isso que muda o mundo — a sessão sai do childSessionIds
// (reaparece na strip/switcher), some do isActiveCrewChild (volta a notificar como
// qualquer outra), deixa de ser achada por getByChildSession no PTY exit e não é
// mais relinkada pelo sessions:resume (que já ignora handoff com dismissed_at).
//
// O child_session_id ANTIGO vai no detail do evento antes do UPDATE: a coluna era
// a única referência à filha, e sem esse carimbo a rastreabilidade dela se perderia
// pra sempre.
//
// Sobre o status: um handoff VIVO (running/needs_input) sem filha atrelada é uma
// mentira no banco, e é exatamente o que o reconcileStuck varre (o predicado inclui
// child_session_id IS NULL). Deixar por conta dele carimbaria 'interrupted' com o
// erro genérico "encerrada sem reportar conclusão" — que não foi o que aconteceu.
// Então o próprio release encerra o registro, com o motivo REAL, e o liberado passa
// a ser IMUNE ao reconcileStuck (interrupted não está no predicado). Fora do estado
// vivo o status é preservado: soltar a filha de um handoff já done/failed não
// reescreve o desfecho dele.
//
// A sessão solta continua rodando com as flags de exec da filha (o
// HANDOFF_CHILD_SETTINGS_JSON, com a denylist restritiva) — isso é do PROCESSO, não
// do banco, e só sai num relançamento. Quem chama avisa o humano (ver HandoffCard).
export function release(id: string): Handoff {
  const db = getDb()
  const row = db
    .prepare('SELECT status, child_session_id, dismissed_at FROM handoffs WHERE id = ?')
    .get(id) as
    | { status: string; child_session_id: string | null; dismissed_at: number | null }
    | undefined
  if (!row) throw new Error(`handoff not found: ${id}`)
  // Já solto (sem vínculo E fora do painel): no-op, pra não empilhar eventos
  // idênticos a cada clique repetido.
  if (row.child_session_id === null && row.dismissed_at !== null) return fresh(id)

  const live = row.status === 'running' || row.status === 'needs_input'
  const now = Date.now()
  // COALESCE: se já tinha sido dispensado antes, preserva o instante original da
  // saída do painel — soltar não é uma segunda dispensa.
  if (live) {
    db.prepare(
      `UPDATE handoffs
         SET child_session_id = NULL, dismissed_at = COALESCE(dismissed_at, ?),
             status = 'interrupted', error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(now, RELEASE_ERROR, now, id)
  } else {
    db.prepare(
      `UPDATE handoffs
         SET child_session_id = NULL, dismissed_at = COALESCE(dismissed_at, ?), updated_at = ?
       WHERE id = ?`,
    ).run(now, now, id)
  }
  logEvent(id, 'release', live ? 'interrupted' : row.status, row.status, row.child_session_id)
  return fresh(id)
}

// Feedback humano sobre a utilidade do handoff: useful | wrong | partial. Persiste
// o outcome e loga um evento 'feedback' (to_status = status corrente, detail =
// outcome). Permite revisão (sobrescreve outcome anterior).
export function setOutcome(id: string, outcome: HandoffOutcome): Handoff {
  const status = currentStatus(id)
  if (status === null) throw new Error(`handoff not found: ${id}`)
  getDb()
    .prepare('UPDATE handoffs SET outcome = ?, updated_at = ? WHERE id = ?')
    .run(outcome, Date.now(), id)
  logEvent(id, 'feedback', status, status, outcome)
  return fresh(id)
}

// A sessão (endereçada pelo cc_session_id do Claude Code) é filha de um handoff
// ativo — ou seja, está sob a alçada do Crew Dock? O dock mostra o estado dela o
// tempo todo e ainda pulsa na trilha quando ela espera; a notificação nativa
// seria o MESMO aviso duas vezes. Espelha o filtro que o toast já faz no
// renderer (NotificationToast.isCrewChild), agora do lado do main.
//
// dismissed_at IS NULL faz parte do gate pela mesma invariante do markRunning: o
// silêncio aqui só se justifica porque o dock avisa — e um card dispensado NÃO
// está no dock (ver dockCrew). Sem esta cláusula, dispensar viraria mordaça: a
// filha pediria atenção e nada apareceria em lugar nenhum.
export function isActiveCrewChild(ccSessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM handoffs h
         JOIN sessions s ON s.id = h.child_session_id
        WHERE s.cc_session_id = ?
          AND h.dismissed_at IS NULL
          AND h.status IN ('pending','approved','running','needs_input')
        LIMIT 1`,
    )
    .get(ccSessionId)
  return row !== undefined
}

// Dedup por alvo: handoff ativo (pending/approved/running/needs_input) pro mesmo
// repo-alvo. Usado pra evitar dois agentes mutando o mesmo repo em paralelo.
//
// motherSessionId opcional ESTREITA a busca à mãe dada ("eu já despachei uma
// filha aqui?"). Omitido/null mantém o escopo GLOBAL por repo — que é o
// comportamento legado e o mais ESTRITO, usado quando a identidade da mãe é
// desconhecida (config global antiga, sem carimbo).
//
// Dispensado NÃO bloqueia: o dedup existe pra evitar dois agentes mutando o mesmo
// repo, e quem foi dispensado saiu do dock — recusar a delegação em nome de um
// card que o usuário não vê deixa a MCP tool respondendo "já existe um handoff
// ativo aqui" sobre algo que ele não tem como achar, abrir nem encerrar. Dispensar
// só é permitido sem filha viva (e markRunning limpa o carimbo ao adquirir uma),
// então nenhum handoff com PTY viva escapa por esta cláusula.
export function findActiveByTarget(
  targetRepoId: string,
  motherSessionId?: string | null,
): Handoff | null {
  const active =
    "h.dismissed_at IS NULL AND h.status IN ('pending','approved','running','needs_input')"
  const db = getDb()
  const row = (
    motherSessionId
      ? db
          .prepare(
            `${SELECT_HANDOFF} WHERE h.target_repo_id = ? AND h.mother_session_id = ? AND ${active} ORDER BY h.created_at DESC LIMIT 1`,
          )
          .get(targetRepoId, motherSessionId)
      : db
          .prepare(
            `${SELECT_HANDOFF} WHERE h.target_repo_id = ? AND ${active} ORDER BY h.created_at DESC LIMIT 1`,
          )
          .get(targetRepoId)
  ) as HandoffRow | undefined
  return row ? toEntity(row) : null
}
