import type Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { writeDurably } from './durable-write'
import { findTranscriptPath } from './transcript-path'

// Persistência da PromptQueue no app.db (tabela prompt_queue_items, migration 062).
// Toda escrita é FULL: um 'queued' respondido ao chamador e um 'delivering' antes
// do write no PTY precisam sobreviver a kill -9 E a queda de energia.

export type PersistedState = 'queued' | 'delivering' | 'uncertain'

export interface PersistedPrompt {
  id: string
  sessionId: string
  ccSessionId: string | null
  text: string
  fromSessionId: string | null
  bypassAttention: boolean
  state: PersistedState
  createdAt: number
  deliveringAt: number | null
}

export interface PromptQueueStore {
  insert(item: PersistedPrompt): void
  // ccSessionId: a conversa em que a mensagem entra de fato (o boot confere nela).
  markDelivering(id: string, at: number, ccSessionId: string | null): void
  setState(id: string, state: PersistedState): void
  updateText(id: string, text: string): void
  rebind(id: string, sessionId: string): void
  remove(id: string): void
  loadAll(): PersistedPrompt[]
  ccSessionOf(sessionId: string): string | null
}

interface Row {
  id: string
  session_id: string
  cc_session_id: string | null
  text: string
  from_session_id: string | null
  bypass_attention: number
  state: PersistedState
  created_at: number
  delivering_at: number | null
}

// getDb é lazy: a fila nasce no import do módulo, antes de o app abrir o banco.
// Toda escrita que falha LANÇA (e conta): quem chama decide — a fila não entrega
// sem o registro durável e retenta (ver PromptQueue.persist).
let persistFailures = 0

export function promptQueuePersistFailures(): number {
  return persistFailures
}

export function createPromptQueueStore(db: () => Database.Database): PromptQueueStore {
  const run = (sql: string, ...args: unknown[]): void => {
    try {
      writeDurably(db(), () => {
        db()
          .prepare(sql)
          .run(...args)
      })
    } catch (err) {
      persistFailures += 1
      throw err
    }
  }
  return {
    insert: (i) =>
      run(
        `INSERT INTO prompt_queue_items
           (id, session_id, cc_session_id, text, from_session_id, bypass_attention, state, created_at, delivering_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        i.id,
        i.sessionId,
        i.ccSessionId,
        i.text,
        i.fromSessionId,
        i.bypassAttention ? 1 : 0,
        i.state,
        i.createdAt,
        i.deliveringAt,
      ),
    markDelivering: (id, at, cc) =>
      run(
        `UPDATE prompt_queue_items SET state = 'delivering', delivering_at = ?,
           cc_session_id = COALESCE(?, cc_session_id) WHERE id = ?`,
        at,
        cc,
        id,
      ),
    setState: (id, state) => run('UPDATE prompt_queue_items SET state = ? WHERE id = ?', state, id),
    updateText: (id, text) => run('UPDATE prompt_queue_items SET text = ? WHERE id = ?', text, id),
    rebind: (id, sessionId) =>
      run('UPDATE prompt_queue_items SET session_id = ? WHERE id = ?', sessionId, id),
    remove: (id) => run('DELETE FROM prompt_queue_items WHERE id = ?', id),
    loadAll: () =>
      (
        db()
          .prepare('SELECT * FROM prompt_queue_items ORDER BY created_at ASC, rowid ASC')
          .all() as Row[]
      ).map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        ccSessionId: r.cc_session_id,
        text: r.text,
        fromSessionId: r.from_session_id,
        bypassAttention: r.bypass_attention === 1,
        state: r.state,
        createdAt: r.created_at,
        deliveringAt: r.delivering_at,
      })),
    ccSessionOf: (sessionId) => {
      const row = db().prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(sessionId) as
        { cc_session_id: string | null } | undefined
      return row?.cc_session_id ?? null
    },
  }
}

// ---- prova de entrega pelo transcript ----

// 'found' = a mensagem entrou na conversa; 'absent' = o transcript existe e
// nenhuma mensagem do usuário depois do write parece com ela; 'unknown' = sem
// transcript, ou algo parecido mas não igual (formatação divergiu).
export type TranscriptVerdict = 'found' | 'absent' | 'unknown'

// Folga de relógio entre o delivering_at (main) e o timestamp que o claude grava.
const CLOCK_SLACK_MS = 2_000
const PREFIX_CHARS = 120

const exact = (s: string) => s.replace(/\r\n?/g, '\n').trim()
const loose = (s: string) => s.replace(/\s+/g, ' ').trim()

const tag = (s: string, name: string): string | null =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1] ?? null

// Formas alternativas que o claude grava para o que foi digitado: '/cmd args'
// vira <command-name>/cmd</command-name>…<command-args>args</command-args> (com
// ou sem a barra, skill com <command-message> antes), e '!cmd' vira
// <bash-input>cmd</bash-input>. Volta ao texto digitado para comparar.
function typedForm(content: string): string {
  const name = tag(content, 'command-name')
  if (name != null) {
    const cmd = name.trim().startsWith('/') ? name.trim() : `/${name.trim()}`
    const args = tag(content, 'command-args')?.trim()
    return args ? `${cmd} ${args}` : cmd
  }
  const bash = tag(content, 'bash-input')
  if (bash != null) return `!${bash.trim()}`
  return content
}

// O texto que a fila escreveu, na mesma forma de typedForm ('! cmd' = '!cmd').
function sentForm(text: string): string {
  const t = text.trim()
  return t.startsWith('!') ? `!${t.slice(1).trim()}` : t
}

interface UserPrompt {
  text: string
  // queued_command: o claude registra a mensagem que chegou com ele trabalhando —
  // é a fila entregando, não alguém digitando o mesmo texto.
  queued: boolean
}

// O que o usuário (ou o paste) mandou: a linha 'user' com texto, ou o
// queued_command que o claude grava quando a mensagem chega com ele trabalhando.
// tool_result e isMeta (comandos/skills) não são mensagem digitada.
function userPrompt(obj: Record<string, unknown>): UserPrompt | null {
  if (obj.type === 'attachment') {
    const a = obj.attachment as { type?: unknown; prompt?: unknown } | undefined
    return a?.type === 'queued_command' && typeof a.prompt === 'string'
      ? { text: typedForm(a.prompt), queued: true }
      : null
  }
  if (obj.type !== 'user' || obj.isMeta === true) return null
  const content = (obj.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return { text: typedForm(content), queued: false }
  if (!Array.isArray(content)) return null
  const texts = content
    .filter(
      (c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
  return texts.length > 0 ? { text: typedForm(texts.join('\n')), queued: false } : null
}

// Prova de entrega: o veredito e se a conversa já andou depois da mensagem (uma
// linha do assistant gravada depois dela). Só o 'answered' sobrevive a uma queda
// de energia com mais confiança: o claude não faz fsync do JSONL.
export interface TranscriptProof {
  verdict: TranscriptVerdict
  answered: boolean
}

export function transcriptProof(
  jsonl: string | null,
  text: string,
  since: number,
): TranscriptProof {
  if (jsonl == null) return { verdict: 'unknown', answered: false }
  const want = exact(sentForm(text))
  const wantLoose = loose(sentForm(text))
  const wantPrefix = wantLoose.slice(0, PREFIX_CHARS)
  let similar = false
  let found = false
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Linha cortada no meio (o claude morreu escrevendo): pode ser a nossa.
      if (!found && line.includes(wantPrefix.slice(0, 40))) similar = true
      continue
    }
    if (found) {
      if (obj.type === 'assistant') return { verdict: 'found', answered: true }
      continue
    }
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
    if (Number.isFinite(ts) && ts < since - CLOCK_SLACK_MS) continue
    const prompt = userPrompt(obj)
    if (prompt == null) continue
    const got = prompt.text
    if (exact(got) === want) {
      // Depois do delivering_at = prova. Na folga de relógio (antes dele) ou sem
      // timestamp, texto igual pode ser a mensagem anterior idêntica ('ok', 'ok'):
      // só vale com o queued_command; sem ele é ambíguo — 'unknown' (visível).
      if ((Number.isFinite(ts) && ts >= since) || prompt.queued) found = true
      else similar = true
      continue
    }
    const gotLoose = loose(got)
    if (
      gotLoose === wantLoose ||
      gotLoose.includes(wantPrefix) ||
      wantLoose.includes(gotLoose.slice(0, PREFIX_CHARS))
    ) {
      similar = true
    }
  }
  if (found) return { verdict: 'found', answered: false }
  return { verdict: similar ? 'unknown' : 'absent', answered: false }
}

export function transcriptVerdict(
  jsonl: string | null,
  text: string,
  since: number,
): TranscriptVerdict {
  return transcriptProof(jsonl, text, since).verdict
}

export function deliveryProof(
  ccSessionId: string | null,
  text: string,
  since: number,
): TranscriptProof {
  if (!ccSessionId) return { verdict: 'unknown', answered: false }
  const path = findTranscriptPath(ccSessionId)
  if (!path) return { verdict: 'unknown', answered: false }
  try {
    return transcriptProof(readFileSync(path, 'utf8'), text, since)
  } catch {
    return { verdict: 'unknown', answered: false }
  }
}
