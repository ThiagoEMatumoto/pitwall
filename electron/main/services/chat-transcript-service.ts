import { BrowserWindow } from 'electron'
import { open, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import chokidar, { FSWatcher } from 'chokidar'
import { findTranscriptPath } from './session-activity'
import { lastPlanFilePath, parseChatMessages } from './chat-transcript'
import {
  readSubagentIndex,
  readSubagentInfos,
  readSubagentTurns,
  type SubagentRef,
} from './subagent-turns'
import type { SubagentInfo } from './chat-transcript'
import type {
  ChatMessage,
  ChatTranscriptTail,
  ChatTranscriptUpdate,
} from '../../../shared/types/chat'

const POLL_MS = 1000 // espera o JSONL nascer (sessão recém-spawnada)
const DEBOUNCE_MS = 150 // coalesce de bursts de append durante o streaming

// Cauda (tile da Room): só os últimos bytes do JSONL. As mães são as sessões
// longas (p99 ~18MB), e reler o arquivo inteiro a cada append por 8 tiles seria
// o caminho caro. 400ms porque o tile mostra a cauda, não o streaming.
export const TAIL_BYTES = 256 * 1024
export const TAIL_MAX_BYTES = 2 * 1024 * 1024
export const TAIL_MESSAGES = 5
const TAIL_DEBOUNCE_MS = 400

// Lê só a janela final do arquivo e devolve as últimas TAIL_MESSAGES mensagens,
// pelo MESMO parser do caminho completo. A primeira linha da janela é descartada
// (pode estar cortada), e exigimos uma mensagem a mais que o necessário: a
// primeira da janela pode ser um turno de assistant pela metade (o merge de
// blocos por message.id começou antes da janela). Se não couber, dobra a janela
// até TAIL_MAX_BYTES e devolve o que coube.
//
// Subagentes: o parser só precisa saber QUAIS tool_use são subagentes (índice dos
// metas, cacheado). Os turnos (.jsonl, centenas de MB numa mãe) são resolvidos
// depois, só para os cards que estão nas mensagens entregues — o custo por emit
// não cresce com o número de subagentes da sessão.
export async function readTail(
  path: string,
  ccSessionId: string | null = null,
): Promise<ChatMessage[]> {
  const index = ccSessionId ? readSubagentIndex(dirname(path), ccSessionId) : undefined
  const messages = await readTailMessages(path, index && withoutTurns(index))
  if (!index) return messages
  return messages.map((m) => {
    const ref = m.kind === 'subagent' ? index.get(m.id) : undefined
    return ref ? { ...m, ...readSubagentTurns(ref.jsonlPath) } : m
  })
}

function withoutTurns(index: Map<string, SubagentRef>): Map<string, SubagentInfo> {
  const out = new Map<string, SubagentInfo>()
  for (const [id, ref] of index) {
    out.set(id, { name: ref.name, description: ref.description, turnCount: 0, turns: [] })
  }
  return out
}

async function readTailMessages(
  path: string,
  subagents: Map<string, SubagentInfo> | undefined,
): Promise<ChatMessage[]> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    let windowBytes = TAIL_BYTES
    for (;;) {
      const start = Math.max(0, size - windowBytes)
      const buf = Buffer.alloc(size - start)
      await fh.read(buf, 0, buf.length, start)
      let text = buf.toString('utf8')
      if (start > 0) {
        const nl = text.indexOf('\n')
        text = nl === -1 ? '' : text.slice(nl + 1)
      }
      const messages = parseChatMessages(text, subagents)
      if (start === 0 || messages.length > TAIL_MESSAGES || windowBytes >= TAIL_MAX_BYTES) {
        return messages.slice(-TAIL_MESSAGES)
      }
      windowBytes = Math.min(windowBytes * 2, TAIL_MAX_BYTES)
    }
  } finally {
    await fh.close()
  }
}

interface WatchEntry {
  ccSessionId: string
  path: string | null
  watcher: FSWatcher | null
  poll: NodeJS.Timeout | null
  debounce: NodeJS.Timeout | null
  // Só a cauda usa: numera as leituras para uma leitura velha que termina depois
  // de uma nova não sobrescrever a cauda mais recente.
  seq?: number
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export interface ChatTranscriptRead {
  ccSessionId: string | null
  path: string | null
  mtimeMs: number | null
  messages: ChatMessage[]
  lastPlanFilePath: string | null
}

// Lê/observa o transcript JSONL de uma sessão pra alimentar o Chat View. O parser
// é puro (chat-transcript.ts); aqui mora só o I/O e o lifecycle do watcher.
//
// Watcher: chokidar num ÚNICO arquivo. NÃO usamos awaitWriteFinish — ele aguarda o
// arquivo PARAR de mudar, o que atrasaria updates durante o streaming (append
// contínuo). Em vez disso: debounce curto + re-leitura do arquivo INTEIRO; o parser
// tolera a última linha parcial (try/catch por linha). Re-emite a LISTA completa a
// cada mudança — simples e robusto a reescritas do JSONL (o renderer só substitui).
class ChatTranscriptService {
  // chave = sessionId INTERNO (sessions.id); pty:exit também usa essa chave.
  private watches = new Map<string, WatchEntry>()
  // Caudas dos tiles: watcher próprio, coexiste com o watch completo da mesma sessão.
  private tailWatches = new Map<string, WatchEntry>()

  // Leitura pontual (chat:get-transcript). Lê o arquivo INTEIRO — o chat precisa do
  // histórico completo, ao contrário do tail de 64KB do session-activity.
  async read(ccSessionId: string | null): Promise<ChatTranscriptRead> {
    if (!ccSessionId)
      return { ccSessionId, path: null, mtimeMs: null, messages: [], lastPlanFilePath: null }
    const path = findTranscriptPath(ccSessionId)
    if (!path)
      return { ccSessionId, path: null, mtimeMs: null, messages: [], lastPlanFilePath: null }
    return this.readPath(ccSessionId, path)
  }

  private async readPath(ccSessionId: string, path: string): Promise<ChatTranscriptRead> {
    try {
      const [content, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      // Subagentes vivem em <projectDir>/<ccSessionId>/subagents/ (irmão do JSONL
      // principal em <projectDir>/<ccSessionId>.jsonl) — leitura síncrona barata.
      const subagents = readSubagentInfos(dirname(path), ccSessionId)
      const messages = parseChatMessages(content, subagents)
      return {
        ccSessionId,
        path,
        mtimeMs: st.mtimeMs,
        messages,
        lastPlanFilePath: lastPlanFilePath(messages),
      }
    } catch {
      // arquivo sumiu / corrida — devolve vazio em vez de derrubar o handler.
      return { ccSessionId, path, mtimeMs: null, messages: [], lastPlanFilePath: null }
    }
  }

  watch(sessionId: string, ccSessionId: string | null): void {
    if (this.watches.has(sessionId)) return
    if (!ccSessionId) return // sem cc id não há transcript a observar.
    const entry: WatchEntry = {
      ccSessionId,
      path: null,
      watcher: null,
      poll: null,
      debounce: null,
    }
    this.watches.set(sessionId, entry)
    const path = findTranscriptPath(ccSessionId)
    if (path) this.attach(sessionId, entry, path)
    else this.startPoll(sessionId, entry)
  }

  unwatch(sessionId: string): void {
    const entry = this.watches.get(sessionId)
    if (!entry) return
    if (entry.poll) clearInterval(entry.poll)
    if (entry.debounce) clearTimeout(entry.debounce)
    if (entry.watcher) void entry.watcher.close()
    this.watches.delete(sessionId)
  }

  closeAll(): void {
    for (const id of [...this.watches.keys()]) this.unwatch(id)
    for (const id of [...this.tailWatches.keys()]) this.unwatchTail(id)
  }

  // Watch já ativo: um 2º consumidor (outro tile/janela) não viu o emit inicial, e
  // numa mãe parada nenhum change viria — reemite a cauda atual.
  watchTail(sessionId: string, ccSessionId: string | null): void {
    const existing = this.tailWatches.get(sessionId)
    if (existing) {
      if (existing.path) void this.emitTail(sessionId, existing, existing.path)
      return
    }
    if (!ccSessionId) return
    const entry: WatchEntry = { ccSessionId, path: null, watcher: null, poll: null, debounce: null }
    this.tailWatches.set(sessionId, entry)
    const path = findTranscriptPath(ccSessionId)
    if (path) this.attachTail(sessionId, entry, path)
    else this.startTailPoll(sessionId, entry)
  }

  unwatchTail(sessionId: string): void {
    const entry = this.tailWatches.get(sessionId)
    if (!entry) return
    if (entry.poll) clearInterval(entry.poll)
    if (entry.debounce) clearTimeout(entry.debounce)
    if (entry.watcher) void entry.watcher.close()
    this.tailWatches.delete(sessionId)
  }

  private startTailPoll(sessionId: string, entry: WatchEntry): void {
    broadcast('chat:transcript-tail', {
      sessionId,
      transcriptExists: false,
      messages: [],
    } satisfies ChatTranscriptTail)
    entry.poll = setInterval(() => {
      const path = findTranscriptPath(entry.ccSessionId)
      if (!path) return
      if (entry.poll) {
        clearInterval(entry.poll)
        entry.poll = null
      }
      this.attachTail(sessionId, entry, path)
    }, POLL_MS)
  }

  private attachTail(sessionId: string, entry: WatchEntry, path: string): void {
    entry.path = path
    void this.emitTail(sessionId, entry, path)
    entry.watcher = chokidar.watch(path, { ignoreInitial: true })
    const schedule = () => {
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.debounce = setTimeout(
        () => void this.emitTail(sessionId, entry, path),
        TAIL_DEBOUNCE_MS,
      )
    }
    entry.watcher.on('change', schedule)
    entry.watcher.on('add', schedule)
  }

  private async emitTail(sessionId: string, entry: WatchEntry, path: string): Promise<void> {
    // Compara a entrada, não só a chave: um unwatch+watch durante a leitura não
    // deve receber o emit do watcher velho.
    if (this.tailWatches.get(sessionId) !== entry) return
    const seq = (entry.seq ?? 0) + 1
    entry.seq = seq
    let messages: ChatMessage[]
    try {
      messages = await readTail(path, entry.ccSessionId)
    } catch {
      return // arquivo sumiu / corrida: o próximo change reemite.
    }
    if (this.tailWatches.get(sessionId) !== entry || entry.seq !== seq) return
    broadcast('chat:transcript-tail', {
      sessionId,
      transcriptExists: true,
      messages,
    } satisfies ChatTranscriptTail)
  }

  // Transcript ainda inexistente (sessão recém-spawnada): poll barato até o JSONL
  // aparecer, então passa pro file-watcher. findTranscriptPath é um readdir dos
  // subdirs de projects — leve o bastante pra 1s. Emite uma lista vazia de cara pra
  // o renderer não ficar pendurado esperando o primeiro evento.
  private startPoll(sessionId: string, entry: WatchEntry): void {
    broadcast('chat:transcript-update', {
      sessionId,
      transcriptExists: false,
      messages: [],
      lastPlanFilePath: null,
    } satisfies ChatTranscriptUpdate)
    entry.poll = setInterval(() => {
      const path = findTranscriptPath(entry.ccSessionId)
      if (!path) return
      if (entry.poll) {
        clearInterval(entry.poll)
        entry.poll = null
      }
      this.attach(sessionId, entry, path)
    }, POLL_MS)
  }

  private attach(sessionId: string, entry: WatchEntry, path: string): void {
    entry.path = path
    void this.emit(sessionId, entry, path) // estado inicial imediato.
    entry.watcher = chokidar.watch(path, { ignoreInitial: true })
    const schedule = () => {
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.debounce = setTimeout(() => void this.emit(sessionId, entry, path), DEBOUNCE_MS)
    }
    entry.watcher.on('change', schedule)
    entry.watcher.on('add', schedule)
  }

  private async emit(sessionId: string, entry: WatchEntry, path: string): Promise<void> {
    if (!this.watches.has(sessionId)) return // corrida com unwatch durante o debounce.
    const read = await this.readPath(entry.ccSessionId, path)
    if (!this.watches.has(sessionId)) return
    // emit() só dispara depois do attach() (path encontrado) → o arquivo existe.
    broadcast('chat:transcript-update', {
      sessionId,
      transcriptExists: true,
      messages: read.messages,
      lastPlanFilePath: read.lastPlanFilePath,
    } satisfies ChatTranscriptUpdate)
  }
}

export const chatTranscriptService = new ChatTranscriptService()
