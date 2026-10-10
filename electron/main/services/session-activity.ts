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
  // Campo 22 de /proc/<pid>/stat (starttime, em ticks) do processo que escreveu.
  procStart?: string
}

export interface IndexEntry {
  pid: number
  procStart: string | null
  status: CcSessionFile['status']
  name: string | null
  cwd: string | null
  updatedAt: number | null
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
// "dono da conversa" um processo qualquer. Vivo = /proc/<pid> existe e o start
// time bate com o procStart que o Claude Code gravou; arquivo sem procStart
// (versão antiga) = o cmdline precisa ser de um claude. Fora do Linux não há
// /proc: fica o kill(pid, 0).
export function isSessionPidAlive(
  entry: Pick<IndexEntry, 'pid' | 'procStart'>,
  procRoot = '/proc',
): boolean {
  if (process.platform !== 'linux') return isPidAlive(entry.pid)
  let stat: string
  try {
    stat = readFileSync(join(procRoot, String(entry.pid), 'stat'), 'utf8')
  } catch {
    return false
  }
  if (entry.procStart) return procStartOf(stat) === entry.procStart
  try {
    return readFileSync(join(procRoot, String(entry.pid), 'cmdline'), 'utf8').includes('claude')
  } catch {
    return false
  }
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
  return { title, lastText, tokens, model: lastAssistant?.message?.model ?? null }
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
      enrichment: { title: null, lastText: null, tokens: undefined, model: null },
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
    if (this.globalWatch) return
    this.globalWatch = true
    this.ensureDirWatcher()
    this.sendMessagePoll = setInterval(
      () => void this.pollBusyTranscripts(),
      SEND_MESSAGE_POLL_MS,
    )
    this.sendMessagePoll.unref?.()
    // Snapshot inicial imediato (índice já pode estar populado).
    this.rebuildIndex()
    this.broadcastGlobal()
  }

  unwatchGlobal(): void {
    this.globalWatch = false
    if (this.sendMessagePoll) clearInterval(this.sendMessagePoll)
    this.sendMessagePoll = null
    this.polledTranscripts.clear()
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
  // tail do JSONL (mesma derivação do emitFor), sob demanda por sessão.
  private async broadcastGlobal(): Promise<void> {
    const gen = ++this.globalGen
    const batch: GlobalActivityBatch = []
    for (const [ccSessionId, entry] of this.index) {
      const status = this.effectiveStatus(entry)
      let lastText: string | null = null
      let tokens: SessionActivity['tokens']
      const transcriptPath = findTranscriptPath(ccSessionId)
      if (transcriptPath) {
        const tail = await readTail(transcriptPath)
        if (tail) {
          scanTranscriptForSendMessage(ccSessionId, tail, this.index)
          const enrichment = deriveEnrichment(tail)
          lastText = enrichment.lastText
          tokens = enrichment.tokens
        }
      }
      batch.push({
        ccSessionId,
        status,
        lastActivityAt: entry.updatedAt,
        lastText,
        tokens,
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
    if (gen !== this.globalGen) return
    broadcast('session:activity:global', batch)
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

    if (!indexed) {
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
      model: entry.enrichment.model,
      subagents,
    }
    broadcast('session:activity', activity)
  }
}

export const sessionActivityService = new SessionActivityService()
