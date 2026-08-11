import { BrowserWindow } from 'electron'
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
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import chokidar, { FSWatcher } from 'chokidar'
import type { SessionActivity, GlobalActivityBatch } from '../../../shared/types/ipc'
import { notifyUsageConsumption } from './usage-monitor'
import { getNotifPrefs, getMainWindow, getRendererFocusedSession, notify } from './notifications'
import { isActiveCrewChild } from './handoff-store'
import { deriveSubagentActivity } from './subagent-activity'
import { readSubagentMetas } from './subagent-turns'

export const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const SESSIONS_ROOT = join(homedir(), '.claude', 'sessions')
const TAIL_BYTES = 64 * 1024
const DEBOUNCE_MS = 250
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
}

export interface IndexEntry {
  pid: number
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

// O JSONL nasce em ~/.claude/projects/<cwd-encoded>/<ccSessionId>.jsonl. Em vez de
// reproduzir o encoding do cwd, varremos os subdirs procurando o arquivo pelo id.
export function findTranscriptPath(ccSessionId: string): string | null {
  if (!existsSync(PROJECTS_ROOT)) return null
  const target = `${ccSessionId}.jsonl`
  let dirs: string[]
  try {
    dirs = readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = join(PROJECTS_ROOT, dir, target)
    if (existsSync(candidate)) return candidate
  }
  return null
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
    // Snapshot inicial imediato (índice já pode estar populado).
    this.rebuildIndex()
    this.broadcastGlobal()
  }

  unwatchGlobal(): void {
    this.globalWatch = false
    this.maybeCloseDirWatcher()
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
    const batch: GlobalActivityBatch = []
    for (const [ccSessionId, entry] of this.index) {
      const status = this.effectiveStatus(entry)
      let lastText: string | null = null
      let tokens: SessionActivity['tokens']
      const transcriptPath = findTranscriptPath(ccSessionId)
      if (transcriptPath) {
        const tail = await readTail(transcriptPath)
        if (tail) {
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
      })
    }
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
    }
    if (consumed) notifyUsageConsumption()
  }

  private notifySessionWaiting(ccSessionId: string, entry: IndexEntry): void {
    const prefs = getNotifPrefs()
    if (!prefs.enabled || !prefs.sessionWaiting) return
    // Filha do Crew Dock não notifica: o dock já sinaliza a espera dela (dot
    // pulsando na trilha + contador âmbar). Mesmo filtro que o toast do renderer
    // aplica — sem isto, a MESMA espera chega por duas superfícies.
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

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export const sessionActivityService = new SessionActivityService()
