// Do que a sessão se trata e onde ela parou — a memória de trabalho do mapa.
//
// Propósito, por precedência: sessions.purpose (edição do usuário ou da própria
// sessão via MCP) > tarefa do handoff (filha) > 1º prompt humano do transcript >
// null. Só o 1º nível é gravado; os outros dois são derivados a cada leitura.
//
// "Onde parei" é sob demanda (botão Resumir): claude -p só-texto sobre o último
// pedido do usuário + o que o agente respondeu depois. Nunca em massa — custo.
import { openSync, readSync, closeSync, readFileSync, fstatSync } from 'node:fs'
import type { ChatMessage } from '../../../shared/types/chat'
import { isAgentAskEnvelope } from '../../../shared/agent-ask'
import { isHandoffWakeEnvelope } from '../../../shared/handoff-wake-envelope'
import { isHandoffAnswerEnvelope } from '../../../shared/handoff-answer-envelope'
import { parseChatMessages } from './chat-transcript'
import { findTranscriptPath } from './transcript-path'
import { transcriptIndex } from './transcript-index'
import { runClaude, TEXT_ONLY_CLAUDE_ARGS, type RunResult } from './claude-cli'
import { stripCodeFence } from './feature-digest'

export const PURPOSE_MAX_CHARS = 120

export type PurposeSource = 'user' | 'handoff' | 'transcript'

export interface ResolvedPurpose {
  text: string
  source: PurposeSource
}

function oneLine(text: string, max = PURPOSE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

export function resolvePurpose(input: {
  userPurpose: string | null
  handoffTask: string | null
  firstPrompt: string | null
}): ResolvedPurpose | null {
  const user = input.userPurpose?.trim()
  if (user) return { text: user, source: 'user' }
  const task = input.handoffTask?.trim()
  if (task) return { text: oneLine(task), source: 'handoff' }
  const first = input.firstPrompt?.trim()
  if (first) return { text: first, source: 'transcript' }
  return null
}

// Prompts que a máquina digitou em nome do humano: o kickoff da filha e o do
// bastão. Não dizem do que a sessão se trata (a tarefa do handoff diz).
const KICKOFF_RE = /^Comece a tarefa do handoff descrita no seu contexto de sistema/
const BATON_KICKOFF_RE = /^Você está assumindo o trabalho de uma sessão anterior cujo contexto encheu\./
// O bastão pode carregar a instrução do humano: essa sim diz do que se trata.
const BATON_INSTRUCTION_RE =
  /Instrução do humano para este começo: ([\s\S]*?)(?= Você assumiu o handoff| Seu endereço de peer|$)/
// Colagem grande: o que importa é o pedido escrito em volta dela. Sem a tag de
// fechamento (cortada no head), some só a de abertura.
const PASTED_RE = /<pasted_content\b[^>]*>(?:[\s\S]*?<\/pasted_content>)?|<\/pasted_content>/g
const LINEAR_RE =
  /https?:\/\/linear\.app\/[^/\s]+\/issue\/([a-z][a-z0-9]*-\d+)(?:\/([a-z0-9-]+))?\S*/gi
// Link do Slack sozinho não diz nada: some, e se não sobrar texto vale o próximo prompt.
const SLACK_RE = /https?:\/\/[a-z0-9-]+\.slack\.com\/\S*/gi
const MIN_PROMPT_CHARS = 3

// O prompt como ele serve pra identificar a sessão, ou null se não serve.
export function cleanPrompt(raw: string): string | null {
  let text = raw.trim()
  if (
    KICKOFF_RE.test(text) ||
    isAgentAskEnvelope(text) ||
    isHandoffWakeEnvelope(text) ||
    isHandoffAnswerEnvelope(text)
  )
    return null
  if (BATON_KICKOFF_RE.test(text)) {
    const instruction = BATON_INSTRUCTION_RE.exec(text)?.[1]?.trim()
    if (!instruction) return null
    text = instruction
  }
  const cleaned = text
    .replace(PASTED_RE, ' ')
    .replace(LINEAR_RE, (_m, key: string, slug?: string) =>
      slug ? `${key.toUpperCase()} · ${slug.replace(/-+/g, ' ').trim()}` : key.toUpperCase(),
    )
    .replace(SLACK_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length >= MIN_PROMPT_CHARS ? cleaned : null
}

// O 1º prompt do digest que serve pra identificar o trabalho (pula kickoff da
// filha/bastão e limpa colagem crua).
export function firstCleanPrompt(prompts: readonly string[]): string | null {
  for (const p of prompts) {
    const text = cleanPrompt(p)
    if (text) return text
  }
  return null
}

// Objetivos antigos foram gravados do 1º prompt cru. Só mexe no que a máquina
// escreveu (kickoff, colagem); o texto que o humano digitou passa intacto.
export function sanitizeObjective(objective: string | null): string | null {
  if (!objective) return objective
  const text = objective.trim()
  const machine =
    KICKOFF_RE.test(text) || BATON_KICKOFF_RE.test(text) || /<\/?pasted_content\b/.test(text)
  return machine ? cleanPrompt(text) : objective
}

// O parser é fail-safe: só string sem marker de comando/meta/caveat vira 'user'.
export function firstUserPrompt(messages: ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.kind !== 'user') continue
    const text = cleanPrompt(m.text)
    if (text) return oneLine(text)
  }
  return null
}

export function lastUserPrompt(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind !== 'user') continue
    const text = cleanPrompt(m.text)
    if (text) return oneLine(text)
  }
  return null
}

// O 1º prompt mora no começo do JSONL; ler o arquivo inteiro a cada rebuild do
// grafo (que roda a cada ~300ms com sessão ativa) seria caro à toa.
const HEAD_BYTES = 256 * 1024
// Sem transcript ou sem prompt humano: a grande maioria é sessão encerrada que
// nunca vai ganhar um, então o miss dela vale 10 min. Sessão viva ainda pode
// ganhar o 1º prompt a qualquer momento: o miss dela vale 30s, e cada releitura
// (um lookup no índice) é o que agenda a varredura que acha o transcript novo.
// Quando o índice acha, onGrow limpa o miss na hora.
export const NEGATIVE_TTL_MS = 10 * 60_000
export const LIVE_RETRY_MS = 30_000

// Positivo é permanente: o 1º prompt de uma sessão não muda.
const found = new Map<string, string>()
const missed = new Map<string, number>()

transcriptIndex.onGrow((ids) => {
  for (const id of ids) missed.delete(id)
})

function readHead(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function readFirstPrompt(
  ccSessionId: string,
  live = false,
  lookup: (ccSessionId: string) => string | null = (id) => transcriptIndex.lookup(id),
  want: (ccSessionId: string) => void = (id) => transcriptIndex.want(id),
): string | null {
  const hit = found.get(ccSessionId)
  if (hit) return hit
  const now = Date.now()
  const missedAt = missed.get(ccSessionId)
  const ttl = live ? LIVE_RETRY_MS : NEGATIVE_TTL_MS
  if (missedAt !== undefined && now - missedAt < ttl) return null

  const path = lookup(ccSessionId)
  if (!path && live) want(ccSessionId)
  let prompt: string | null = null
  if (path) {
    try {
      prompt = firstUserPrompt(parseChatMessages(readHead(path)))
    } catch (err) {
      console.warn(`[session-purpose] falha ao ler o transcript de ${ccSessionId}:`, err)
    }
  }
  if (prompt) {
    found.set(ccSessionId, prompt)
    missed.delete(ccSessionId)
  } else {
    missed.set(ccSessionId, now)
  }
  return prompt
}

export function forgetFirstPrompt(ccSessionId: string): void {
  found.delete(ccSessionId)
  missed.delete(ccSessionId)
  lastSeen.delete(ccSessionId)
}

// ---- Última mensagem (fallback barato do "Onde parei") ----

const TAIL_BYTES = 128 * 1024
// Encerrada não ganha mensagem nova: lida uma vez. Viva: relida no máximo a cada 30s.
const lastSeen = new Map<string, { text: string | null; at: number; final: boolean }>()

function readTail(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    const n = readSync(fd, buf, 0, buf.length, start)
    // A 1ª linha do recorte quase sempre vem cortada: o parser a descarta como JSON inválido.
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function readLastPrompt(
  ccSessionId: string,
  live = false,
  lookup: (ccSessionId: string) => string | null = (id) => transcriptIndex.lookup(id),
): string | null {
  const now = Date.now()
  const hit = lastSeen.get(ccSessionId)
  if (hit && (hit.final || now - hit.at < LIVE_RETRY_MS)) return hit.text
  const path = lookup(ccSessionId)
  let text: string | null = null
  if (path) {
    try {
      text = lastUserPrompt(parseChatMessages(readTail(path)))
    } catch (err) {
      console.warn(`[session-purpose] falha ao ler o fim do transcript de ${ccSessionId}:`, err)
    }
  }
  // Sem transcript ainda: não congela, o índice pode achá-lo depois.
  lastSeen.set(ccSessionId, { text, at: now, final: !live && !!path })
  return text
}

// ---- Onde parei ----

const EXCERPT_MAX_CHARS = 6000
const SUMMARY_TIMEOUT_MS = 60_000
const SUMMARY_MODEL = 'haiku'

export const WHERE_LEFT_OFF_INSTRUCTION = `Você ajuda um engenheiro brasileiro a lembrar onde parou numa sessão de um agente de programação (Claude).

Regras:
- 1 a 2 frases curtas em português;
- diga em que ponto o trabalho está AGORA e o próximo passo, se houver;
- se o agente espera algo do usuário (decisão, resposta, aprovação), diga isso;
- NÃO invente nada que não esteja no texto;
- responda SÓ com o resumo, sem preâmbulo nem cerca de código.

Trecho da sessão:
`

// Último pedido humano + tudo que o agente escreveu depois (texto, não tools).
export function whereLeftOffExcerpt(messages: ChatMessage[]): string | null {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'user') {
      lastUser = i
      break
    }
  }
  const parts: string[] = []
  const user = messages[lastUser]
  if (user?.kind === 'user') parts.push(`Usuário: ${user.text.trim()}`)
  for (const m of messages.slice(lastUser + 1)) {
    if (m.kind === 'assistant' && m.text.trim()) parts.push(`Claude: ${m.text.trim()}`)
  }
  const text = parts.join('\n\n')
  if (!text) return null
  return text.length <= EXCERPT_MAX_CHARS ? text : `…${text.slice(-EXCERPT_MAX_CHARS)}`
}

export type WhereLeftOffResult = { ok: true; summary: string } | { ok: false; error: string }

type Runner = (args: string[], opts: { timeoutMs: number }) => Promise<RunResult>

const inFlight = new Set<string>()

export async function summarizeWhereLeftOff(
  ccSessionId: string,
  run: Runner = runClaude,
): Promise<WhereLeftOffResult> {
  if (inFlight.has(ccSessionId))
    return { ok: false, error: 'Um resumo desta sessão já está em andamento.' }
  const path = findTranscriptPath(ccSessionId)
  if (!path) return { ok: false, error: 'A sessão ainda não tem transcript.' }
  inFlight.add(ccSessionId)
  try {
    let excerpt: string | null
    try {
      excerpt = whereLeftOffExcerpt(parseChatMessages(readFileSync(path, 'utf8')))
    } catch {
      return { ok: false, error: 'Falha ao ler o transcript da sessão.' }
    }
    if (!excerpt) return { ok: false, error: 'Ainda não há conversa para resumir.' }
    const result = await run(
      [
        '-p',
        WHERE_LEFT_OFF_INSTRUCTION + excerpt,
        '--output-format',
        'text',
        '--model',
        SUMMARY_MODEL,
        ...TEXT_ONLY_CLAUDE_ARGS,
      ],
      { timeoutMs: SUMMARY_TIMEOUT_MS },
    ).catch(() => null)
    if (!result || result.code !== 0) return { ok: false, error: 'O resumidor (claude) falhou.' }
    const summary = stripCodeFence(result.stdout).trim()
    if (!summary) return { ok: false, error: 'O resumidor devolveu um resumo vazio.' }
    return { ok: true, summary }
  } finally {
    inFlight.delete(ccSessionId)
  }
}
