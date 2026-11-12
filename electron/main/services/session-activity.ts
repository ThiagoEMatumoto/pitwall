import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  readdirSync,
  readFileSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  open as openCb,
  fstat as fstatCb,
  read as readCb,
  close as closeCb,
} from 'node:fs'
import { stat as statAsync } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import chokidar, { FSWatcher } from 'chokidar'
import type { SessionActivity, GlobalActivityBatch } from '../../../shared/types/ipc'
import { notifyUsageConsumption } from './usage-monitor'
import { getNotifPrefs, getMainWindow, getRendererFocusedSession, notify } from './notifications'
import { getByChildSession, isActiveCrewChild } from './handoff-store'
import { broadcast } from './notify'
import { perfCount, perfTime } from './perf-probe'
import { unregisteredPtyStatus } from './unregistered-pty-status'
import { tuiMenuWatch } from './tui-menu-watch'
import {
  deriveAttentionReason,
  handoffAsking,
  type AttentionReason,
} from '../../../shared/tui/attention-reason'
import { deriveSubagentActivity } from './subagent-activity'
import { ptyManager } from './pty-manager'
import { derivePtyStatus } from './providers/pty-status'
import { PROJECTS_ROOT, findTranscriptPath } from './transcript-path'
import { readSubagentMetas } from './subagent-turns'
import { scanTranscriptForSendMessage } from './session-link-pulse'
import { getDb } from './db'
import { latestSpawnArgs } from './spawn-args'

// Re-export: findTranscriptPath/PROJECTS_ROOT moraram aqui e são importados daqui
// por meio mundo (metrics-service, feature-memory, chat-transcript-service, ipc).
// A implementação saiu pra transcript-path.ts (ver o porquê lá); o endereço fica.
export { PROJECTS_ROOT, findTranscriptPath }

const SESSIONS_ROOT = join(homedir(), '.claude', 'sessions')

// Borda working → waiting/idle de uma sessão viva (fim de turno). Hook injetável
// (padrão setSyncMutationHook do notify.ts) pra não importar voice-summary daqui —
// evitaria ciclo via chat-transcript-service, que importa este módulo. Default
// no-op até o boot registrar o consumidor real.
type TurnEndedHook = (ccSessionId: string) => void
let turnEndedHook: TurnEndedHook = () => {}

export function setTurnEndedHook(fn: TurnEndedHook): void {
  turnEndedHook = fn
}

// Segundo consumidor da mesma borda: a fila de prompts "quando terminar"
// (prompt-queue.ts). Hook separado pra não disputar o slot do resumo por voz.
let promptQueueTurnHook: TurnEndedHook = () => {}

export function setPromptQueueTurnHook(fn: TurnEndedHook): void {
  promptQueueTurnHook = fn
}

// Consumidores extras da borda de fim de turno (ex.: relançar como mãe quando a
// filha promovida terminar o turno). Set: vários podem ouvir sem disputar slot.
const turnEndedListeners = new Set<TurnEndedHook>()

export function onTurnEnded(fn: TurnEndedHook): () => void {
  turnEndedListeners.add(fn)
  return () => {
    turnEndedListeners.delete(fn)
  }
}

// Sessão que sumiu do índice (PID morreu / arquivo removido) — sinal de
// limpeza pra quem guarda estado por ccSessionId (ex.: dedupe do resumo por
// voz). Mesmo padrão injetável do turnEndedHook.
type SessionGoneHook = (ccSessionId: string) => void
let sessionGoneHook: SessionGoneHook = () => {}

export function setSessionGoneHook(fn: SessionGoneHook): void {
  sessionGoneHook = fn
}
const TAIL_BYTES = 64 * 1024
const DEBOUNCE_MS = 250
// Cadência do status por PTY (provider sem índice nativo): a janela de
// estabilidade é de 2s, então meio segundo basta pra borda não atrasar.
const PTY_STATUS_TICK_MS = 500
export const MAX_TEXT = 200

// Fonte primária de status/name/updatedAt: ~/.claude/sessions/<pid>.json (um por
// processo, atualizado ao vivo pelo Claude Code). É leve (~300B) e preciso.
interface CcSessionFile {
  pid?: number
  sessionId?: string
  cwd?: string
  status?: 'busy' | 'idle' | 'waiting' | 'shell' | null
  name?: string | null
  updatedAt?: number
  // Epoch ms de quando o processo abriu a sessão (2.1.29x grava junto do pid).
  startedAt?: number
  // Campo 22 de /proc/<pid>/stat (starttime, em ticks) do processo que escreveu.
  procStart?: string
  // Quando o status atual começou (epoch ms) — o updatedAt muda por outros campos.
  statusUpdatedAt?: number
}

export interface IndexEntry {
  pid: number
  procStart: string | null
  status: CcSessionFile['status']
  name: string | null
  cwd: string | null
  updatedAt: number | null
  statusUpdatedAt: number | null
  startedAt: number | null
}

// Lê todos os ~/.claude/sessions/<pid>.json e indexa por sessionId. Compartilhado
// entre o watcher ao vivo e o list-by-repo (ambos precisam do estado dos PIDs).
export function buildSessionsFileIndex(): Map<string, IndexEntry> {
  const next = new Map<string, IndexEntry>()
  let files: string[]
  try {
    files = readdirSync(SESSIONS_ROOT).filter((f) => f.endsWith('.json'))
  } catch {
    return next
  }
  for (const file of files) {
    let data: CcSessionFile
    try {
      data = JSON.parse(readFileSync(join(SESSIONS_ROOT, file), 'utf8')) as CcSessionFile
    } catch {
      continue // arquivo inválido ou em escrita parcial.
    }
    if (!data.sessionId || typeof data.pid !== 'number') continue
    next.set(data.sessionId, {
      pid: data.pid,
      procStart: typeof data.procStart === 'string' ? data.procStart : null,
      status: data.status ?? null,
      name: data.name ?? null,
      cwd: data.cwd ?? null,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : null,
      statusUpdatedAt: typeof data.statusUpdatedAt === 'number' ? data.statusUpdatedAt : null,
      startedAt: typeof data.startedAt === 'number' ? data.startedAt : null,
    })
  }
  return next
}

// kill(pid, 0) não envia sinal — só testa se o processo existe e é acessível.
// ESRCH = morto; EPERM = vivo mas sem permissão (raro aqui, mesmo usuário).
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Pid lido de ~/.claude/sessions/<pid>.json: o arquivo sobrevive ao processo
// (crash, kill -9) e o pid é reciclado, então kill(pid, 0) sozinho acusaria de
// "dono da conversa" um processo qualquer. Cada plataforma dá o veredito que
// consegue provar: true/false quando a evidência é definitiva, null quando não é.
// Só no null vale o atalho "o pid é de uma PTY viva nossa" — ele não pode
// desmentir um procStart/start time diferente, que é justamente o arquivo velho
// com pid reciclado caindo numa PTY recém-spawnada.
// No Windows a PTY é o shell e kill(pid, 0) aceita pid reciclado depressa: o dono
// não é verificável, conta como não-vivo e só fica o log.
export type PsProbe = (pid: number) => string | null

export interface PidLivenessDeps {
  procRoot?: string
  ps?: PsProbe
}

type LivenessEntry = Pick<IndexEntry, 'pid' | 'procStart'> &
  Partial<Pick<IndexEntry, 'startedAt' | 'updatedAt'>>

export function isSessionPidAlive(entry: LivenessEntry, deps: PidLivenessDeps = {}): boolean {
  const verdict =
    process.platform === 'linux'
      ? linuxVerdict(entry, deps.procRoot ?? '/proc')
      : process.platform === 'darwin'
        ? darwinVerdict(entry, deps.ps ?? runPs)
        : null
  if (verdict !== null) return verdict
  if (ptyManager.sessionIdByPid(entry.pid) !== null) return true
  if (process.platform === 'win32' && isPidAlive(entry.pid)) {
    const event = { event: 'conversation_holder_unverified', pid: entry.pid }
    console.warn(JSON.stringify({ ...event, platform: process.platform }))
  }
  return false
}

// Vivo = /proc/<pid> existe e o start time bate com o procStart que o Claude Code
// gravou. Arquivo sem procStart (versão antiga): cmdline de um claude prova; outro
// cmdline não prova nada.
function linuxVerdict(entry: LivenessEntry, procRoot: string): boolean | null {
  let stat: string
  try {
    stat = readFileSync(join(procRoot, String(entry.pid), 'stat'), 'utf8')
  } catch {
    return false
  }
  if (entry.procStart) return procStartOf(stat) === entry.procStart
  try {
    return readFileSync(join(procRoot, String(entry.pid), 'cmdline'), 'utf8').includes('claude')
      ? true
      : null
  } catch {
    return null
  }
}

// Sem /proc: o processo tem de ter nascido antes de o arquivo dizer que a sessão
// abriu (startedAt; updatedAt em arquivo sem ele). Nascido depois = pid reciclado.
function darwinVerdict(entry: LivenessEntry, ps: PsProbe): boolean | null {
  if (!isPidAlive(entry.pid)) return false
  const parsed = parsePsLstartComm(ps(entry.pid))
  const ref = entry.startedAt ?? entry.updatedAt ?? null
  if (!parsed || ref === null) return null
  if (parsed.startMs > ref) return false
  return parsed.comm.includes('claude') ? true : null
}

// LC_ALL=C: o lstart sai em inglês ("Sat Oct 10 17:26:16 2026"); no locale do
// usuário viria "sáb out 10". lstart primeiro porque o comm pode ter espaço.
function runPs(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Sat Oct  1 17:26:16 2026 /Applications/x/claude" → start em ms (hora local,
// a mesma do ps) e o comm. Resolução de segundo: trunca para baixo, nunca passa
// do start real.
export function parsePsLstartComm(out: string | null): { startMs: number; comm: string } | null {
  const tokens = out?.trim().split(/\s+/) ?? []
  if (tokens.length < 6) return null
  const [, mon, day, time, year] = tokens
  const month = MONTHS.indexOf(mon)
  const hms = time.split(':').map(Number)
  const d = Number(day)
  const y = Number(year)
  if (month < 0 || hms.length !== 3 || [...hms, d, y].some((n) => !Number.isInteger(n))) return null
  const startMs = new Date(y, month, d, hms[0], hms[1], hms[2]).getTime()
  return { startMs, comm: tokens.slice(5).join(' ') }
}

// O comm (campo 2) vem entre parênteses e pode ter espaço: conta a partir do
// último ')'. O que sobra começa no campo 3, então o 22 é o índice 19.
function procStartOf(stat: string): string | null {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
}

export function mapStatus(cc: CcSessionFile['status']): SessionActivity['status'] {
  switch (cc) {
    case 'busy':
    case 'shell':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'idle':
      return 'idle'
    default:
      // null ou ausente → sessão iniciando, ainda sem status reportado.
      return 'starting'
  }
}

// Lê só os últimos TAIL_BYTES do arquivo: durante uma sessão longa o JSONL chega a
// milhares de linhas e reparsear tudo a cada mudança seria custoso. A primeira linha
// do tail pode estar partida (cortada no meio) ou em escrita parcial — o parser ignora
// linhas que não desserializam.
export function readTail(path: string): Promise<string> {
  return new Promise((resolve) => {
    openCb(path, 'r', (errOpen, fd) => {
      if (errOpen) return resolve('')
      fstatCb(fd, (errStat, stat) => {
        if (errStat) {
          closeCb(fd, () => {})
          return resolve('')
        }
        const size = stat.size
        const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0
        const length = size - start
        if (length <= 0) {
          closeCb(fd, () => {})
          return resolve('')
        }
        const buf = Buffer.alloc(length)
        readCb(fd, buf, 0, length, start, (errRead, bytesRead) => {
          closeCb(fd, () => {})
          if (errRead) return resolve('')
          resolve(buf.toString('utf8', 0, bytesRead))
        })
      })
    })
  })
}

// Título persistido no JSONL: custom-title (definido pelo usuário) tem prioridade
// sobre ai-title (gerado). Lê o arquivo inteiro porque esses eventos podem estar em
// qualquer posição; usado só no list-by-repo (poucas sessões por vez).
export function readTranscriptTitle(path: string): string | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let aiTitle: string | null = null
  let customTitle: string | null = null
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as { type?: string; aiTitle?: string; customTitle?: string }
      if (obj.type === 'custom-title' && obj.customTitle) customTitle = obj.customTitle
      else if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle
    } catch {
      // linha inválida — ignorar.
    }
  }
  return customTitle ?? aiTitle
}

interface ContentItem {
  type?: string
  text?: string
}

interface TranscriptLine {
  type?: string
  timestamp?: string
  aiTitle?: string
  message?: {
    role?: string
    model?: string
    content?: ContentItem[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

interface TranscriptEnrichment {
  title: string | null
  lastText: string | null
  tokens: SessionActivity['tokens']
  model: string | null
  // Epoch ms da última resposta (a que deu o model); null sem resposta no tail.
  modelAt: number | null
}

// Enriquecimento secundário: lastText, tokens e aiTitle (fallback do name).
// Status e updatedAt vêm da fonte primária (sessions/<pid>.json).
export function deriveEnrichment(tail: string): TranscriptEnrichment {
  const lines = tail.split('\n')
  const parsed: TranscriptLine[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      parsed.push(JSON.parse(trimmed) as TranscriptLine)
    } catch {
      // Linha partida (início do tail) ou escrita parcial — ignorar.
    }
  }

  let title: string | null = null
  let lastText: string | null = null
  let tokens: SessionActivity['tokens']

  for (const l of parsed) {
    if (l.type === 'ai-title' && l.aiTitle) title = l.aiTitle
  }

  const lastAssistant = [...parsed].reverse().find((l) => l.type === 'assistant')
  if (lastAssistant?.message?.content) {
    const textItem = [...lastAssistant.message.content]
      .reverse()
      .find((c) => c.type === 'text' && typeof c.text === 'string')
    if (textItem?.text) lastText = textItem.text.slice(0, MAX_TEXT)
    const usage = lastAssistant.message.usage
    if (usage) {
      tokens = {
        output: usage.output_tokens ?? 0,
        context: (usage.cache_read_input_tokens ?? 0) + (usage.input_tokens ?? 0),
      }
    }
  }

  // Modelo em uso: a última msg assistant carrega message.model (mesmo formato
  // que o metrics-service lê). Null até a primeira resposta do assistant no tail.
  const at = lastAssistant?.timestamp ? Date.parse(lastAssistant.timestamp) : NaN
  return {
    title,
    lastText,
    tokens,
    model: lastAssistant?.message?.model ?? null,
    modelAt: Number.isFinite(at) ? at : null,
  }
}

// O modelo do processo que roda AGORA. A última resposta do transcript pode ser
// de um processo anterior da conversa (resume/relance com outro --model): até a
// primeira resposta nova, vale o --model do spawn. Resposta posterior ao início do
// processo vence (cobre o /model no meio da sessão).
export function currentModel(
  enrichment: Pick<TranscriptEnrichment, 'model' | 'modelAt'>,
  spawn: { model: string | null; startedAt: number | null } | null,
): string | null {
  if (!spawn?.model) return enrichment.model
  const stale =
    enrichment.modelAt == null ||
    (spawn.startedAt != null && enrichment.modelAt < spawn.startedAt)
  return stale ? spawn.model : enrichment.model
}

// A PTY herda o env do app: sem --model, o claude usa o ANTHROPIC_MODEL (mesma
// precedência da CLI).
export function spawnModel(
  argsModel: string | null,
  env: Partial<Record<string, string>>,
): string | null {
  return argsModel ?? env.ANTHROPIC_MODEL ?? null
}

function spawnModelOf(ccSessionId: string): string | null {
  return spawnModel(latestSpawnArgs(getDb(), ccSessionId)?.model ?? null, process.env)
}

// Versão síncrona de readTail: lê só os últimos TAIL_BYTES. Usada por consumidores
// síncronos (handlers MCP, que retornam ToolResult sem await). Mesma semântica de
// "primeira linha do tail pode estar partida" — o parser de deriveEnrichment ignora.
export function readTailSync(path: string): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return ''
  }
  try {
    const size = fstatSync(fd).size
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0
    const length = size - start
    if (length <= 0) return ''
    const buf = Buffer.alloc(length)
    const bytesRead = readSync(fd, buf, 0, length, start)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

// Snapshot SÍNCRONO da atividade ao vivo de uma sessão por ccSessionId, reusando a
// MESMA derivação do watcher (índice de sessions/<pid>.json → status; tail do JSONL
// → lastText/tokens). É o getter que o handoff_result consome para enriquecer com o
// estado real da filha. Retorna null se a sessão não está no índice (não nasceu ou
// já encerrou e nem deixou transcript).
export interface ActivitySnapshot {
  status: SessionActivity['status']
  lastActivityAt: number | null
  lastText: string | null
  tokens: SessionActivity['tokens']
}

export function getActivityFor(ccSessionId: string): ActivitySnapshot | null {
  const index = buildSessionsFileIndex()
  const indexed = index.get(ccSessionId)
  const transcriptPath = findTranscriptPath(ccSessionId)

  let status: SessionActivity['status']
  let lastActivityAt: number | null = null
  if (!indexed) {
    // Sem arquivo de PID: ou ainda não nasceu (starting) ou já encerrou (ended,
    // se já houve transcript). Sem transcript tampouco → nada a reportar.
    if (!transcriptPath) return null
    status = 'ended'
  } else if (!isPidAlive(indexed.pid)) {
    status = 'ended'
    lastActivityAt = indexed.updatedAt
  } else {
    status = mapStatus(indexed.status)
    lastActivityAt = indexed.updatedAt
  }

  let lastText: string | null = null
  let tokens: SessionActivity['tokens']
  if (transcriptPath) {
    const tail = readTailSync(transcriptPath)
    if (tail) {
      const enrichment = deriveEnrichment(tail)
      lastText = enrichment.lastText
      tokens = enrichment.tokens
    }
  }

  return { status, lastActivityAt, lastText, tokens }
}

// Motivo da espera de uma PTY deste app (sessions.id). Nunca decide fila nem
// notificação — só descreve; qualquer dúvida devolve undefined (como antes).
export function attentionReasonForPty(
  ptyId: string,
  status: SessionActivity['status'],
): AttentionReason | undefined {
  if (!tuiMenuWatch.has(ptyId)) return undefined
  tuiMenuWatch.noteUnparsed(ptyId, status)
  const handoff = getByChildSession(ptyId)
  return deriveAttentionReason({
    status,
    scan: tuiMenuWatch.current(ptyId),
    handoffAsking: handoff ? handoffAsking(handoff) : false,
  })
}

// O índice de sessions/<pid>.json fala ccSessionId; a tela é por PTY (sessions.id).
// O cc→pty vem do próprio TuiMenuWatch (gravado no spawn): o batch global roda a
// cada tick para TODA sessão indexada, e uma query por sessão por tick não se paga.
// Relê a tela antes de derivar: o scan em cache é o da última rajada assentada e,
// com saída contínua (spinner), pode ser o prompt de antes justo na borda do status.
async function attentionReasonForCc(
  ccSessionId: string,
  status: SessionActivity['status'],
): Promise<AttentionReason | undefined> {
  const ptyId = tuiMenuWatch.ptyForCc(ccSessionId)
  if (!ptyId) return undefined
  await tuiMenuWatch.rescan(ptyId)
  return attentionReasonForPty(ptyId, status)
}

// Status de uma PTY sem índice nativo (Codex), pela estabilidade da tela. A
// chave é o sessions.id — não existe cc_session_id para essas sessões.
export function ptyStatusFor(sessionId: string): SessionActivity['status'] {
  const sample = ptyManager.getActivitySample(sessionId)
  if (!sample || !ptyManager.isRunning(sessionId)) return 'ended'
  return derivePtyStatus(sample, Date.now())
}

interface WatchEntry {
  transcriptPath: string | null
  enrichment: TranscriptEnrichment
  // Watcher POR SESSÃO no transcript (+ dir subagents/): o dirWatcher global só
  // observa ~/.claude/sessions e pode não tickar durante um turno busy longo —
  // este garante broadcasts enquanto o JSONL cresce. null até o transcript existir.
  fileWatcher: FSWatcher | null
  fileTimer: NodeJS.Timeout | null
  // O dir subagents/ pode nascer DEPOIS do watcher (primeiro Task do turno);
  // flag pra adicioná-lo ao watcher quando aparecer, sem re-add a cada emit.
  subagentsWatched: boolean
}

const SEND_MESSAGE_POLL_MS = 2_500
// Sessão sem transcript: a varredura de ~/.claude/projects só se repete quando a
// entry dela muda (o 1º prompt muda o status) ou, se o JSONL nascer sem a entry
// mudar, depois deste intervalo.
const TRANSCRIPT_MISS_RETRY_MS = 5_000

// Última leitura do transcript de uma sessão no batch global, válida enquanto o
// arquivo tiver o mesmo mtime e o mesmo tamanho.
interface GlobalTranscript {
  path: string
  mtimeMs: number
  size: number
  tail: string
  lastText: string | null
  tokens: SessionActivity['tokens']
}

const indexEntryKey = (entry: IndexEntry): string =>
  `${entry.pid}:${entry.status}:${entry.updatedAt}`

async function statOrNull(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    return await statAsync(path)
  } catch {
    return null
  }
}

class SessionActivityService extends EventEmitter {
  // ccSessionId -> sessões assinadas pelo renderer.
  private watched = new Map<string, WatchEntry>()
  // sessionId -> dados do sessions/<pid>.json (índice por PID, lido dos arquivos).
  private index = new Map<string, IndexEntry>()
  // sessionId -> último status efetivo, pra detectar a transição busy→não-busy
  // (fim de consumo) e disparar o fetch de usage só na borda, não a cada tick.
  private lastEffectiveStatus = new Map<string, SessionActivity['status']>()
  // Modo global: a lista "Agents" assina o stream de TODAS as sessões indexadas.
  private globalWatch = false
  private dirWatcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private globalTimer: NodeJS.Timeout | null = null
  // broadcastGlobal é async e não serializado: só o batch da geração mais nova sai,
  // senão um batch velho chegando depois recoloca 'waiting' na fila do renderer.
  private globalGen = 0
  // Batch + índice do último envio: tick que não muda nenhum dos dois não
  // transmite. null = o assinante ainda não recebeu nada.
  private lastGlobalSignature: string | null = null
  private globalTranscripts = new Map<string, GlobalTranscript>()
  private globalTranscriptMisses = new Map<string, { entryKey: string; at: number }>()
  // sessions.id → último status das PTYs sem índice nativo (Codex).
  private ptyTracked = new Map<string, SessionActivity['status']>()
  private ptyTimer: NodeJS.Timeout | null = null
  // SendMessage nativo de sessão SEM pane: o dirWatcher só vê sessions/<pid>.json,
  // que fica parado o turno inteiro; sem isto, o tail só era relido no fim do
  // turno. Enquanto o modo global está ligado, as sessões busy sem watcher próprio
  // têm o mtime do JSONL conferido a cada SEND_MESSAGE_POLL_MS.
  private sendMessagePoll: NodeJS.Timeout | null = null
  private polledTranscripts = new Map<string, { path: string; mtimeMs: number }>()

  constructor() {
    super()
    // Menu apareceu/sumiu na tela sem o sessions/<pid>.json mudar (o status já
    // era waiting): re-emite o batch pra o motivo chegar ao renderer. N PTYs
    // mudando de tela juntas viram UM batch (coalesce, não reinicia o timer).
    tuiMenuWatch.on('change', () => this.scheduleGlobal())
  }

  private scheduleGlobal(): void {
    if (!this.globalWatch || this.globalTimer) return
    this.globalTimer = setTimeout(() => {
      this.globalTimer = null
      void this.broadcastGlobal()
    }, DEBOUNCE_MS)
  }

  watch(ccSessionId: string): void {
    if (this.watched.has(ccSessionId)) return
    const entry: WatchEntry = {
      transcriptPath: findTranscriptPath(ccSessionId),
      enrichment: { title: null, lastText: null, tokens: undefined, model: null, modelAt: null },
      fileWatcher: null,
      fileTimer: null,
      subagentsWatched: false,
    }
    this.watched.set(ccSessionId, entry)
    this.ensureDirWatcher()
    this.ensureFileWatcher(ccSessionId, entry)
    // Estado inicial imediato (índice já pode estar populado).
    this.rebuildIndex()
    void this.emitFor(ccSessionId)
  }

  // Sessão com pane aberto no app (o renderer faz watch ao abrir e unwatch ao
  // fechar) — é o registro mais direto do que o Pitwall exibe/gerencia.
  isWatched(ccSessionId: string): boolean {
    return this.watched.has(ccSessionId)
  }

  unwatch(ccSessionId: string): void {
    const entry = this.watched.get(ccSessionId)
    if (entry) {
      if (entry.fileTimer) clearTimeout(entry.fileTimer)
      if (entry.fileWatcher) void entry.fileWatcher.close()
      entry.fileTimer = null
      entry.fileWatcher = null
    }
    this.watched.delete(ccSessionId)
    this.maybeCloseDirWatcher()
  }

  // Watcher chokidar por sessão assinada: transcript + (quando existir) o dir
  // subagents/ irmão. Debounce próprio (mesmo DEBOUNCE_MS) chamando emitFor —
  // independente do dirWatcher de ~/.claude/sessions, que não vê o JSONL crescer.
  // Idempotente: chamado de novo só pra anexar o subagents/ quando ele nascer.
  private ensureFileWatcher(ccSessionId: string, entry: WatchEntry): void {
    if (!entry.transcriptPath) return
    if (!entry.fileWatcher) {
      const watcher = chokidar.watch(entry.transcriptPath, {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: false,
      })
      const schedule = () => {
        if (entry.fileTimer) clearTimeout(entry.fileTimer)
        entry.fileTimer = setTimeout(() => void this.emitFor(ccSessionId), DEBOUNCE_MS)
      }
      watcher.on('add', schedule)
      watcher.on('change', schedule)
      watcher.on('unlink', schedule)
      entry.fileWatcher = watcher
    }
    if (!entry.subagentsWatched) {
      const subagentsDir = join(dirname(entry.transcriptPath), ccSessionId, 'subagents')
      if (existsSync(subagentsDir)) {
        entry.fileWatcher.add(subagentsDir)
        entry.subagentsWatched = true
      }
    }
  }

  // Modo global: espelha o padrão watch/unwatch per-ccSessionId, mas observa
  // TODAS as sessões indexadas. Reusa o mesmo dirWatcher/debounce.
  watchGlobal(): void {
    // Janela recarregada assina de novo sem ter dado unwatch: ela não viu batch
    // nenhum, então o próximo sai mesmo igual ao último enviado.
    this.lastGlobalSignature = null
    if (!this.globalWatch) {
      this.globalWatch = true
      this.ensureDirWatcher()
      this.sendMessagePoll = setInterval(
        () => void this.pollBusyTranscripts(),
        SEND_MESSAGE_POLL_MS,
      )
      this.sendMessagePoll.unref?.()
    }
    // Snapshot inicial imediato (índice já pode estar populado).
    this.rebuildIndex()
    this.broadcastGlobal()
  }

  unwatchGlobal(): void {
    this.globalWatch = false
    if (this.sendMessagePoll) clearInterval(this.sendMessagePoll)
    this.sendMessagePoll = null
    this.polledTranscripts.clear()
    this.lastGlobalSignature = null
    this.globalTranscripts.clear()
    this.globalTranscriptMisses.clear()
    this.maybeCloseDirWatcher()
  }

  private async pollBusyTranscripts(): Promise<void> {
    for (const [ccSessionId, entry] of this.index) {
      if (entry.status !== 'busy' || this.watched.has(ccSessionId)) continue
      let known = this.polledTranscripts.get(ccSessionId)
      if (!known) {
        const path = findTranscriptPath(ccSessionId)
        if (!path) continue
        known = { path, mtimeMs: 0 }
        this.polledTranscripts.set(ccSessionId, known)
      }
      let mtimeMs: number
      try {
        mtimeMs = (await statAsync(known.path)).mtimeMs
      } catch {
        this.polledTranscripts.delete(ccSessionId)
        continue
      }
      if (mtimeMs === known.mtimeMs) continue
      known.mtimeMs = mtimeMs
      const tail = await readTail(known.path)
      if (tail) scanTranscriptForSendMessage(ccSessionId, tail, this.index)
    }
  }

  // Fecha o dirWatcher só quando nada mais o usa (nenhum watch per-session e
  // nenhum watch global).
  private maybeCloseDirWatcher(): void {
    if (this.watched.size > 0 || this.globalWatch) return
    if (this.dirWatcher) {
      void this.dirWatcher.close()
      this.dirWatcher = null
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  closeAll(): void {
    for (const id of [...this.watched.keys()]) this.unwatch(id)
    this.unwatchGlobal()
    for (const id of [...this.ptyTracked.keys()]) this.untrackPty(id)
  }

  // Sessão de provider sem índice nativo: o status sai da PTY (pty-status.ts),
  // amostrado num tick próprio — não há arquivo no disco cujo watcher acorde.
  trackPty(sessionId: string): void {
    if (this.ptyTracked.has(sessionId)) return
    this.ptyTracked.set(sessionId, 'starting')
    if (!this.ptyTimer) {
      this.ptyTimer = setInterval(() => this.tickPtyStatus(), PTY_STATUS_TICK_MS)
      this.ptyTimer.unref?.()
    }
  }

  untrackPty(sessionId: string): void {
    this.ptyTracked.delete(sessionId)
    if (this.ptyTracked.size === 0 && this.ptyTimer) {
      clearInterval(this.ptyTimer)
      this.ptyTimer = null
    }
  }

  isPtyTracked(sessionId: string): boolean {
    return this.ptyTracked.has(sessionId)
  }

  // Mesma borda do detectConsumption (working → idle = fim de turno), mas por
  // sessions.id: é ela que acorda a fila 'quando terminar' das sessões Codex.
  // O resumo por voz (turnEndedHook) fica de fora — lê o transcript do claude.
  private tickPtyStatus(): void {
    let changed = false
    for (const [sessionId, prev] of this.ptyTracked) {
      const current = ptyStatusFor(sessionId)
      // PTY encerrada sai do tracking aqui mesmo: o exit dela já relista o renderer.
      if (current === 'ended') {
        this.untrackPty(sessionId)
        changed = true
        continue
      }
      if (current === prev) continue
      changed = true
      this.ptyTracked.set(sessionId, current)
      if (prev === 'working' && current === 'idle') promptQueueTurnHook(sessionId)
    }
    if (changed) this.scheduleGlobal()
  }

  private ensureDirWatcher(): void {
    if (this.dirWatcher) return
    this.dirWatcher = chokidar.watch(SESSIONS_ROOT, {
      ignoreInitial: false,
      depth: 0,
      awaitWriteFinish: false,
    })
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.onIndexChanged(), DEBOUNCE_MS)
    }
    this.dirWatcher.on('add', schedule)
    this.dirWatcher.on('change', schedule)
    this.dirWatcher.on('unlink', schedule)
  }

  // Relê todos os sessions/<pid>.json e reconstrói o índice sessionId -> entry.
  private rebuildIndex(): void {
    this.index = buildSessionsFileIndex()
  }

  private onIndexChanged(): void {
    this.rebuildIndex()
    this.detectConsumption()
    for (const id of this.watched.keys()) void this.emitFor(id)
    if (this.globalWatch) this.broadcastGlobal()
  }

  // Emite o batch global com TODAS as sessões indexadas. lastText/tokens vêm do
  // tail do JSONL (mesma derivação do emitFor), relido só quando o arquivo muda.
  // O payload é sempre a lista completa: o renderer descarta ids que ainda não
  // conhece, e um delta deixaria a sessão nova sem o item dela para sempre.
  private broadcastGlobal(): Promise<void> {
    return perfTime('broadcastGlobal', () => this.emitGlobalBatch())
  }

  private async emitGlobalBatch(): Promise<void> {
    const gen = ++this.globalGen
    const index = this.index
    const batch: GlobalActivityBatch = []
    for (const [ccSessionId, entry] of index) {
      const status = this.effectiveStatus(entry)
      const transcript = await this.globalTranscript(ccSessionId, entry)
      // Com o tail em cache também: uma chamada sem destino resolvido é
      // retentada a cada tick, e o destino pode ter entrado no índice agora.
      if (transcript) scanTranscriptForSendMessage(ccSessionId, transcript.tail, index)
      batch.push({
        ccSessionId,
        status,
        lastActivityAt: entry.updatedAt,
        lastText: transcript?.lastText ?? null,
        tokens: transcript?.tokens,
        attentionReason: await attentionReasonForCc(ccSessionId, status),
      })
    }
    // PTYs sem índice nativo entram chaveadas pelo sessions.id (o mesmo valor
    // que o list-live-global devolve em ccSessionId para elas).
    for (const sessionId of this.ptyTracked.keys()) {
      batch.push({
        ccSessionId: sessionId,
        status: ptyStatusFor(sessionId),
        lastActivityAt: ptyManager.getActivitySample(sessionId)?.lastByteAt ?? null,
      })
    }
    perfCount('broadcastGlobal.sessions', batch.length)
    if (gen !== this.globalGen) return
    for (const ccSessionId of this.globalTranscripts.keys()) {
      if (!index.has(ccSessionId)) this.globalTranscripts.delete(ccSessionId)
    }
    for (const ccSessionId of this.globalTranscriptMisses.keys()) {
      if (!index.has(ccSessionId)) this.globalTranscriptMisses.delete(ccSessionId)
    }
    // O índice entra na comparação porque o grafo e a fila de atenção o releem
    // a cada batch: nome e cwd não viajam no payload, mas mudam o que eles mostram.
    const signature = JSON.stringify([batch, [...index]])
    if (signature === this.lastGlobalSignature) {
      perfCount('broadcastGlobal.skipped')
      return
    }
    broadcast('session:activity:global', batch)
    // Só depois do envio: se ele falhar, o próximo tick tenta de novo.
    this.lastGlobalSignature = signature
  }

  private async globalTranscript(
    ccSessionId: string,
    entry: IndexEntry,
  ): Promise<GlobalTranscript | null> {
    const known = this.globalTranscripts.get(ccSessionId)
    if (known) {
      const stat = await statOrNull(known.path)
      if (stat?.mtimeMs === known.mtimeMs && stat.size === known.size) return known
      if (stat) return this.readGlobalTranscript(ccSessionId, known.path, stat)
      this.globalTranscripts.delete(ccSessionId)
    }
    const path = this.findGlobalTranscriptPath(ccSessionId, entry)
    const stat = path ? await statOrNull(path) : null
    return path && stat ? this.readGlobalTranscript(ccSessionId, path, stat) : null
  }

  private findGlobalTranscriptPath(ccSessionId: string, entry: IndexEntry): string | null {
    const entryKey = indexEntryKey(entry)
    const miss = this.globalTranscriptMisses.get(ccSessionId)
    const now = Date.now()
    if (miss?.entryKey === entryKey && now - miss.at < TRANSCRIPT_MISS_RETRY_MS) return null
    const path = findTranscriptPath(ccSessionId)
    if (path) this.globalTranscriptMisses.delete(ccSessionId)
    else this.globalTranscriptMisses.set(ccSessionId, { entryKey, at: now })
    return path
  }

  // O stat vem ANTES da leitura: se o arquivo crescer no meio, o cache fica com
  // um stat velho e o próximo tick relê, em vez de guardar um tail velho como atual.
  private async readGlobalTranscript(
    ccSessionId: string,
    path: string,
    stat: { mtimeMs: number; size: number },
  ): Promise<GlobalTranscript | null> {
    perfCount('broadcastGlobal.tailReads')
    const tail = await readTail(path)
    if (!tail) return null
    const { lastText, tokens } = deriveEnrichment(tail)
    const read = { path, mtimeMs: stat.mtimeMs, size: stat.size, tail, lastText, tokens }
    this.globalTranscripts.set(ccSessionId, read)
    return read
  }

  // Status efetivo de uma entry do índice (mesma regra do emitFor, sem o
  // enriquecimento do JSONL). Sessão sem PID vivo conta como encerrada.
  private effectiveStatus(entry: IndexEntry): SessionActivity['status'] {
    return isPidAlive(entry.pid) ? mapStatus(entry.status) : 'ended'
  }

  // Uso do plano só muda quando uma sessão termina um turno. Detectamos a borda
  // working → waiting/idle/ended e notificamos o usage-monitor (que debounça e
  // respeita o MIN_INTERVAL). starting→working e outras transições não disparam.
  private detectConsumption(): void {
    let consumed = false
    for (const [sessionId, entry] of this.index) {
      const current = this.effectiveStatus(entry)
      const prev = this.lastEffectiveStatus.get(sessionId)
      if (prev === 'working' && current !== 'working') consumed = true
      // Fim de turno com a sessão ainda viva (working → waiting/idle): borda que
      // o resumo por voz consome. 'ended' fica de fora — sessão encerrada não
      // tem quem ouça o resumo.
      if (prev === 'working' && (current === 'waiting' || current === 'idle')) {
        turnEndedHook(sessionId)
        promptQueueTurnHook(sessionId)
        for (const fn of turnEndedListeners) fn(sessionId)
      }
      // "Sessão aguardando" é a borda working→waiting especificamente (não
      // qualquer não-busy). Só notifica com o app fora de foco, pra não spammar
      // quem está olhando o terminal.
      if (prev === 'working' && current === 'waiting') {
        this.notifySessionWaiting(sessionId, entry)
      }
      this.lastEffectiveStatus.set(sessionId, current)
    }
    // Sessões que sumiram do índice: trata como fim de consumo se estavam working.
    for (const [sessionId, prev] of this.lastEffectiveStatus) {
      if (this.index.has(sessionId)) continue
      if (prev === 'working') consumed = true
      this.lastEffectiveStatus.delete(sessionId)
      sessionGoneHook(sessionId)
    }
    if (consumed) notifyUsageConsumption()
  }

  private notifySessionWaiting(ccSessionId: string, entry: IndexEntry): void {
    const prefs = getNotifPrefs()
    if (!prefs.enabled || !prefs.sessionWaiting) return
    // Filha do Crew Dock não notifica: o dock já sinaliza a espera dela (dot
    // pulsando na trilha + contador âmbar). Mesmo filtro que o toast do renderer
    // aplica — sem isto, a MESMA espera chega por duas superfícies. Pedido de
    // permissão da filha é exceção, avisado por crew-permission-notify.
    if (isActiveCrewChild(ccSessionId)) return
    // Suprime só quando o usuário já está olhando ESTA sessão (janela focada +
    // pane ativo nela). Janela focada em outra sessão continua notificando.
    if (getMainWindow()?.isFocused() && getRendererFocusedSession() === ccSessionId) return
    const name = entry.name ?? 'Sessão'
    notify({
      title: `${name} aguardando você`,
      body: 'A sessão terminou e espera sua resposta.',
      ccSessionId,
    })
  }

  private async emitFor(ccSessionId: string): Promise<void> {
    const entry = this.watched.get(ccSessionId)
    if (!entry) return
    const indexed = this.index.get(ccSessionId)

    let status: SessionActivity['status']
    let name: string | null = null
    let lastActivityAt: number | null = null

    const livePty = tuiMenuWatch.ptyForCc(ccSessionId)
    if (!indexed && livePty && ptyManager.isRunning(livePty)) {
      // PTY viva sem session file: trust (antes do registro) ou subindo. Uma
      // conversa retomada já tem JSONL, e o ramo abaixo a dava por encerrada.
      status = unregisteredPtyStatus(livePty)
    } else if (!indexed) {
      // Sem arquivo: ou a sessão ainda não nasceu (starting) ou já encerrou.
      // Se já vimos o JSONL antes (transcriptPath), tratamos como encerrada.
      status = entry.transcriptPath ? 'ended' : 'starting'
    } else if (!isPidAlive(indexed.pid)) {
      status = 'ended'
      name = indexed.name
      lastActivityAt = indexed.updatedAt
    } else {
      status = mapStatus(indexed.status)
      name = indexed.name
      lastActivityAt = indexed.updatedAt
    }

    // Enriquecimento secundário do JSONL (lastText/tokens/title) sob demanda.
    if (!entry.transcriptPath) entry.transcriptPath = findTranscriptPath(ccSessionId)
    // Transcript pode ter nascido depois do watch(); garante o watcher per-sessão
    // (e anexa o dir subagents/ quando ele aparecer).
    this.ensureFileWatcher(ccSessionId, entry)
    let subagents: SessionActivity['subagents']
    if (entry.transcriptPath) {
      const tail = await readTail(entry.transcriptPath)
      if (tail) {
        scanTranscriptForSendMessage(ccSessionId, tail, this.index)
        entry.enrichment = deriveEnrichment(tail)
        const metas = readSubagentMetas(dirname(entry.transcriptPath), ccSessionId)
        if (metas.length > 0) subagents = deriveSubagentActivity(metas, tail)
      }
    }

    const activity: SessionActivity = {
      ccSessionId,
      status,
      name,
      title: entry.enrichment.title,
      lastText: entry.enrichment.lastText,
      lastActivityAt,
      tokens: entry.enrichment.tokens,
      model: currentModel(entry.enrichment, {
        model: spawnModelOf(ccSessionId),
        startedAt: indexed?.startedAt ?? null,
      }),
      subagents,
    }
    broadcast('session:activity', activity)
  }
}

export const sessionActivityService = new SessionActivityService()
