import { BrowserWindow, type WebContents } from 'electron'
import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import chokidar, { FSWatcher } from 'chokidar'
import { findTranscriptPath } from './session-activity'
import {
  createChatParser,
  lastPlanFilePath,
  parseChatMessages,
  parseTranscriptLines,
  rewoundUuids,
  type ChatParser,
} from './chat-transcript'
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
// Num streaming os appends chegam a menos de DEBOUNCE_MS um do outro e a cauda nunca
// vence: sem teto o chat só leria quando a rajada parasse. O 1º change de uma rajada
// garante uma leitura em no máximo isto.
const MAX_WAIT_MS = 300
// A 1ª leitura de uma mãe passa de 60MB: em blocos, o pico de memória é um bloco e as
// linhas dele, não o arquivo inteiro.
const BLOCK_BYTES = 4 * 1024 * 1024
// Bytes logo antes do offset, conferidos a cada leitura: se mudaram, o arquivo foi
// reescrito e o que já foi parseado não vale mais.
const TAIL_CHECK_BYTES = 64

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

// O que o watch completo retém de uma sessão observada: o parser com o estado que liga
// uma linha às anteriores, e até onde o arquivo já foi consumido.
interface Tracked {
  parser: ChatParser
  // O mapa que o parser consulta a cada tool_use. Ganha entradas quando um meta aparece;
  // os turnos ficam de fora (entram em `messages`), porque mudam sem o parser saber.
  subagents: Map<string, SubagentInfo>
  // parser.messages com os turnos atuais de cada card de subagente. Trocado, nunca
  // mutado: o snapshot devolve esta referência.
  messages: ChatMessage[]
  // Byte logo após o último '\n' consumido.
  offset: number
  tailCheck: Buffer
  mtimeMs: number
}

interface FullWatch {
  ccSessionId: string
  path: string | null
  watcher: FSWatcher | null
  poll: NodeJS.Timeout | null
  debounce: NodeJS.Timeout | null
  // Teto do debounce: armado pelo 1º change de uma rajada, os seguintes não o zeram.
  maxWait: NodeJS.Timeout | null
  // webContents.id de quem chamou chat:watch → o próprio webContents.
  subscribers: Map<number, WebContents>
  tracked: Tracked | null
  // Número do último update emitido; 0 enquanto nada saiu.
  rev: number
  // Leituras em série: duas ao mesmo tempo consumiriam o mesmo trecho duas vezes.
  queue: Promise<void>
  // Há uma leitura na fila que ainda não começou.
  queued: boolean
}

function newTracked(index: Map<string, SubagentRef>, dropped?: ReadonlySet<string>): Tracked {
  const subagents = withoutTurns(index)
  return {
    parser: createChatParser({ subagents, dropped }),
    subagents,
    messages: [],
    offset: 0,
    tailCheck: Buffer.alloc(0),
    mtimeMs: 0,
  }
}

// Metas que apareceram desde a última leitura entram no mapa do parser. false = um deles
// é de um tool_use cujo resultado já saiu como tool_result genérico: só relendo tudo.
function admitSubagents(t: Tracked, index: Map<string, SubagentRef>): boolean {
  let inPlace = true
  for (const [id, ref] of index) {
    if (t.subagents.has(id)) continue
    t.subagents.set(id, { name: ref.name, description: ref.description, turnCount: 0, turns: [] })
    if (!t.parser.promoteSubagent(id)) inPlace = false
  }
  return inPlace
}

async function sameFileUpToOffset(fh: FileHandle, t: Tracked, size: number): Promise<boolean> {
  if (size < t.offset) return false
  const now = Buffer.alloc(t.tailCheck.length)
  await fh.read(now, 0, now.length, t.offset - now.length)
  return now.equals(t.tailCheck)
}

// Consome de t.offset até o último '\n' do arquivo. O que sobra depois dele é uma linha
// ainda sendo escrita: fica para a próxima leitura. rewind:true = o parser recusou um
// lote (Restore conversation) e `t` não serve mais.
async function feedAppended(fh: FileHandle, t: Tracked, size: number): Promise<{ rewind: boolean }> {
  let pos = t.offset
  let carry: Buffer = Buffer.alloc(0)
  while (pos < size) {
    const block = Buffer.alloc(Math.min(BLOCK_BYTES, size - pos))
    const { bytesRead } = await fh.read(block, 0, block.length, pos)
    if (bytesRead === 0) break
    pos += bytesRead
    const chunk = Buffer.concat([carry, block.subarray(0, bytesRead)])
    const end = chunk.lastIndexOf(0x0a) + 1
    if (end > 0) {
      if (t.parser.feed(parseTranscriptLines(chunk.toString('utf8', 0, end))).rewind) {
        return { rewind: true }
      }
      t.offset = pos - (chunk.length - end)
      t.tailCheck = Buffer.from(chunk.subarray(Math.max(0, end - TAIL_CHECK_BYTES), end))
    }
    carry = chunk.subarray(end)
  }
  return { rewind: false }
}

// Depois de um rewind os ramos abandonados só saem com o arquivo inteiro à vista
// (rewoundUuids precisa de todas as linhas): parser novo, semeado com eles.
async function rereadRewound(path: string, index: Map<string, SubagentRef>): Promise<Tracked> {
  const buf = await readFile(path)
  const end = buf.lastIndexOf(0x0a) + 1
  const lines = parseTranscriptLines(buf.toString('utf8', 0, end))
  const t = newTracked(index, rewoundUuids(lines))
  t.parser.feed(lines)
  t.offset = end
  t.tailCheck = Buffer.from(buf.subarray(Math.max(0, end - TAIL_CHECK_BYTES), end))
  return t
}

type Turns = { turnCount: number; turns: string[] }
const sameTurns = (a: Turns, b: Turns): boolean =>
  a.turnCount === b.turnCount &&
  (a.turns === b.turns ||
    (a.turns.length === b.turns.length && a.turns.every((t, i) => t === b.turns[i])))

// Monta a lista a publicar: abaixo de `dirty` ficam os objetos já publicados, do resto
// vêm os do parser. Os turnos de um subagente crescem no .jsonl dele sem o parser ver
// (inclusive depois do resultado, em subagente de fundo), então todo card é conferido;
// o que mudou é trocado e puxa `base` para o índice dele.
function withSubagentTurns(
  published: readonly ChatMessage[],
  parsed: readonly ChatMessage[],
  dirty: number,
  index: Map<string, SubagentRef>,
): { messages: ChatMessage[]; base: number } {
  let base = dirty
  const messages = parsed.map((m, i) => {
    const kept = i < dirty ? published[i] : m
    if (kept.kind !== 'subagent') return kept
    const ref = index.get(kept.id)
    if (!ref) return kept
    const now = readSubagentTurns(ref.jsonlPath)
    if (sameTurns(kept, now)) return kept
    base = Math.min(base, i)
    return { ...kept, ...now }
  })
  return { messages, base }
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

export interface ChatTranscriptSnapshot extends ChatTranscriptRead {
  // Rev do watch a que a lista corresponde; 0 quando ninguém observa a sessão.
  rev: number
}

// Lê/observa o transcript JSONL de uma sessão pra alimentar o Chat View. O parser
// é puro (chat-transcript.ts); aqui mora só o I/O e o lifecycle do watcher.
//
// Watcher: chokidar num ÚNICO arquivo. NÃO usamos awaitWriteFinish — ele aguarda o
// arquivo PARAR de mudar, o que atrasaria updates durante o streaming (append
// contínuo). Em vez disso: debounce curto com teto + leitura só do que foi acrescentado desde a
// última, alimentando o parser incremental. Cada mudança emite o delta (`base` + as
// mensagens dali em diante) só para os webContents que chamaram chat:watch. O arquivo é
// relido do zero (base 0) quando encolheu, foi reescrito, sofreu rewind, ou quando o meta
// de um subagente chega depois do resultado dele.
class ChatTranscriptService {
  // chave = sessionId INTERNO (sessions.id); pty:exit também usa essa chave.
  private watches = new Map<string, FullWatch>()
  // Caudas dos tiles: watcher próprio, coexiste com o watch completo da mesma sessão.
  private tailWatches = new Map<string, WatchEntry>()
  // webContents.id → desliga os listeners de ciclo de vida. Um par por janela, não por
  // sessão observada.
  private senders = new Map<number, () => void>()

  // Leitura avulsa do arquivo INTEIRO, sem reter nada: o resumo de voz
  // (voice-summary.ts) e o chat:get-transcript de uma sessão que ninguém observa.
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

  watch(sessionId: string, ccSessionId: string | null, sender: WebContents): void {
    const existing = this.watches.get(sessionId)
    if (existing) {
      if (existing.subscribers.has(sender.id)) return
      this.subscribe(existing, sender)
      // Quem chega depois perdeu o que já saiu: recebe a lista inteira, no rev atual.
      if (existing.rev > 0) {
        sender.send('chat:transcript-update', this.update(sessionId, existing, 0))
      }
      return
    }
    if (!ccSessionId) return // sem cc id não há transcript a observar.
    const entry: FullWatch = {
      ccSessionId,
      path: null,
      watcher: null,
      poll: null,
      debounce: null,
      maxWait: null,
      subscribers: new Map(),
      tracked: null,
      rev: 0,
      queue: Promise.resolve(),
      queued: false,
    }
    this.subscribe(entry, sender)
    this.watches.set(sessionId, entry)
    const path = findTranscriptPath(ccSessionId)
    if (path) this.attach(sessionId, entry, path)
    else this.startPoll(sessionId, entry)
  }

  // Com senderId sai só aquele inscrito, e a entrada (parser, offset, mensagens) é
  // liberada quando o último sai. Sem senderId (pty:exit) libera para todos.
  unwatch(sessionId: string, senderId?: number): void {
    const entry = this.watches.get(sessionId)
    if (!entry) return
    if (senderId !== undefined) {
      entry.subscribers.delete(senderId)
      if (entry.subscribers.size > 0) return
    }
    if (entry.poll) clearInterval(entry.poll)
    if (entry.debounce) clearTimeout(entry.debounce)
    if (entry.maxWait) clearTimeout(entry.maxWait)
    if (entry.watcher) void entry.watcher.close()
    this.watches.delete(sessionId)
  }

  isWatching(sessionId: string): boolean {
    return this.watches.has(sessionId)
  }

  closeAll(): void {
    for (const id of [...this.watches.keys()]) this.unwatch(id)
    for (const id of [...this.tailWatches.keys()]) this.unwatchTail(id)
    for (const dispose of this.senders.values()) dispose()
    this.senders.clear()
  }

  // Lê agora o que foi acrescentado ao transcript e emite o delta. É o que o watcher
  // chama depois do debounce; resolve quando essa leitura (e as anteriores) terminou.
  refresh(sessionId: string): Promise<void> {
    const entry = this.watches.get(sessionId)
    return entry ? this.enqueue(sessionId, entry) : Promise.resolve()
  }

  // Estado para o chat:get-transcript. Espera a leitura em curso: o renderer chama o
  // watch e logo em seguida pede o transcript, antes de a 1ª leitura terminar.
  async snapshot(sessionId: string, ccSessionId: string | null): Promise<ChatTranscriptSnapshot> {
    const entry = this.watches.get(sessionId)
    await entry?.queue
    const tracked = entry?.tracked
    if (!entry || !tracked) return { ...(await this.read(ccSessionId)), rev: entry?.rev ?? 0 }
    return {
      ccSessionId: entry.ccSessionId,
      path: entry.path,
      mtimeMs: tracked.mtimeMs,
      messages: tracked.messages,
      lastPlanFilePath: lastPlanFilePath(tracked.messages),
      rev: entry.rev,
    }
  }

  private subscribe(entry: FullWatch, sender: WebContents): void {
    entry.subscribers.set(sender.id, sender)
    if (this.senders.has(sender.id)) return
    const id = sender.id
    // O refcount do watch vive no renderer e some com ele: janela fechada ou recarregada
    // não manda chat:unwatch, e a lista parseada ficaria retida para sempre.
    const drop = () => {
      for (const [sessionId, e] of [...this.watches]) {
        if (e.subscribers.has(id)) this.unwatch(sessionId, id)
      }
    }
    const onDestroyed = () => {
      drop()
      this.senders.delete(id)
    }
    // Só o frame principal trocando de documento recarrega o renderer; iframe e troca
    // de hash não.
    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) drop()
    }
    sender.once('destroyed', onDestroyed)
    sender.on('did-start-navigation', onNavigation)
    this.senders.set(id, () => {
      sender.off('destroyed', onDestroyed)
      sender.off('did-start-navigation', onNavigation)
    })
  }

  private update(sessionId: string, entry: FullWatch, base: number): ChatTranscriptUpdate {
    const messages = entry.tracked?.messages ?? []
    return {
      sessionId,
      transcriptExists: entry.tracked !== null,
      base,
      rev: entry.rev,
      messages: messages.slice(base),
      lastPlanFilePath: lastPlanFilePath(messages),
    }
  }

  private emit(sessionId: string, entry: FullWatch, base: number): void {
    entry.rev += 1
    const update = this.update(sessionId, entry, base)
    for (const sender of entry.subscribers.values()) {
      if (!sender.isDestroyed()) sender.send('chat:transcript-update', update)
    }
  }

  private enqueue(sessionId: string, entry: FullWatch): Promise<void> {
    // A leitura que ainda não começou já vai ver o que for escrito até ela começar:
    // outra na fila só abriria o arquivo de novo para o mesmo trecho.
    if (entry.queued) return entry.queue
    entry.queued = true
    // Erro de leitura (arquivo sumiu, corrida com uma reescrita): o estado fica como
    // estava e a próxima mudança do arquivo tenta de novo.
    entry.queue = entry.queue
      .then(() => {
        entry.queued = false
        return this.advance(sessionId, entry)
      })
      .catch(() => {})
    return entry.queue
  }

  private async advance(sessionId: string, entry: FullWatch): Promise<void> {
    const path = entry.path
    // Compara a entrada, não só a chave: um unwatch+watch durante a leitura não deve
    // receber o estado do watcher velho.
    if (!path || this.watches.get(sessionId) !== entry) return
    const index = readSubagentIndex(dirname(path), entry.ccSessionId)
    const prev = entry.tracked
    let next = prev
    let mtimeMs: number
    const fh = await open(path, 'r')
    try {
      const st = await fh.stat()
      mtimeMs = st.mtimeMs
      if (!next || !admitSubagents(next, index) || !(await sameFileUpToOffset(fh, next, st.size))) {
        next = newTracked(index)
      }
      if ((await feedAppended(fh, next, st.size)).rewind) next = await rereadRewound(path, index)
    } finally {
      await fh.close()
    }
    if (this.watches.get(sessionId) !== entry) return
    // Daqui em diante é síncrono: lista, rev e envio mudam juntos, e o snapshot nunca vê
    // uma lista com o rev de outra.
    const { messages, base } = withSubagentTurns(
      next.messages,
      next.parser.messages,
      next.parser.takeDirty(),
      index,
    )
    next.messages = messages
    next.mtimeMs = mtimeMs
    entry.tracked = next
    if (next === prev && base === messages.length) return // nada mudou no chat.
    this.emit(sessionId, entry, next === prev ? base : 0)
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
  private startPoll(sessionId: string, entry: FullWatch): void {
    this.emit(sessionId, entry, 0)
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

  private attach(sessionId: string, entry: FullWatch, path: string): void {
    entry.path = path
    void this.enqueue(sessionId, entry) // estado inicial imediato.
    entry.watcher = chokidar.watch(path, { ignoreInitial: true })
    // Cauda e teto disparam a mesma leitura; a que vencer desarma a outra.
    const read = () => {
      if (entry.debounce) clearTimeout(entry.debounce)
      if (entry.maxWait) clearTimeout(entry.maxWait)
      entry.debounce = null
      entry.maxWait = null
      void this.enqueue(sessionId, entry)
    }
    const schedule = () => {
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.debounce = setTimeout(read, DEBOUNCE_MS)
      entry.maxWait ??= setTimeout(read, MAX_WAIT_MS)
    }
    entry.watcher.on('change', schedule)
    entry.watcher.on('add', schedule)
  }
}

export const chatTranscriptService = new ChatTranscriptService()
