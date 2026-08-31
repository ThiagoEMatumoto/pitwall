import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { getDb } from '../services/db'
import { ptyManager } from '../services/pty-manager'
import { sessionSpawnEnv } from '../services/custom-env'
import { get as getFeature, linkedObjectiveTitles } from '../services/feature-store'
import * as handoffStore from '../services/handoff-store'
// formatPtyInjection vive em services/handoff/inject.ts (fonte canônica, sem
// dependência de electron). Reexportado abaixo para não quebrar quem importa
// de './sessions' (ex.: sessions.test.ts).
import { formatPtyInjection } from '../services/handoff/inject'
import { featureMemory } from '../services/feature-memory'
import { buildFeatureContextContent, type FeatureLoopContext } from './feature-context'
import { loopSnapshot } from '../services/loop-snapshot'
import { buildRepoArchitectureOrNull } from './repo-architecture-context'
import {
  sessionActivityService,
  findTranscriptPath,
  buildSessionsFileIndex,
  readTranscriptTitle,
  readTail,
  deriveEnrichment,
  isPidAlive,
  mapStatus,
} from '../services/session-activity'
import { setRendererFocusedSession } from '../services/notifications'
import { getMcpRuntime } from '../services/mcp/server'
import {
  mcpClientConfigPath,
  removeSessionMcpConfig,
  writeSessionMcpClientConfig,
} from '../services/mcp/config'
import { chatTranscriptService } from '../services/chat-transcript-service'
import {
  resolvePermissionMode,
  resolveDisallowedTools,
  resolveModel,
  resolveEffort,
  resolveAdvisor,
  permissionModeForHandoffMode,
  HANDOFF_CHILD_SETTINGS_JSON,
} from '../services/spawn-flags'
import { setSpawnHandoffChild } from '../services/handoff/spawn-child'
import {
  buildImageFilename,
  isImageTempFile,
  isSessionImageTempFile,
} from '../services/image-temp'
import { mapLiveSessionRepo, type LiveSessionJoinRow } from './live-session-mapping'
import type {
  Session,
  SpawnSessionInput,
  ResumeSessionInput,
  SessionSummary,
  LiveSessionInfo,
  ChatTranscript,
  Handoff,
  HandoffStatus,
} from '../../../shared/types/ipc'

interface SessionRow {
  id: string
  repo_id: string | null
  cc_session_id: string | null
  title: string | null
  title_source: 'manual' | 'auto' | null
  pane_id: string | null
  status: 'running' | 'exited' | 'crashed' | 'closed_by_user'
  started_at: number
  ended_at: number | null
}

interface RepoPathRow {
  path: string
  label: string
}

// O name é input do usuário e entra na linha de `zsh -c '<innerCmd>'`.
// Aspas simples POSIX impedem qualquer interpretação pelo shell; o único caractere
// perigoso dentro de '...' é a própria aspa simples, fechada com '\'' e reaberta.
function shquote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Whitelists + resolução de flags (permission-mode, denylist destrutivo, model,
// effort, advisor) vivem em services/spawn-flags.ts — módulo PURO compartilhado
// com o job-runner headless. Re-exportamos resolvePermissionMode/resolveDisallowedTools
// para manter a superfície pública de './sessions' estável (sessions.test importa daqui).
export { resolvePermissionMode, resolveDisallowedTools } from '../services/spawn-flags'

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  repoId: row.repo_id,
  ccSessionId: row.cc_session_id,
  title: row.title,
  titleSource: row.title_source,
  paneId: row.pane_id,
  status: row.status,
  startedAt: row.started_at,
  endedAt: row.ended_at,
})

const CLAUDE_COMMAND_KEY = 'claude_command'

function resolveClaudeCommand(): string {
  const row = getDb()
    .prepare('SELECT value FROM app_prefs WHERE key = ?')
    .get(CLAUDE_COMMAND_KEY) as { value: string } | undefined
  return row?.value?.trim() || 'claude'
}

const SCRATCH_DIR_KEY = 'scratch_dir'
const QUICK_SESSION_NAME = 'Sessão rápida'

// Guard antes de lançar o PTY: se o diretório do repo não existe, o spawn falha
// tarde com erro opaco. statSync (não existsSync) segue symlinks e lança em link
// quebrado — assim detectamos também repos apontando pra symlink morto.
function assertRepoDirExists(path: string): void {
  try {
    if (statSync(path).isDirectory()) return
  } catch {
    // cai no throw abaixo
  }
  throw new Error(
    `Repositório não existe no disco: ${path}. Restaure o diretório (ou ative o auto-clone) antes de abrir uma sessão.`,
  )
}

// Sessão avulsa (sem repo) roda numa pasta scratch dedicada — configurável via
// app_prefs (mesmo padrão de claude_command), default ~/ClaudeManager/scratch.
// Garante a existência antes do spawn (PTY com cwd inexistente falha).
function resolveScratchDir(): string {
  const row = getDb()
    .prepare('SELECT value FROM app_prefs WHERE key = ?')
    .get(SCRATCH_DIR_KEY) as { value: string } | undefined
  const dir = row?.value?.trim() || join(homedir(), 'ClaudeManager', 'scratch')
  mkdirSync(dir, { recursive: true })
  return dir
}

// B4: conecta a sessão ao MCP server do Pitwall via --mcp-config. Sem
// --strict-mcp-config: os servers de user/projeto do claude continuam valendo.
// Se o server não subiu (EADDRINUSE → getMcpRuntime() null), não injeta nada —
// sessão sobe normal.
//
// Com `internalSessionId` (o sessions.id que ESTA sessão vai receber) escrevemos
// uma config DEDICADA em <userData>/mcp-sessions/<id>.json, cujo endpoint carrega
// a identidade da sessão. É esse carimbo — feito pelo APP, no spawn — que deixa
// o servidor MCP compartilhado saber qual sessão-mãe chamou uma tool. null cai
// no arquivo global (sem identidade), e falha de escrita degrada pro global em
// vez de derrubar o spawn.
function mcpConfigArg(internalSessionId: string | null): string {
  const runtime = getMcpRuntime()
  if (!runtime) return ''
  if (internalSessionId) {
    try {
      const path = writeSessionMcpClientConfig(
        { url: runtime.url, token: runtime.token, pid: process.pid },
        internalSessionId,
      )
      return ` --mcp-config ${shquote(path)}`
    } catch (err) {
      console.error('[sessions] per-session mcp config failed, using the global one:', err)
    }
  }
  return ` --mcp-config ${shquote(mcpClientConfigPath())}`
}

// O claude vive em ~/.local/bin e o env do Electron GUI não herda o PATH do rc.
// Subimos o shell de login+interativo (-l -i carrega .zprofile/.zshrc) e damos
// `exec claude` para que o PTY encerre quando o claude sair.
function loginShellSpawn(innerCmd: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoLogo', '-Command', innerCmd] }
  }
  const shell = process.env.SHELL || '/usr/bin/zsh'
  return { command: shell, args: ['-l', '-i', '-c', `exec ${innerCmd}`] }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// Escreve um arquivo temporário em <userData>/tmp/<prefix>-<ts>.md (mkdir
// recursivo). Retorna o path. Base compartilhada pra system-prompts injetados
// via --append-system-prompt-file (feature context e/ou handoff).
function writeTempPromptFile(prefix: string, content: string): string {
  const tmpDir = join(app.getPath('userData'), 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  const tmpPath = join(tmpDir, `${prefix}-${Date.now()}.md`)
  writeFileSync(tmpPath, content, 'utf8')
  return tmpPath
}

function tempDir(): string {
  return join(app.getPath('userData'), 'tmp')
}

// Grava uma imagem colada/arrastada no composer como BINÁRIO em
// <userData>/tmp/img-<sessionId>-<uuid>.<ext> e devolve o path absoluto. O
// renderer injeta esse path como texto no prompt (a CLI claude anexa a imagem a
// partir do caminho). Escreve um Uint8Array — nunca trata os bytes como utf8,
// que corromperia o arquivo.
function saveImageTemp(sessionId: string, bytes: ArrayBuffer | Uint8Array, mime: string): string {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, buildImageFilename({ id: randomUUID(), mime, sessionId }))
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  writeFileSync(tmpPath, data)
  return tmpPath
}

// Remove temporários de imagem que casam com o predicado. Best-effort: se o
// diretório não existe ainda (nenhuma imagem foi colada) ou um arquivo some numa
// corrida, ignora — limpeza nunca pode derrubar o boot/exit.
function sweepImageTemps(predicate: (filename: string) => boolean): void {
  let names: string[]
  const dir = tempDir()
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!predicate(name)) continue
    try {
      unlinkSync(join(dir, name))
    } catch {
      // já removido / em uso — segue
    }
  }
}

// Sweep de boot: num processo fresco nenhum compose referencia temps de imagem,
// então todos são órfãos. Chamado uma vez no app.whenReady (index.ts).
export function sweepOrphanImageTemps(): void {
  sweepImageTemps(isImageTempFile)
}

// Conteúdo do contexto da feature (header + loop + bloco tracking) vem do
// builder puro em feature-context.ts; aqui só se resolve o I/O. Retorna null se
// a feature não existe.
function buildFeatureContextOrNull(featureId: string): string | null {
  const feature = getFeature(featureId)
  if (!feature) return null
  // O loop é enfeite do bloco, não pré-requisito: se a projeção falhar, a
  // sessão nasce com o contexto básico em vez de não nascer.
  let loop: FeatureLoopContext | null = null
  try {
    const snapshot = loopSnapshot(featureId)
    loop = { liveness: snapshot.liveness, pulse: snapshot.pulse, ledger: snapshot.ledger }
  } catch (err) {
    console.error('[sessions] loopSnapshot falhou:', err)
  }
  return buildFeatureContextContent(feature, linkedObjectiveTitles(featureId), loop)
}

// Monta a string do innerCmd do spawn novo. PURA: sem I/O — recebe os pedaços já
// resolvidos (claudeCmd, sessionId já validado, name, mcpConfigArg pronto, modelo
// já validado contra whitelist ou null, e o path opcional do system-prompt-file
// já escrito). Mantém a ordem das flags do handler original.
//
// `initialPrompt` (opcional): prompt posicional entregue no COMANDO de spawn, não
// injetado no PTY. `claude "<prompt>"` em modo interativo faz auto-submit do 1º
// turno — é o caminho confiável pra background (o kickoff colado no PTY é
// descartado quando ninguém dá resize no TUI). Como posicional, TEM que ser o
// último token, depois de todas as flags.
export function buildSpawnInnerCmd(parts: {
  claudeCmd: string
  sessionId: string
  // true = o sessionId acima é o cc_session_id de uma sessão EXISTENTE e o
  // comando abre com `--resume <id>` em vez de `--session-id <id>`. Existe para
  // o relance da filha reusar esta montagem — sem isto o resume montaria as
  // flags à mão e voltaria a esquecer permission-mode/denylist.
  resume?: boolean
  name: string
  mcpConfigArg: string
  model: string | null
  effort?: string | null
  advisorModel?: string | null
  systemPromptFilePath: string | null
  permissionMode?: string | null
  disallowedTools?: string[] | null
  // JSON inline pro `--settings` (a CLI aceita file OU json). Usado só pela filha
  // de handoff (crossSessionInbound=accept) — por sessão, nunca global.
  settingsJson?: string | null
  initialPrompt?: string | null
}): string {
  const idFlag = parts.resume ? '--resume' : '--session-id'
  let innerCmd = `${parts.claudeCmd} ${idFlag} ${parts.sessionId} -n ${shquote(parts.name)}${parts.mcpConfigArg}`
  if (parts.model) {
    innerCmd += ` --model ${shquote(parts.model)}`
  }
  if (parts.effort) {
    innerCmd += ` --effort ${shquote(parts.effort)}`
  }
  if (parts.advisorModel) {
    innerCmd += ` --advisor ${shquote(parts.advisorModel)}`
  }
  if (parts.permissionMode) {
    innerCmd += ` --permission-mode ${shquote(parts.permissionMode)}`
  }
  if (parts.disallowedTools && parts.disallowedTools.length > 0) {
    innerCmd += ` --disallowedTools ${parts.disallowedTools.map(shquote).join(' ')}`
  }
  if (parts.settingsJson) {
    innerCmd += ` --settings ${shquote(parts.settingsJson)}`
  }
  if (parts.systemPromptFilePath) {
    innerCmd += ` --append-system-prompt-file ${shquote(parts.systemPromptFilePath)}`
  }
  // Posicional por último: `claude [flags] "<prompt>"` auto-submete o 1º turno.
  if (parts.initialPrompt?.trim()) {
    innerCmd += ` ${shquote(parts.initialPrompt.trim())}`
  }
  return innerCmd
}

// Reexport: mantém a superfície pública de './sessions' estável (sessions.test.ts
// importa formatPtyInjection daqui). A definição mora em handoff/inject.ts.
export { formatPtyInjection }

// Injeta um comando inicial no REPL do claude assim que o TUI sobe. Como não há
// sinal explícito de "pronto", esperamos o PRIMEIRO `data` do PTY daquela sessão
// (o banner inicial) e, após um debounce curto, escrevemos via bracketed-paste.
// `.trim()` só tira as bordas (NÃO os \n internos) — prompts multi-linha chegam
// íntegros. One-shot: remove o listener antes de escrever, nunca dispara 2x.
function injectInitialCommandOnFirstData(sessionId: string, command: string): void {
  const cmd = command.trim()
  if (!cmd) return
  let timer: ReturnType<typeof setTimeout> | null = null

  const onData = (e: { sessionId: string }) => {
    if (e.sessionId !== sessionId) return
    if (timer) return // já agendado pelo primeiro data
    timer = setTimeout(() => {
      // Remove AMBOS os listeners: a sessão segue viva após injetar, e deixar
      // o `exit` pendurado acumularia listeners no emitter singleton a cada
      // lançamento (MaxListenersExceededWarning após ~10 sessões vivas).
      ptyManager.off('data', onData)
      ptyManager.off('exit', onExit)
      try {
        ptyManager.write(sessionId, formatPtyInjection(cmd))
      } catch {
        // PTY já encerrou antes do debounce — nada a fazer.
      }
    }, 400)
  }

  // Se a PTY sair antes de injetar, descarta o listener pendente.
  const onExit = (e: { sessionId: string }) => {
    if (e.sessionId !== sessionId) return
    if (timer) clearTimeout(timer)
    ptyManager.off('data', onData)
    ptyManager.off('exit', onExit)
  }

  ptyManager.on('data', onData)
  ptyManager.on('exit', onExit)
}

// Cria o registro em `sessions`, dispara o PTY com o innerCmd dado e devolve o Session.
// Spawn novo e resume diferem só no innerCmd (--session-id <novo> vs --resume <existente>).
function startSession(opts: {
  // Pré-gerado pelo chamador quando o innerCmd precisa conhecê-lo ANTES do
  // spawn (é o caso do mcp-config por sessão: o arquivo tem o id no nome e no
  // endpoint). Omitido → gera aqui, como antes.
  id?: string
  ccSessionId: string
  repoId: string | null
  cwd: string
  innerCmd: string
  featureId?: string | null
  initialCommand?: string
  cols?: number
  rows?: number
}): Session {
  const db = getDb()
  const id = opts.id ?? randomUUID()
  const row: SessionRow = {
    id,
    repo_id: opts.repoId,
    cc_session_id: opts.ccSessionId,
    title: null,
    title_source: null,
    pane_id: null,
    status: 'running',
    started_at: Date.now(),
    ended_at: null,
  }
  db.prepare(
    `INSERT INTO sessions
     (id, repo_id, cc_session_id, title, pane_id, status, started_at, ended_at, feature_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.repo_id,
    row.cc_session_id,
    row.title,
    row.pane_id,
    row.status,
    row.started_at,
    row.ended_at,
    opts.featureId ?? null,
  )

  try {
    const { command, args } = loginShellSpawn(opts.innerCmd)
    ptyManager.spawn({
      sessionId: row.id,
      command,
      args,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: sessionSpawnEnv(),
    })
  } catch (err) {
    db.prepare("UPDATE sessions SET status = 'crashed', ended_at = ? WHERE id = ?").run(
      Date.now(),
      row.id,
    )
    throw err
  }

  if (opts.initialCommand) {
    injectInitialCommandOnFirstData(row.id, opts.initialCommand)
  }

  return toSession(row)
}

// Spawn de sessão NOVA, extraído do handler `sessions:spawn` para ser chamável
// SEM renderer (ex.: job-runner no processo main, que não tem BrowserWindow). O
// broadcast de PTY é no-op com zero janelas, então nada aqui exige renderer.
// Mantém a MESMA ordem de validação/flags do handler original — o main é a
// autoridade que re-valida model/effort/advisor/permission contra as whitelists.
export function spawnSession(input: SpawnSessionInput): Session {
  const db = getDb()
  const repoId = input.repoId ?? null

  // Sessão avulsa (repoId null): roda no scratch dir, sem vínculo com repo.
  let cwd: string
  let defaultName: string
  if (repoId) {
    const repo = db
      .prepare('SELECT path, label FROM repos WHERE id = ?')
      .get(repoId) as RepoPathRow | undefined
    if (!repo) throw new Error(`repo not found: ${repoId}`)
    assertRepoDirExists(repo.path)
    cwd = repo.path
    defaultName = repo.label
  } else {
    cwd = resolveScratchDir()
    defaultName = QUICK_SESSION_NAME
  }

  const sessionId = randomUUID()
  const name = input.name?.trim() || defaultName

  if (!UUID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  const claudeCmd = resolveClaudeCommand()

  // Defesa em profundidade: só passa adiante o valor que estiver na whitelist.
  const model = resolveModel(input.model)
  const effort = resolveEffort(input.effort)
  const advisorModel = resolveAdvisor(input.advisorModel)

  // System-prompt anexado via --append-system-prompt-file vem de até três fontes
  // (arquitetura do repo, contexto da feature, systemPromptText) concatenadas num
  // único arquivo. NÃO bloqueia o spawn se algo falhar.
  let systemPromptFilePath: string | null = null
  try {
    const segments: string[] = []
    if (repoId) {
      const archContent = buildRepoArchitectureOrNull(repoId)
      if (archContent) segments.push(archContent)
    }
    if (input.featureId) {
      const featureContent = buildFeatureContextOrNull(input.featureId)
      if (featureContent) segments.push(featureContent)
    }
    if (input.systemPromptText?.trim()) {
      segments.push(input.systemPromptText)
    }
    if (segments.length > 0) {
      systemPromptFilePath = writeTempPromptFile(
        input.featureId ? `feat-${input.featureId}` : 'handoff',
        segments.join('\n\n---\n\n'),
      )
    }
  } catch (err) {
    console.error('[sessions] system-prompt injection failed:', err)
  }

  // Permission mode validado contra a whitelist; em modo autônomo aplica SEMPRE o
  // denylist destrutivo canônico (o renderer não consegue enfraquecê-lo).
  const permissionMode = resolvePermissionMode(input.permissionMode)
  const disallowedTools = resolveDisallowedTools(permissionMode, input.disallowedTools)

  // Id INTERNO (sessions.id) gerado aqui, antes do innerCmd: é ele que carimba
  // a identidade da sessão no mcp-config, e o mesmo valor vai pro startSession.
  const internalSessionId = randomUUID()

  const innerCmd = buildSpawnInnerCmd({
    claudeCmd,
    sessionId,
    name,
    mcpConfigArg: mcpConfigArg(internalSessionId),
    model,
    effort,
    advisorModel,
    systemPromptFilePath,
    permissionMode,
    disallowedTools,
    // Só a filha de handoff recebe --settings; o valor é a constante canônica do
    // main (o renderer não escolhe settings — só sinaliza que é filha).
    settingsJson: input.handoffChild ? HANDOFF_CHILD_SETTINGS_JSON : null,
    initialPrompt: input.initialPrompt,
  })

  const session = startSession({
    id: internalSessionId,
    ccSessionId: sessionId,
    repoId,
    cwd,
    innerCmd,
    featureId: input.featureId,
    initialCommand: input.initialCommand,
    cols: input.cols,
    rows: input.rows,
  })

  // O alias da filha é o ENDEREÇO do peer (SendMessage.to == o `-n <name>`).
  // Espelha em sessions.title como 'manual' pra o rename automático do Claude
  // Code não trocar o endereço debaixo do orquestrador (migration 030).
  if (input.handoffChild) {
    db.prepare("UPDATE sessions SET title = ?, title_source = 'manual' WHERE id = ?").run(
      name,
      session.id,
    )
    return { ...session, title: name, titleSource: 'manual' }
  }

  return session
}

// Status TERMINAIS do handoff: o trabalho acabou (bem ou mal) e não há filha a
// retomar. Todo o resto ('pending' | 'approved' | 'running' | 'needs_input' |
// 'interrupted') é recuperável — em especial running/needs_input ÓRFÃOS, que
// continuam com esse status até o reconcileStuck passar. Por isso o guard do
// resume é "não-terminal", não "== interrupted".
export const TERMINAL_HANDOFF_STATUSES: ReadonlySet<HandoffStatus> = new Set<HandoffStatus>([
  'done',
  'rejected',
  'failed',
])

export interface ResumeHandoffChildResult {
  handoff: Handoff
  session: Session
  // true = a PTY da filha JÁ estava viva; nada foi spawnado e `session` é a
  // sessão existente — ao chamador cabe só focá-la.
  alreadyRunning: boolean
}

// Retoma a sessão-filha de um handoff: re-spawna via `claude --resume` (recupera
// o histórico do transcript), preservando o ALIAS (-n, que é o endereço do peer)
// e o --settings da filha (sem ele as mensagens da mãe voltam a ficar `held` em
// silêncio), re-injeta o kickoff e re-aponta handoffs.child_session_id pro novo
// sessions.id via markRunning.
//
// Vive aqui (não em services/) porque reusa os helpers de spawn deste módulo —
// resolveClaudeCommand, mcpConfigArg, startSession, findTranscriptPath,
// injectInitialCommandOnFirstData. Mover o helper pra fora arrastaria todos eles
// (e o ciclo com mcp/server) sem ganho nenhum.
export function resumeHandoffChild(
  id: string,
  // kickoff: 1º turno da filha retomada, injetado SÓ quando o chamador o fornece.
  // Nada de default implícito: o relink do `sessions:resume` (usuário retomando
  // pelo switcher uma sessão que um dia foi filha) não pode fazer a sessão começar
  // a trabalhar sozinha. Quem pede trabalho passa o texto — o painel manda o
  // defaultResumeKickoff, e a adoção manda o dela (quem foi adotada nunca viu
  // briefing nenhum, e este é o único turno onde ela descobre o próprio apelido).
  opts: { cols?: number; rows?: number; kickoff?: string } = {},
): ResumeHandoffChildResult {
  const db = getDb()
  const handoff = handoffStore.get(id)
  if (!handoff) throw new Error(`Handoff não encontrado: ${id}`)
  if (TERMINAL_HANDOFF_STATUSES.has(handoff.status)) {
    throw new Error(
      `Só dá pra retomar um handoff não-terminal (status atual: ${handoff.status}).`,
    )
  }
  if (!handoff.childSessionId) {
    throw new Error('Handoff não tem sessão-filha registrada para retomar.')
  }

  // childSessionId é o sessions.id interno; o --resume precisa do cc_session_id
  // (o session-id do Claude, gravado no spawn original). O title é o alias
  // fixado no spawn — é o endereço do peer e tem que sobreviver ao resume.
  const childRow = db
    .prepare(
      `SELECT id, repo_id, cc_session_id, title, title_source, pane_id, status, started_at, ended_at
         FROM sessions WHERE id = ?`,
    )
    .get(handoff.childSessionId) as SessionRow | undefined

  // Guard de filha VIVA: spawnar de novo criaria um 2º PTY sobre o MESMO
  // transcript, e dois xterms atrelados à mesma PTY brigam pelo resize (o TUI
  // fica ilegível pra ambos). Se a PTY já está no ar, não spawna — devolve a
  // sessão existente pro chamador focar o pane que já existe.
  if (childRow && ptyManager.isRunning(handoff.childSessionId)) {
    return { handoff, session: toSession(childRow), alreadyRunning: true }
  }

  const ccSessionId = childRow?.cc_session_id
  if (!ccSessionId || !UUID_RE.test(ccSessionId)) {
    throw new Error('Sessão-filha do handoff sem cc_session_id válido — não há o que retomar.')
  }

  // Gate de resumibilidade: o transcript JSONL precisa existir no disco.
  const transcript = findTranscriptPath(ccSessionId)
  if (!transcript) {
    throw new Error('O transcript da sessão-filha não foi encontrado — não é possível retomá-la.')
  }

  const repoId = handoff.targetRepoId
  const repo = db
    .prepare('SELECT path, label FROM repos WHERE id = ?')
    .get(repoId) as RepoPathRow | undefined
  if (!repo) throw new Error(`repo-alvo do handoff não encontrado: ${repoId}`)

  // Alias fixado no spawn tem precedência sobre o título do transcript: trocar
  // o `-n` no resume mudaria o endereço do peer e o orquestrador perderia a filha.
  const name = childRow?.title || readTranscriptTitle(transcript) || `handoff: ${repo.label}`
  const claudeCmd = resolveClaudeCommand()
  // A filha retomada delega adiante (vira mãe em potencial) → carimbo próprio.
  const internalSessionId = randomUUID()

  // Permissão NÃO pode se perder no relance: sem `--permission-mode`, uma filha
  // que estava em `plan` (read-only) voltaria podendo editar, e uma autônoma
  // voltaria sem o denylist destrutivo. Resolvido pelas MESMAS funções do
  // spawnSession (whitelist + merge do DESTRUCTIVE_DENYLIST em modo autônomo).
  const permissionMode = resolvePermissionMode(permissionModeForHandoffMode(handoff.mode))
  const disallowedTools = resolveDisallowedTools(permissionMode, null)

  // --settings também no resume: a filha retomada precisa continuar aceitando
  // SendMessage (sem isso as mensagens da mãe voltariam a ficar `held`).
  const innerCmd = buildSpawnInnerCmd({
    claudeCmd,
    sessionId: ccSessionId,
    resume: true,
    name,
    mcpConfigArg: mcpConfigArg(internalSessionId),
    model: null,
    systemPromptFilePath: null,
    permissionMode,
    disallowedTools,
    settingsJson: HANDOFF_CHILD_SETTINGS_JSON,
  })

  const session = startSession({
    id: internalSessionId,
    ccSessionId,
    repoId,
    cwd: repo.path,
    innerCmd,
    featureId: handoff.featureId,
    initialCommand: opts.kickoff,
    cols: opts.cols,
    rows: opts.rows,
  })

  // O apelido é o ENDEREÇO do peer, e o relance cria uma LINHA NOVA em `sessions`
  // (novo sessions.id). Sem re-carimbá-lo aqui a linha nasceria com title null e:
  //   - o PRÓXIMO resume não acharia o apelido e cairia no título do transcript,
  //     trocando o endereço da filha sozinho;
  //   - activeSessionNames() (só olha `title` de sessões running) não veria o nome
  //     como ocupado e o próximo handoff poderia dar o MESMO apelido a outra filha;
  //   - o card do painel perderia o apelido.
  // 'manual' é o mesmo carimbo do spawn: impede o rename automático do Claude Code
  // de sobrescrever o endereço.
  db.prepare("UPDATE sessions SET title = ?, title_source = 'manual' WHERE id = ?").run(
    name,
    session.id,
  )
  const namedSession: Session = { ...session, title: name, titleSource: 'manual' }

  // Volta a running com a NOVA sessão-filha (startSession criou um novo
  // sessions.id). markRunning loga a transição via logEvent — e é ele que
  // RELINKA o handoff, sem o que a filha sumiria do painel.
  const updated = handoffStore.markRunning(id, namedSession.id)
  broadcast('handoff:updated', updated)
  return { handoff: updated, session: namedSession, alreadyRunning: false }
}

// Kickoff do resume pelo PAINEL (Crew Dock): retomar a tarefa e reportar via MCP.
// Explícito no chamador — ver o comentário de opts.kickoff em resumeHandoffChild.
export function defaultResumeKickoff(id: string): string {
  return `Retome a tarefa do handoff (handoffId="${id}") de onde parou. Ao terminar, chame a MCP tool handoff_report com handoffId="${id}".`
}

// O vínculo mãe→filha mora SÓ em handoffs.child_session_id. Dado o cc_session_id
// que o usuário pediu pra retomar, descobre se ele é a filha de um handoff ainda
// vinculado (não dispensado no Crew Dock) e recuperável. Consulta local (com
// getDb) pra não alargar a superfície do handoff-store.
function findRelinkableHandoff(ccSessionId: string): { id: string; status: HandoffStatus } | null {
  const row = getDb()
    .prepare(
      `SELECT h.id AS id, h.status AS status
         FROM handoffs h
         JOIN sessions s ON s.id = h.child_session_id
        WHERE s.cc_session_id = ? AND h.dismissed_at IS NULL
        ORDER BY h.updated_at DESC
        LIMIT 1`,
    )
    .get(ccSessionId) as { id: string; status: string } | undefined
  if (!row) return null
  if (TERMINAL_HANDOFF_STATUSES.has(row.status as HandoffStatus)) return null
  return { id: row.id, status: row.status as HandoffStatus }
}

let listenersAttached = false

export function registerSessionIpc(): void {
  if (!listenersAttached) {
    ptyManager.on('data', (e) => broadcast('pty:data', e))
    ptyManager.on('exit', (e) => {
      const db = getDb()
      db.prepare(
        "UPDATE sessions SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'",
      ).run(e.exitCode === 0 ? 'exited' : 'crashed', Date.now(), e.sessionId)
      broadcast('pty:exit', e)

      // Limpa as imagens temporárias coladas/arrastadas nesta sessão — a CLI já
      // as anexou na entrega; o path injetado não serve depois do exit.
      sweepImageTemps((name) => isSessionImageTempFile(name, e.sessionId))

      // Config MCP desta sessão (<userData>/mcp-sessions/<sessions.id>.json):
      // o e.sessionId é o próprio nome do arquivo. Contém o token — não fica
      // sobrando depois que a PTY morre.
      removeSessionMcpConfig(e.sessionId)

      // Para o watcher do transcript do Chat View desta sessão (evita leak de
      // chokidar/interval após a PTY morrer). No-op se ninguém estava observando.
      chatTranscriptService.unwatch(e.sessionId)

      // Reconciliação do handoff: se a sessão-filha morreu (exit/crash) sem ter
      // reportado conclusão (status ainda vivo: 'running' OU 'needs_input'), o
      // handoff ficaria preso pra sempre. failIfRunning transiciona ambos→failed
      // (não sobrescreve done/rejected). Inclui needs_input: uma filha que
      // perguntou e cuja PTY morreu de fato não pode ficar órfã.
      try {
        const linkedHandoff = handoffStore.getByChildSession(e.sessionId)
        if (
          linkedHandoff &&
          (linkedHandoff.status === 'running' || linkedHandoff.status === 'needs_input')
        ) {
          const reconciled = handoffStore.failIfRunning(
            linkedHandoff.id,
            `Sessão-filha encerrou (${e.exitCode === 0 ? 'exit' : 'crash'}) sem chamar handoff_report.`,
          )
          if (reconciled) broadcast('handoff:updated', reconciled)
        }
      } catch (err) {
        console.error('[sessions] handoff reconciliation on exit failed:', err)
      }

      // Scheduled Jobs NÃO capturam mais aqui: o runner headless (`claude -p`)
      // finaliza a JobRun direto pelo stdout, sem PTY. Este handler segue só para
      // sessões interativas (handoff/memória). Ver services/job-runner.ts.

      // Fase 8: sempre dispara o serviço de memória no exit. Ele resolve a feature
      // (manual > por-branch > fuzzy > auto-cria), persiste sessions.feature_id e
      // sintetiza — com guarda de atividade própria. featureId null => auto-resolver.
      try {
        const link = db
          .prepare('SELECT feature_id, cc_session_id, repo_id FROM sessions WHERE id = ?')
          .get(e.sessionId) as
          | { feature_id: string | null; cc_session_id: string | null; repo_id: string | null }
          | undefined
        // Sessão avulsa (repo_id null) fica fora da síntese de features — a
        // assinatura de onSessionExit exige repoId string (resolve por repo/branch).
        if (link && link.repo_id) {
          featureMemory.onSessionExit({
            sessionId: e.sessionId,
            ccSessionId: link.cc_session_id,
            repoId: link.repo_id,
            featureId: link.feature_id,
          })
        }
      } catch (err) {
        console.error('[sessions] feature synth trigger failed:', err)
      }
    })
    listenersAttached = true
  }

  // Corpo extraído para o módulo (spawnSession) — chamável sem renderer.
  ipcMain.handle('sessions:spawn', (_e, input: SpawnSessionInput) => spawnSession(input))

  // Registra a impl do seam usado pelo MCP (session_handoff spawna a filha DIRETO
  // no main, sem passar pelo renderer). O seam existe só pra quebrar o ciclo
  // mcp/tools → ipc/sessions → mcp/server → mcp/tools.
  setSpawnHandoffChild((input) =>
    spawnSession({
      repoId: input.repoId,
      name: input.name,
      featureId: input.featureId ?? undefined,
      initialPrompt: input.initialPrompt,
      systemPromptText: input.systemPromptText,
      permissionMode: (input.permissionMode ?? undefined) as SpawnSessionInput['permissionMode'],
      handoffChild: true,
    }),
  )

  ipcMain.handle('sessions:resume', (_e, input: ResumeSessionInput) => {
    const db = getDb()
    const repoId = input.repoId ?? null

    let cwd: string
    let defaultName: string
    if (repoId) {
      const repo = db
        .prepare('SELECT path, label FROM repos WHERE id = ?')
        .get(repoId) as RepoPathRow | undefined
      if (!repo) throw new Error(`repo not found: ${repoId}`)
      assertRepoDirExists(repo.path)
      cwd = repo.path
      defaultName = repo.label
    } else {
      cwd = resolveScratchDir()
      defaultName = QUICK_SESSION_NAME
    }
    if (!UUID_RE.test(input.ccSessionId)) {
      throw new Error(`invalid cc session id: ${input.ccSessionId}`)
    }

    // RELINK: se este cc_session_id é a filha de um handoff ainda vinculado, o
    // caminho genérico abaixo geraria um sessions.id novo que o handoff nunca
    // conheceria — child_session_id apontaria pra um id morto, a filha sumiria
    // do painel e voltaria SEM apelido e SEM --settings (parando de aceitar
    // mensagem da mãe, em silêncio), embora seguisse reportando pra ela.
    // Delegar ao resumeHandoffChild devolve alias + settings + permissões e faz o
    // markRunning re-apontar o vínculo. Sem match, segue o caminho normal.
    //
    // SEM kickoff de propósito: aqui quem retomou foi o USUÁRIO, pelo switcher.
    // Injetar o "retome a tarefa" faria a sessão começar a trabalhar sozinha sem
    // ninguém pedir. O relink de IDENTIDADE (apelido, --settings, markRunning)
    // acontece igual — o que não acontece é o disparo automático de trabalho.
    const linked = findRelinkableHandoff(input.ccSessionId)
    if (linked) {
      return resumeHandoffChild(linked.id, { cols: input.cols, rows: input.rows }).session
    }

    // Nome preferido: o já gravado no JSONL (custom/ai-title), senão o default.
    const transcript = findTranscriptPath(input.ccSessionId)
    const name = (transcript ? readTranscriptTitle(transcript) : null) || defaultName

    const claudeCmd = resolveClaudeCommand()
    // Sessão retomada também é mãe em potencial: ganha carimbo próprio.
    const internalSessionId = randomUUID()
    const innerCmd = `${claudeCmd} --resume ${input.ccSessionId} -n ${shquote(name)}${mcpConfigArg(internalSessionId)}`

    return startSession({
      id: internalSessionId,
      ccSessionId: input.ccSessionId,
      repoId,
      cwd,
      innerCmd,
      cols: input.cols,
      rows: input.rows,
    })
  })

  ipcMain.handle('sessions:is-resumable', (_e, ccSessionId: string): boolean => {
    return findTranscriptPath(ccSessionId) !== null
  })

  // Gate de UI: um handoff interrompido só é retomável se o transcript da filha
  // ainda existe no disco. Resolve o cc_session_id internamente (o renderer só tem
  // o childSessionId interno) e reusa findTranscriptPath — mesmo gate do resume.
  ipcMain.handle('handoffs:is-resumable', (_e, id: string): boolean => {
    const handoff = handoffStore.get(id)
    if (!handoff || handoff.status !== 'interrupted' || !handoff.childSessionId) return false
    const childRow = getDb()
      .prepare('SELECT cc_session_id FROM sessions WHERE id = ?')
      .get(handoff.childSessionId) as { cc_session_id: string | null } | undefined
    const ccSessionId = childRow?.cc_session_id
    if (!ccSessionId || !UUID_RE.test(ccSessionId)) return false
    return findTranscriptPath(ccSessionId) !== null
  })

  // Retomar a sessão-filha de um handoff: wrapper fino sobre resumeHandoffChild
  // (mesma função usada pelo relink do sessions:resume). Devolve o handoff
  // atualizado, como antes.
  ipcMain.handle(
    'handoffs:resume',
    (_e, id: string) => resumeHandoffChild(id, { kickoff: defaultResumeKickoff(id) }).handoff,
  )

  ipcMain.handle('sessions:list-by-repo', (_e, repoId: string): SessionSummary[] => {
    const db = getDb()
    const rows = db
      .prepare(
        'SELECT DISTINCT cc_session_id, title FROM sessions WHERE repo_id = ? AND cc_session_id IS NOT NULL',
      )
      .all(repoId) as { cc_session_id: string; title: string | null }[]

    const liveIndex = buildSessionsFileIndex()
    const summaries: SessionSummary[] = []

    for (const row of rows) {
      const ccSessionId = row.cc_session_id
      const transcript = findTranscriptPath(ccSessionId)
      if (!transcript) continue // sem transcript real — spawn vazio, descarta.

      const indexed = liveIndex.get(ccSessionId)
      const isLive = !!indexed && isPidAlive(indexed.pid)

      let name: string | null
      let lastActivityAt: number | null
      let status: SessionSummary['status']

      if (isLive) {
        name = indexed.name ?? readTranscriptTitle(transcript) ?? row.title
        lastActivityAt = indexed.updatedAt
        const mapped = mapStatus(indexed.status)
        status = mapped === 'starting' || mapped === 'ended' ? 'idle' : mapped
      } else {
        name = readTranscriptTitle(transcript) ?? row.title
        try {
          lastActivityAt = statSync(transcript).mtimeMs
        } catch {
          lastActivityAt = null
        }
        status = 'ended'
      }

      summaries.push({ ccSessionId, name, title: row.title, status, lastActivityAt, isLive })
    }

    summaries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    return summaries
  })

  ipcMain.handle('sessions:list-live-global', async (): Promise<LiveSessionInfo[]> => {
    const db = getDb()
    const liveIndex = buildSessionsFileIndex()
    const out: LiveSessionInfo[] = []

    // runningIds() = sessions.id (UUID) das PTYs vivas neste app. Para cada uma,
    // LEFT JOIN sessions→repos→projects — sessão avulsa (repo_id null) vem com
    // as colunas do repo/projeto nulas e vira repo: null no LiveSessionInfo.
    for (const sessionId of ptyManager.runningIds()) {
      const row = db
        .prepare(
          `SELECT
             s.cc_session_id AS cc_session_id,
             s.title AS session_title,
             s.title_source AS session_title_source,
             r.id AS repo_id, r.project_id AS repo_project_id, r.label AS repo_label,
             r.path AS repo_path, r.role AS repo_role, r.link_kind AS repo_link_kind,
             r.source AS repo_source, r.position AS repo_position, r.created_at AS repo_created_at,
             p.name AS project_name, p.icon AS project_icon, p.color AS project_color
           FROM sessions s
           LEFT JOIN repos r ON r.id = s.repo_id
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE s.id = ? AND s.cc_session_id IS NOT NULL`,
        )
        .get(sessionId) as LiveSessionJoinRow | undefined

      if (!row) continue
      const ccSessionId = row.cc_session_id

      const { repo, projectName, projectIcon, projectColor } = mapLiveSessionRepo(row)

      const transcript = findTranscriptPath(ccSessionId)
      const indexed = liveIndex.get(ccSessionId)
      const isLive = !!indexed && isPidAlive(indexed.pid)

      let status: LiveSessionInfo['status']
      let name: string | null
      let lastActivityAt: number | null
      if (isLive) {
        status = mapStatus(indexed!.status)
        name = indexed!.name ?? (transcript ? readTranscriptTitle(transcript) : null) ?? row.session_title
        lastActivityAt = indexed!.updatedAt
      } else {
        status = 'ended'
        name = (transcript ? readTranscriptTitle(transcript) : null) ?? row.session_title
        lastActivityAt = null
      }

      let title: string | null = null
      let lastText: string | null = null
      let tokens: LiveSessionInfo['tokens']
      if (transcript) {
        const tail = await readTail(transcript)
        if (tail) {
          const enrichment = deriveEnrichment(tail)
          title = enrichment.title
          lastText = enrichment.lastText
          tokens = enrichment.tokens
        }
      }

      // Rename manual do usuário vence o título derivado do transcript — chips
      // e panes re-attachados exibem o nome escolhido, não o automático do CC.
      if (row.session_title_source === 'manual' && row.session_title) {
        title = row.session_title
      }

      out.push({
        id: sessionId,
        ccSessionId,
        name,
        title,
        status,
        repo,
        projectName,
        projectIcon,
        projectColor,
        lastActivityAt,
        lastText,
        tokens,
        isResumable: transcript !== null,
        titleSource: row.session_title_source,
      })
    }

    out.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    return out
  })

  // Histórico global de sessões ENCERRADAS (filtro "Encerradas" do switcher):
  // linhas do DB sem PTY viva, dedup por cc_session_id (a mais recente vence) e
  // só com transcript no disco — sem transcript não há o que retomar nem exibir
  // (mesmo gate do sessions:list-by-repo). Todas as entradas são retomáveis.
  ipcMain.handle('sessions:list-ended-global', (): LiveSessionInfo[] => {
    const db = getDb()

    // ccSessionIds com PTY viva neste app: uma sessão retomada deixa linhas
    // antigas 'exited' no DB — não podem aparecer como encerradas de novo.
    const liveCc = new Set<string>()
    for (const sessionId of ptyManager.runningIds()) {
      const row = db
        .prepare('SELECT cc_session_id FROM sessions WHERE id = ?')
        .get(sessionId) as { cc_session_id: string | null } | undefined
      if (row?.cc_session_id) liveCc.add(row.cc_session_id)
    }

    const rows = db
      .prepare(
        `SELECT
           s.id AS session_id,
           s.cc_session_id AS cc_session_id,
           s.title AS session_title,
           s.title_source AS session_title_source,
           s.ended_at AS ended_at,
           r.id AS repo_id, r.project_id AS repo_project_id, r.label AS repo_label,
           r.path AS repo_path, r.role AS repo_role, r.link_kind AS repo_link_kind,
           r.source AS repo_source, r.position AS repo_position, r.created_at AS repo_created_at,
           p.name AS project_name, p.icon AS project_icon, p.color AS project_color
         FROM sessions s
         LEFT JOIN repos r ON r.id = s.repo_id
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE s.cc_session_id IS NOT NULL AND s.status != 'running'
         ORDER BY s.ended_at DESC
         LIMIT 200`,
      )
      .all() as (LiveSessionJoinRow & { session_id: string; ended_at: number | null })[]

    const seen = new Set<string>()
    const out: LiveSessionInfo[] = []
    for (const row of rows) {
      if (seen.has(row.cc_session_id) || liveCc.has(row.cc_session_id)) continue
      seen.add(row.cc_session_id)
      const transcript = findTranscriptPath(row.cc_session_id)
      if (!transcript) continue // spawn que nunca conversou — descarta.
      const { repo, projectName, projectIcon, projectColor } = mapLiveSessionRepo(row)
      out.push({
        id: row.session_id,
        ccSessionId: row.cc_session_id,
        name: readTranscriptTitle(transcript) ?? row.session_title,
        title: row.session_title_source === 'manual' ? row.session_title : null,
        status: 'ended',
        repo,
        projectName,
        projectIcon,
        projectColor,
        lastActivityAt: row.ended_at,
        lastText: null,
        isResumable: true,
        titleSource: row.session_title_source,
      })
      if (out.length >= 50) break
    }
    return out
  })

  ipcMain.handle('sessions:get-backlog', (_e, sessionId: string) => {
    return ptyManager.getBacklog(sessionId)
  })

  ipcMain.handle('sessions:write', (_e, sessionId: string, data: string) => {
    ptyManager.write(sessionId, data)
  })

  ipcMain.handle(
    'sessions:save-image',
    (_e, sessionId: string, bytes: ArrayBuffer | Uint8Array, mime: string): string =>
      saveImageTemp(sessionId, bytes, mime),
  )

  ipcMain.handle('sessions:resize', (_e, sessionId: string, cols: number, rows: number) => {
    ptyManager.resize(sessionId, cols, rows)
  })

  ipcMain.handle('sessions:kill', (_e, sessionId: string) => {
    ptyManager.kill(sessionId)
    getDb()
      .prepare(
        "UPDATE sessions SET status = 'closed_by_user', ended_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(Date.now(), sessionId)
  })

  ipcMain.handle('sessions:rename', (_e, sessionId: string, title: string) => {
    const trimmed = title.trim()
    // Rename via UI é sempre manual: marca a origem pra exibição nunca mais ser
    // sobrescrita pelo nome automático do Claude Code. Limpar o título volta a auto.
    getDb()
      .prepare('UPDATE sessions SET title = ?, title_source = ? WHERE id = ?')
      .run(trimmed.length > 0 ? trimmed : null, trimmed.length > 0 ? 'manual' : null, sessionId)
  })

  ipcMain.handle('sessions:list', () => {
    const rows = getDb()
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC')
      .all() as SessionRow[]
    return rows.map(toSession)
  })

  ipcMain.handle('session:activity:watch', (_e, ccSessionId: string) => {
    sessionActivityService.watch(ccSessionId)
  })

  ipcMain.handle('session:activity:unwatch', (_e, ccSessionId: string) => {
    sessionActivityService.unwatch(ccSessionId)
  })

  ipcMain.handle('session:activity:watch-global', () => {
    sessionActivityService.watchGlobal()
  })

  ipcMain.handle('session:activity:unwatch-global', () => {
    sessionActivityService.unwatchGlobal()
  })

  // Sinal leve renderer→main: qual sessão está no pane ativo/visível (null = nenhuma
  // ou fora da área de projetos). Consumido pela supressão de notificação.
  ipcMain.handle('sessions:renderer-focus', (_e, ccSessionId: string | null) => {
    setRendererFocusedSession(typeof ccSessionId === 'string' ? ccSessionId : null)
  })

  // ===== Chat View (Fase 5a): leitura/observação do transcript JSONL =====
  // O renderer só tem o sessionId INTERNO (sessions.id); resolvemos o cc_session_id
  // (id da sessão Claude Code) aqui — é ele que acha o transcript no disco.
  const resolveCcSessionId = (sessionId: string): string | null => {
    const row = getDb()
      .prepare('SELECT cc_session_id FROM sessions WHERE id = ?')
      .get(sessionId) as { cc_session_id: string | null } | undefined
    return row?.cc_session_id ?? null
  }

  ipcMain.handle('chat:get-transcript', async (_e, sessionId: string): Promise<ChatTranscript> => {
    const read = await chatTranscriptService.read(resolveCcSessionId(sessionId))
    return {
      sessionId,
      ccSessionId: read.ccSessionId,
      path: read.path,
      mtimeMs: read.mtimeMs,
      messages: read.messages,
      lastPlanFilePath: read.lastPlanFilePath,
    }
  })

  // Lê um arquivo de PLANO por path (read-only), pro card de aprovação pendente.
  // Segurança: o path vem do renderer — só aceitamos arquivos cujo realpath
  // (symlinks/.. resolvidos) esteja DENTRO de ~/.claude/plans/. Qualquer coisa
  // fora, inexistente ou ilegível → null (a UI cai no placeholder).
  ipcMain.handle('chat:read-plan-file', async (_e, filePath: string): Promise<string | null> => {
    if (typeof filePath !== 'string' || !filePath) return null
    try {
      const plansDir = await realpath(join(homedir(), '.claude', 'plans'))
      const expanded = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath
      const resolved = await realpath(expanded)
      if (!resolved.startsWith(plansDir + sep)) return null
      return await readFile(resolved, 'utf8')
    } catch {
      return null
    }
  })

  ipcMain.handle('chat:watch', (_e, sessionId: string) => {
    chatTranscriptService.watch(sessionId, resolveCcSessionId(sessionId))
  })

  ipcMain.handle('chat:unwatch', (_e, sessionId: string) => {
    chatTranscriptService.unwatch(sessionId)
  })
}
