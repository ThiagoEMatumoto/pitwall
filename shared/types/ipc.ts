// Tipos compartilhados main ↔ renderer via contextBridge.
// Toda feature nova adiciona seus tipos aqui e estende `Api` no preload.

// Tipos do Chat View (Fase 5) moram em ./chat e são re-exportados aqui pra que os
// consumidores sigam importando tudo de '@shared/types/ipc'.
export type { ChatMessage, ChatQuestion, ChatTranscript, ChatTranscriptUpdate } from './chat'
import type { ChatTranscript, ChatTranscriptUpdate } from './chat'
import type { ServiceId } from '../service-registry'
import type { Liveness, LoopIssue, MetricTone, PulseSource } from '../feature-loop'
// Re-export: os consumidores continuam importando tudo de '@shared/types/ipc'.
export type { Liveness, LoopIssue, MetricTone, PulseSource } from '../feature-loop'
// Reuniões v2: tipos moram em ./meetings e são re-exportados aqui.
export type {
  Meeting,
  MeetingActionItem,
  MeetingActionItemDecision,
  MeetingActionItemStatus,
  MeetingCaptureMode,
  MeetingDetail,
  MeetingEvent,
  MeetingFloatingAction,
  MeetingLiveState,
  MeetingSegment,
  MeetingSetupStatus,
  MeetingSpeaker,
  MeetingStatus,
  StartMeetingInput,
  UpdateMeetingInput,
} from './meetings'
import type {
  Meeting,
  MeetingActionItem,
  MeetingActionItemDecision,
  MeetingDetail,
  MeetingEvent,
  MeetingFloatingAction,
  MeetingLiveState,
  MeetingSetupStatus,
  StartMeetingInput,
  UpdateMeetingInput,
} from './meetings'
// Design Studio: tipos em ./design (o contrato é grande), re-exportados aqui
// pelo mesmo motivo; `design: DesignApi` liga a chave lá embaixo.
export type * from './design'
import type { DesignApi } from './design'

export type LinkKind = 'inside' | 'symlink' | 'external'

export interface Project {
  id: string
  name: string
  color: string | null
  icon: string | null
  vaultPath: string | null
  position: number
  createdAt: number
  updatedAt: number
}

export interface Repo {
  id: string
  projectId: string
  label: string
  path: string
  role: string | null
  linkKind: LinkKind
  source: string | null
  position: number
  createdAt: number
  // Posição livre no canvas do grafo de arquitetura (null = auto-layout).
  canvasX: number | null
  canvasY: number | null
  // Repo "hub": coordena/conecta os demais repos (vista de arquitetura).
  isHub: boolean
  // Origin do git (migration 027): URL do remote e branch default. Machine-independent
  // (sincroniza verbatim). null em repos blank/local-only sem remote.
  remoteUrl?: string | null
  defaultBranch?: string | null
}

// Repo registrado no DB cujo path não existe no disco desta máquina mas tem
// remote_url — candidato a auto-clone (Fase 1 do repo-sync).
export interface MissingRepo {
  repoId: string
  label: string
  path: string
  remoteUrl: string
}

// Resultado por-repo de um clone-missing. 'skipped' = o path já existia no disco
// na hora do clone (registrado noutra rodada); 'error' = falha no git clone.
export interface CloneMissingResult {
  repoId: string
  label: string
  path: string
  status: 'cloned' | 'skipped' | 'error'
  detail?: string
}

// Resultado de UMA unidade dentro do pull de um repo (branch atual, default, ou
// o pseudo-branch 'origin' quando o fetch do remote falha — ver comentário de
// PullRepoResult). Mesmo vocabulário de status que o agregado. `behind` = quantos
// commits o ref local ficou atrás do remote-tracking DEPOIS do pull (0 quando
// avançou, > 0 quando a branch foi pulada); ausente se algum ref não existe.
export interface BranchPullOutcome {
  branch: string
  status: 'pulled' | 'up-to-date' | 'skipped' | 'error'
  detail?: string
  behind?: number
}

// Resultado por-repo de um pull-all/pull-one (Fase 2 do repo-sync). Cada pull faz
// um `fetch origin --prune` incondicional (refresca todos os remote-tracking
// refs) e depois tenta o fast-forward de até DUAS branches — a atual (checkout,
// via `pull`) e a default (via `fetch origin def:def`, sem checkout, quando
// diverge da atual) — detalhadas em `branches`. O fetch só aparece em `branches`
// quando FALHA (entrada 'origin'). `status`/`detail` no topo são o AGREGADO
// (deriveOverallStatus em repo-pull.ts), preservado pra não quebrar a agregação
// de toasts existente em git.ts. 'skipped' carrega o motivo em detail
// ('dirty' | 'diverged' | 'untracked-collision' |
// 'checked-out-elsewhere[-dirty|-diverged|-untracked-collision]' | 'sem .git'); 'pulled' = algo
// avançou; 'up-to-date' = tudo já em dia; 'error' = alguma unidade falhou.
export interface PullRepoResult {
  repoId: string
  label: string
  path: string
  status: 'pulled' | 'up-to-date' | 'skipped' | 'error'
  detail?: string
  branches?: BranchPullOutcome[]
}

// Recorte por-repo da ÚLTIMA run persistida em repo_pull_runs, pra UI mostrar
// "quanto este repo está atrás" sem reprocessar git. `behind` = o maior atraso
// entre as branches do repo (a que mais dói é a que ficou mais pra trás);
// ausente quando nenhuma branch reportou atraso (ex.: fetch falhou). `reason` =
// o `detail` DESSA branch ('dirty' | 'diverged' | 'untracked-collision' |
// 'checked-out-elsewhere*' | ...)
// — é o que explica por que o atraso não zerou.
export interface RepoPullStatus {
  repoId: string
  status: PullRepoResult['status']
  behind?: number
  reason?: string
}

export interface LastPullRun {
  finishedAt: number
  trigger: 'auto' | 'manual'
  repos: RepoPullStatus[]
}

// ---- Grafo de dependências entre repos (multi-repo orchestration) ----

export type RepoDependencyKind =
  | 'calls-api'
  | 'shares-types'
  | 'depends-on'
  | 'deploys-to'
  | 'work-hub'
  | 'infra'
  | 'monorepo'
  | 'documents'
  | 'custom'

export interface RepoDependency {
  id: string
  fromRepoId: string
  toRepoId: string
  kind: RepoDependencyKind
  label: string | null
  createdAt: number
}

export interface CreateRepoDependencyInput {
  fromRepoId: string
  toRepoId: string
  kind: RepoDependencyKind
  label?: string | null
}

export interface UpdateRepoDependencyInput {
  id: string
  kind?: RepoDependencyKind
  label?: string | null
}

// Marca/desmarca um repo como hub na vista de arquitetura.
export interface SetRepoHubInput {
  repoId: string
  isHub: boolean
}

// Conecta um repo-hub a todos os outros repos do escopo (projeto, ou global se
// projectId ausente) com o kind dado. Idempotente.
export interface ConnectHubToAllInput {
  hubRepoId: string
  kind: RepoDependencyKind
  projectId?: string
}

// ---- Handoffs cross-repo (multi-repo orchestration) ----
//
// Uma sessão-mãe (Claude) pede pra abrir uma sessão-filha noutro repo com um
// prompt estruturado; a filha é despachada direto (sem gate humano, salvo a pref
// handoffs.requireApproval) e reporta um resumo de volta.
// status app-level: pending → approved → running → done | rejected | failed.
// needs_input é um estado VIVO (não-terminal) DENTRO de running: a filha
// levantou uma pergunta (handoff_ask) e aguarda a mãe responder (handoff_message,
// que a faz voltar pra running). Transições extras:
//   running ⇄ needs_input  (handoff_ask / handoff_message).
// SÓ a resposta da mãe encerra a pergunta. handoff_progress durante needs_input
// grava o passo mas PRESERVA pergunta e status — antes ele zerava
// pending_question, e 33% das perguntas morriam assim sem a mãe nunca ver.
// needs_input conta como in-flight (dedup/reconciliação) — NÃO é terminal.
//
// 'interrupted' é um estado RECUPERÁVEL: a sessão-filha morreu (PTY exit no boot
// ou na reconciliação periódica) SEM ter reportado erro real. Distinto de
// 'failed' (a filha reportou um erro de tarefa). NÃO conta como ativo (libera o
// dedup) mas permanece visível/listável e pode ser RETOMADO (re-spawn da
// filha → markRunning de volta pra running). A reconciliação (failIfRunning,
// reconcileStuck, boot sweep) passa a marcar 'interrupted' em vez de 'failed'.
export type HandoffStatus =
  | 'pending'
  | 'approved'
  | 'running'
  | 'needs_input'
  | 'done'
  | 'rejected'
  | 'failed'
  | 'interrupted'

// Modo de permissão com que a sessão-filha sobe:
//  'plan'        → read-only (--permission-mode plan): explora mas não edita.
//  'auto-edits'  → autônomo (--permission-mode acceptEdits) + denylist destrutivo.
//  'interactive' → comportamento legado (pergunta cada ação).
export type HandoffMode = 'plan' | 'auto-edits' | 'interactive'

// Feedback humano sobre a utilidade de um handoff concluído (instrumentação
// Fase 2): foi 'useful' (acertou), 'wrong' (errou o alvo) ou 'partial' (ajudou
// em parte). NULL = ainda sem avaliação.
export type HandoffOutcome = 'useful' | 'wrong' | 'partial'

export interface Handoff {
  id: string
  // NULLABLE: a MCP tool pode não saber o id da própria sessão.
  motherSessionId: string | null
  targetRepoId: string
  // Label do repo-alvo, resolvido via LEFT JOIN repos em list/get (null se o repo
  // foi removido). Evita um fetch extra de spawnContext no inbox/dialog.
  targetRepoLabel: string | null
  // NULLABLE: a sessão-filha só é criada na aprovação (wave posterior).
  childSessionId: string | null
  featureId: string | null
  task: string
  // Extras passados pela mãe (JSON serializado).
  contextJson: string | null
  composedPrompt: string
  status: HandoffStatus
  // Modo de permissão da filha (default 'interactive' p/ handoffs legados).
  mode: HandoffMode
  // Progresso não-terminal reportado pela filha via handoff_progress. NÃO implica
  // conclusão — done só vem de handoff_report.
  currentStep: string | null
  stepUpdatedAt: number | null
  // Pergunta aberta levantada pela filha via handoff_ask. Não-null ⇒ status
  // 'needs_input', aguardando a mãe responder (handoff_message limpa e retoma).
  pendingQuestion: string | null
  questionAskedAt: number | null
  summary: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  // Instrumentação (Fase 2). consumedAt: quando a mãe consumiu o resultado (leu o
  // done via handoff_result); NULL = nunca consumido. fromRepoId: repo de ORIGEM
  // (a mãe que delegou); NULL para handoffs legados/sem origem. outcome: feedback
  // humano sobre a utilidade; NULL = sem avaliação.
  consumedAt: number | null
  fromRepoId: string | null
  outcome: HandoffOutcome | null
  // Dispensa manual no Crew Dock: quando o humano tirou o card de vista. NÃO é
  // desfecho — `status` segue intocado (a filha pode até continuar viva). NULL =
  // nunca dispensado.
  dismissedAt: number | null
  // DERIVADO (não é coluna): este handoff interrompido pode ser retomado via
  // `claude --resume`? Só é true com status 'interrupted', filha atrelada e o
  // transcript dela ainda no disco — o mesmo gate do handoffs:is-resumable, agora
  // servido junto da lista pra o dock decidir quem fica sem um IPC por card.
  resumable: boolean
}

// Resolve o repo-alvo de um handoff + metadados do projeto, pra UI poder spawnar
// a sessão-filha via openSession.
export interface HandoffSpawnContext {
  repo: Repo
  projectName: string
  projectIcon: string | null
  projectColor: string | null
  // Alias da filha (`<nome>-<escopo>`, ex.: 'mauricio-auth-refactor'), resolvido
  // no MAIN contra as sessões vivas. Vira o `-n <name>` do spawn e, por tabela, o
  // endereço do SendMessage. Só usado no caminho com gate humano ligado — no
  // caminho normal o main gera e spawna sozinho.
  alias: string
}

export interface CreateHandoffInput {
  // Id pré-gerado (opcional): a MCP gera o id ANTES de compor o prompt, pois o
  // prompt embute o handoffId pra a filha reportar de volta. Se omitido, o store
  // gera um.
  id?: string
  motherSessionId?: string | null
  targetRepoId: string
  // Repo de ORIGEM (a mãe que delegou). Persistido pra instrumentação cross-repo
  // (de onde→pra onde). Opcional: a MCP pode não ter o fromRepo resolvido.
  fromRepoId?: string | null
  featureId?: string | null
  task: string
  contextJson?: string | null
  composedPrompt: string
  // Modo de permissão da filha; omitido = 'interactive'.
  mode?: HandoffMode
}

// ---- Passagem de bastão (baton) ----

//
// Quando o contexto de uma sessão enche, o trabalho continua numa sessão LIMPA
// que recebe o briefing destilado da antecessora. A antecessora NÃO é encerrada —
// quem a encerra é o humano, quando quiser.

export interface DistillBatonInput {
  // cc_session_id da sessão a destilar.
  ccSessionId: string
  // Contexto que o humano acrescenta antes de destilar; prevalece sobre o inferido
  // do transcript.
  note?: string
}

export interface PassBatonInput {
  // cc_session_id da ANTECESSORA.
  ccSessionId: string
  // Briefing já destilado E editado/aprovado pelo humano — o main não destila de
  // novo (isso descartaria a edição dele).
  briefing: string
  // Instrução extra do humano para o primeiro turno da sucessora.
  task?: string
  cols?: number
  rows?: number
}

export interface PassBatonResult {
  session: Session
  // Handoff cujo papel a sucessora herdou; null = a antecessora não era filha de
  // handoff e a sucessora nasce solta.
  handoff: Handoff | null
  // Apelido (endereço de peer) com que a sucessora subiu; null quando não há herança.
  alias: string | null
  // true = o apelido da antecessora seguia ocupado (ela continua viva) e a sucessora
  // subiu com OUTRO endereço.
  aliasChanged: boolean
}

// Criação MANUAL de sessão-filha pelo diálogo de nova sessão — o caminho sem
// sessão-mãe pedindo por MCP. O renderer manda o mínimo; o main compõe o briefing
// e resolve o apelido.
export interface CreateManualHandoffInput {
  repoId: string
  // Mãe escolhida explicitamente no picker (sessions.id interno).
  motherSessionId: string
  task: string
  featureId?: string
  mode?: HandoffMode
}

// Handoff recém-criado + apelido já resolvido. O alias NÃO vive no registro do
// handoff: ele só se fixa (em sessions.title) quando a filha sobe — e quem sobe a
// filha, neste caminho, é o renderer.
export interface ManualHandoffCreated {
  handoff: Handoff
  alias: string
}

// ---- Adoção de sessão já aberta ----
//
// "Esta sessão é filha de X": a sessão que já está numa aba passa a viver no
// painel da equipe. Ser filha endereçável depende de flags fixadas no EXEC do
// processo (o `-n <alias>` e o accept-inbound do cross-session), então adotar
// RELANÇA a sessão por --resume — o histórico volta, o turno em andamento não.
export interface AdoptSessionInput {
  // Sessão a adotar (sessions.id interno).
  sessionId: string
  // Mãe escolhida explicitamente no picker (sessions.id interno).
  motherSessionId: string
  // Escopo combinado — é dele que sai o apelido, o endereço do peer.
  task: string
  featureId?: string
  mode?: HandoffMode
}

export interface AdoptedSession {
  handoff: Handoff
  alias: string
  // sessions.id da sessão RELANÇADA: o --resume cria um registro novo, e é ele
  // que o handoff passa a apontar.
  childSessionId: string
}

// Pasta que existe fisicamente dentro do vault de um projeto mas ainda não foi
// registrada como repo. Surge quando o usuário clona/cria a pasta por fora do app.
export interface UntrackedFolder {
  name: string
  path: string
}

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}

export interface FsFile {
  path: string
  content: string
}

export interface Session {
  id: string
  // null = sessão avulsa (sem repo), rodando no scratch dir.
  repoId: string | null
  ccSessionId: string | null
  title: string | null
  // Origem do title: 'manual' (rename do usuário) tem precedência sobre o nome
  // automático do Claude Code na exibição; null/'auto' segue a precedência antiga.
  titleSource: 'manual' | 'auto' | null
  paneId: string | null
  status: 'running' | 'exited' | 'crashed' | 'closed_by_user'
  startedAt: number
  endedAt: number | null
}

export interface CreateProjectInput {
  name: string
  color?: string | null
  icon?: string | null
  vaultPath?: string | null
}

export interface CreateRepoInput {
  projectId: string
  label: string
  path: string
  role?: string | null
  linkKind?: LinkKind
  source?: string | null
}

export interface UpdateProjectInput {
  id: string
  name?: string
  color?: string | null
  icon?: string | null
  vaultPath?: string | null
}

export interface UpdateRepoInput {
  id: string
  label?: string
  role?: string | null
}

export interface ReorderReposInput {
  projectId: string
  repoIds: string[]
}

// Nível de esforço de raciocínio (--effort). Espelha a whitelist do main.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Modelo do advisor tool (--advisor <model>): segunda opinião de um modelo mais
// forte em pontos-chave da sessão. Experimental — só funciona na Anthropic API
// direta (não Bedrock/Vertex/Foundry). Espelha a whitelist do main.
export type AdvisorModel = 'opus' | 'sonnet' | 'fable'

// Modo de permissão da sessão (--permission-mode). Espelha EXATAMENTE os choices
// da CLI claude: default (pergunta tudo), plan (read-only), acceptEdits (edita
// sem perguntar), auto, bypassPermissions (pula tudo), dontAsk. Validado contra
// whitelist no main; os modos autônomos recebem o denylist destrutivo no spawn.
export type PermissionMode =
  'default' | 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk'

export interface SpawnSessionInput {
  // Ausente/null = sessão avulsa: cwd vira o scratch dir (pref scratch_dir).
  repoId?: string | null
  name?: string
  featureId?: string
  // Comando inicial injetado no REPL do claude após o spawn (ex.: '/review' ou
  // o nome de uma skill). Escrito no PTY no primeiro `data` da sessão, não como
  // flag de CLI — slash commands são input interativo do REPL.
  initialCommand?: string
  // Prompt inicial entregue como POSICIONAL no comando de spawn (`claude "<prompt>"`),
  // não injetado no PTY. Em modo interativo o claude auto-submete esse posicional e
  // roda o 1º turno — caminho confiável pro handoff em background (a colagem no PTY
  // é descartada quando ninguém dá resize no TUI). Distinto de initialCommand.
  initialPrompt?: string
  // Modelo inicial da sessão (alias do registro canônico em shared/models.ts:
  // 'fable' | 'opus' | 'sonnet' | 'haiku' | 'opusplan'). 'opusplan' é roteamento
  // híbrido nativo da CLI: Opus no plan mode, troca pra Sonnet ao sair pra
  // execução — não é model id de API e nunca aparece em transcripts. Validado
  // contra whitelist no main e anexado ao spawn como `--model <alias>`.
  // Ausente = default do claude.
  model?: string
  // Nível de esforço inicial passado como `--effort <level>`. Validado contra
  // whitelist no main. Ausente = default do claude.
  effort?: EffortLevel
  // Modelo do advisor tool (--advisor <model>), ligando a segunda opinião em
  // pontos-chave da sessão. Validado contra whitelist no main. Ausente/undefined
  // = advisor desligado (sem flag). Experimental — só Anthropic API direta.
  advisorModel?: AdvisorModel
  // Texto de system-prompt a ANEXAR via --append-system-prompt-file (arquivo
  // temp). Usado pelo fluxo de handoff pra entregar o prompt multi-linha íntegro
  // (em vez de injetá-lo no REPL, onde os \n viram Enter). Se também houver
  // featureId, os dois conteúdos são concatenados num único arquivo.
  systemPromptText?: string
  // Modo de permissão inicial passado como `--permission-mode <mode>`. Validado
  // contra whitelist no main. Ausente = default do claude (pergunta tudo).
  permissionMode?: PermissionMode
  // Ferramentas a NEGAR via `--disallowedTools <specs...>` (ex.: 'Bash(rm:*)').
  // Denylist destrutivo do handoff auto-edits. Cada spec é validado/escapado.
  disallowedTools?: string[]
  // Marca o spawn como sessão-filha de handoff. Efeitos (decididos no MAIN, não
  // aqui — o renderer não consegue injetar settings arbitrários):
  //  1. `--settings '{"crossSessionInbound":"accept"}'` POR filha, pra ela receber
  //     SendMessage do orquestrador (sem isso a mensagem fica `held` em silêncio);
  //  2. `name` espelhado em sessions.title com title_source='manual' — o alias é o
  //     ENDEREÇO do peer e o rename automático do Claude Code não pode sobrescrevê-lo.
  handoffChild?: boolean
  cols?: number
  rows?: number
}

export type FeatureStatus = 'pending' | 'in-progress' | 'blocked' | 'done' | 'paused'
export type FeatureSynthMode = 'auto' | 'manual' | 'threshold'
// 'manual' = criada pelo usuário; 'auto' = auto-criada pela resolução de sessões.
// Rascunho oculto = origin='auto' E 0 session records (derivado, sem flag mutável).
export type FeatureOrigin = 'manual' | 'auto'

export interface FeatureRepoLink {
  repoId: string
  branch: string | null
  worktreePath: string | null
}

// Índice (campos do frontmatter) + o corpo Markdown. O `.md` é a fonte de
// verdade do corpo; o SQLite re-deriva os campos do frontmatter via watcher.
export interface Feature {
  id: string
  projectId: string
  slug: string
  title: string
  status: FeatureStatus
  objective: string | null
  docPath: string
  synthMode: FeatureSynthMode
  model: string | null
  repos: FeatureRepoLink[]
  // Vive só no SQLite (como archivedAt) — não vai pro frontmatter do `.md`.
  origin: FeatureOrigin
  // COUNT de feature_links da feature (0 = "sem OKR"). Onda 0: dado que não
  // existia em nenhuma projeção — causa raiz da sub-linkagem.
  objectiveLinkCount: number
  // Estampada quando o repo da sessão é o próprio claude-manager (Onda 3 —
  // separação app-dev). Vive só no SQLite, mesmo padrão de origin.
  isAppDev: boolean
  // Foco da parede (migration 043). OPCIONAIS no tipo porque projeções antigas
  // (overview-store) e mocks não os preenchem — o store SEMPRE preenche, então
  // a UI pode ler `pinned === true` / `focusRank ?? null` sem defensiva.
  pinned?: boolean
  /** Posição manual na parede; null/ausente = ordena por atividade, como antes. */
  focusRank?: number | null
  /** Candidato a duplicata (features.duplicate_of); null = sem suspeita. */
  duplicateOf?: string | null
  /** Afinidade 0..1 que gerou a suspeita. */
  duplicateScore?: number | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  archivedAt: number | null
  // Corpo Markdown do `.md` (sem o frontmatter). Preenchido em `get`; ausente em `list`.
  body?: string
}

// Feature do índice + stats de atividade real. Usado pelo board e pela
// listagem (ordenação/badges); sem corpo, igual a list().
export interface FeatureWithStats extends Feature {
  sessionCount: number
  // Registros em feature_session_records (0 = "sem registros").
  recordCount: number
  // session_at do registro mais recente; null sem registros. A listagem ordena
  // por COALESCE(lastRecordAt, updatedAt) DESC (atividade real > metadado).
  lastRecordAt: number | null
}

// ---- Foco da parede de features (Fase 4) ----

export interface FeatureFocus {
  featureId: string
  pinned: boolean
  focusRank: number | null
}

// Patch parcial: campo ausente fica como está (o botão de pin não conhece o
// rank; o arrasto não mexe no pin).
export interface SetFeatureFocusInput {
  featureId: string
  pinned?: boolean
  focusRank?: number | null
}

// Suspeita de duplicata JÁ RESOLVIDA pro consumo da UI: o título do candidato
// vem junto porque a issue só carrega texto, e a ação ("mesclar") precisa do id.
export interface FeatureDuplicateSuspect {
  candidateId: string
  title: string | null
  score: number | null
}

export interface MergeFeatureDuplicateInput {
  /** O rascunho suspeito — é ARQUIVADO, nunca apagado. */
  sourceId: string
  /** A feature que absorve sessões, registros e repos. */
  targetId: string
}

export interface FeatureListStatsOpts {
  includeArchived?: boolean
  includeDrafts?: boolean
}

export interface CreateFeatureInput {
  projectId: string
  title: string
  objective?: string | null
  status?: FeatureStatus
  synthMode?: FeatureSynthMode
  model?: string | null
  repos?: FeatureRepoLink[]
  // Default 'manual'. A resolução automática de sessões passa 'auto' (rascunho
  // oculto até a feature ganhar o 1º session record).
  origin?: FeatureOrigin
  // Default false. resolveFeature passa true quando a sessão roda no repo do
  // próprio claude-manager (Onda 3 — separação app-dev).
  isAppDev?: boolean
  // Seções iniciais do corpo (preenchem o esqueleto de headings).
  overview?: string
  businessRules?: string
  approach?: string
}

export interface UpdateFeatureInput {
  id: string
  title?: string
  status?: FeatureStatus
  objective?: string | null
  synthMode?: FeatureSynthMode
  model?: string | null
}

export interface SetFeatureReposInput {
  id: string
  repos: FeatureRepoLink[]
}

export interface FeatureGroup {
  projectId: string
  features: Feature[]
}

// Emitido quando a síntese autônoma (fase 8) falha (timeout, exit≠0, output
// inválido). O `.md` não é tocado nesse caso; o evento só informa a UI.
export interface FeatureSynthError {
  featureId: string
  message: string
  at: number
}

// Resultado do backfill retroativo (reprocessamento de sessões já encerradas).
export interface FeatureBackfillResult {
  created: number
  linked: number
  skipped: number
}

// ---- Loop da feature: pulso, ledger e métricas (migration 042) ----
//
// Camada de persistência do módulo puro `shared/feature-loop.ts`: aqui ficam as
// entidades como saem do SQLite (camelCase mapeando as colunas snake_case);
// lá ficam as DERIVAÇÕES (liveness, issues, tom). Nada de `liveness` é gravado.

export interface FeaturePulse {
  id: string
  featureId: string
  body: string
  source: PulseSource
  sessionId: string | null
  createdAt: number
}

export interface SetPulseInput {
  featureId: string
  body: string
  source?: PulseSource
  sessionId?: string | null
}

export interface FeatureLedgerEntry {
  featureId: string
  entryId: string
  kind: string | null
  title: string
  body: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

// Upsert "as-of": é o estado COMPLETO da entrada agora, não um patch. Campo
// omitido não é "mantém o anterior" — em particular, `body` ausente/vazio
// arquiva a entrada (o "corpo vazio apaga" do modelo).
export interface AppendLedgerInput {
  featureId: string
  entryId: string
  title?: string
  kind?: string | null
  body?: string | null
}

export interface ListLedgerOpts {
  includeArchived?: boolean
  limit?: number
}

export interface FeatureMetricColumn {
  featureId: string
  columnKey: string
  label: string | null
  unit: string | null
  target: number | null
  floor: number | null
  baseline: number | null
  direction: ProgressDirection | null
  isHeadline: boolean
  alarm: boolean
}

export interface DeclareMetricInput {
  featureId: string
  columnKey: string
  label?: string | null
  unit?: string | null
  target?: number | null
  floor?: number | null
  baseline?: number | null
  direction?: ProgressDirection | null
  isHeadline?: boolean
  alarm?: boolean
}

export interface FeatureMetricPoint {
  id: string
  featureId: string
  columnKey: string
  at: number
  value: number | null
  note: string | null
}

export interface RecordMetricPointInput {
  featureId: string
  columnKey: string
  at: number
  value: number | null
  note?: string | null
}

// Coluna + série, com o tom do ponto mais recente já resolvido por
// `metricTone` (a UI não recalcula regra de negócio).
export interface FeatureMetricSeries {
  column: FeatureMetricColumn
  points: FeatureMetricPoint[]
  latest: FeatureMetricPoint | null
  tone: MetricTone
}

// Tudo que a UI do loop precisa numa leitura só. `liveness`/`issues` são
// derivados na hora (nunca lidos de coluna).
export interface FeatureLoopSnapshot {
  featureId: string
  pulse: FeaturePulse | null
  liveness: Liveness
  issues: LoopIssue[]
  ledger: FeatureLedgerEntry[]
  metrics: FeatureMetricSeries[]
  lastActivityAt: number
  // Foco (Fase 4): vem no snapshot pra a tela da feature não precisar de uma
  // segunda chamada só pra saber se o card está fixado.
  pinned: boolean
  focusRank: number | null
  /**
   * O candidato por trás da issue `duplicate_suspect` (null quando não há).
   * A issue só carrega mensagem; a AÇÃO de mesclar precisa do id — é aqui.
   */
  duplicateSuspect: FeatureDuplicateSuspect | null
}

// ---- Vínculos Feature → Objetivo/KR (Fase 3) ----

export type FeatureLinkTargetType = 'objective' | 'key_result'

// Vínculo polimórfico feature → objetivo/KR (sem FK real em targetId, espelho
// de TaskLink). Alimenta o rollup de objetivos/KRs auto_rollup.
export interface FeatureObjectiveLink {
  targetType: FeatureLinkTargetType
  targetId: string
}

export interface SetFeatureObjectiveLinksInput {
  featureId: string
  links: FeatureObjectiveLink[]
}

// Projeção enxuta de uma feature vinculada, pronta pra UI de Objetivos.
// progress = % de tarefas done da feature (ou 100 se status done sem tarefas;
// null = indeterminado, fica fora do rollup do pai).
export interface LinkedFeatureSummary {
  id: string
  title: string
  status: FeatureStatus
  progress: number | null
  // Feature arquivada depois de vinculada (Onda 1): sai do rollup (já era o
  // caso), mas continua aparecendo aqui sinalizada como "órfã de contexto" em
  // vez de sumir em silêncio da lista.
  archived: boolean
}

// ---- Objetivos / Key Results (camada genérica de OKRs, Fase 1) ----

export type ObjectiveKind = 'okr' | 'personal_goal' | 'project' | 'custom'
export type ObjectiveStatus = 'active' | 'paused' | 'done' | 'archived'
export type KeyResultStatus = 'active' | 'paused' | 'done' | 'cancelled'
export type ProgressMode = 'auto_rollup' | 'metric' | 'manual'
export type ProgressDirection = 'increase' | 'decrease' | 'maintain'

// Persistência SQLite-only (sem espelho .md). tags são strings opacas (JSON na
// coluna); progresso NÃO é persistido — calculado via shared/progress.ts.
export interface Objective {
  id: string
  title: string
  description: string | null
  kind: ObjectiveKind
  status: ObjectiveStatus
  period: string | null
  startDate: number | null
  endDate: number | null
  parentObjectiveId: string | null
  priority: 'low' | 'medium' | 'high' | null
  owner: string | null
  tags: string[]
  progressMode: ProgressMode
  // Escala 0–100 (null = indeterminado).
  progressManual: number | null
  baseline: number | null
  current: number | null
  target: number | null
  unit: string | null
  direction: ProgressDirection | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  archivedAt: number | null
}

export interface KeyResult {
  id: string
  objectiveId: string
  title: string
  owner: string | null
  status: KeyResultStatus
  // Peso no rollup do objetivo (default 1 quando null).
  weight: number | null
  progressMode: ProgressMode
  progressManual: number | null
  baseline: number | null
  current: number | null
  target: number | null
  unit: string | null
  direction: ProgressDirection | null
  createdAt: number
  updatedAt: number
}

// Objective enriquecido com o progresso calculado (0–100; null = indeterminado,
// a UI mostra "—").
export interface ObjectiveWithProgress extends Objective {
  progress: number | null
}

// Detalhe: objetivo + KRs (cada um com seu progresso calculado) + features
// vinculadas (Fase 3) — no nível do objetivo e por KR.
export interface ObjectiveDetail extends ObjectiveWithProgress {
  keyResults: Array<
    KeyResult & {
      progress: number | null
      linkedFeatures: LinkedFeatureSummary[]
    }
  >
  linkedFeatures: LinkedFeatureSummary[]
}

export interface CreateObjectiveInput {
  title: string
  description?: string | null
  kind: ObjectiveKind
  status?: ObjectiveStatus
  period?: string | null
  startDate?: number | null
  endDate?: number | null
  parentObjectiveId?: string | null
  priority?: 'low' | 'medium' | 'high' | null
  owner?: string | null
  tags?: string[]
  progressMode?: ProgressMode
  progressManual?: number | null
  baseline?: number | null
  current?: number | null
  target?: number | null
  unit?: string | null
  direction?: ProgressDirection | null
}

export interface UpdateObjectiveInput {
  id: string
  title?: string
  description?: string | null
  kind?: ObjectiveKind
  status?: ObjectiveStatus
  period?: string | null
  startDate?: number | null
  endDate?: number | null
  parentObjectiveId?: string | null
  priority?: 'low' | 'medium' | 'high' | null
  owner?: string | null
  tags?: string[]
  progressMode?: ProgressMode
  progressManual?: number | null
  baseline?: number | null
  current?: number | null
  target?: number | null
  unit?: string | null
  direction?: ProgressDirection | null
}

export interface CreateKeyResultInput {
  objectiveId: string
  title: string
  owner?: string | null
  status?: KeyResultStatus
  weight?: number | null
  progressMode?: ProgressMode
  progressManual?: number | null
  baseline?: number | null
  current?: number | null
  target?: number | null
  unit?: string | null
  direction?: ProgressDirection | null
}

export interface UpdateKeyResultInput {
  id: string
  title?: string
  owner?: string | null
  status?: KeyResultStatus
  weight?: number | null
  progressMode?: ProgressMode
  progressManual?: number | null
  baseline?: number | null
  current?: number | null
  target?: number | null
  unit?: string | null
  direction?: ProgressDirection | null
}

export interface ObjectiveListFilter {
  kind?: ObjectiveKind
  status?: ObjectiveStatus
  tags?: string[]
  search?: string
}

// ---- Tarefas (Fase 2) ----

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskParentType = 'objective' | 'key_result' | 'feature'
// 'manual' = criada pelo usuário (IPC); 'auto' = criada via MCP tool task_create
// (chamada por uma sessão Claude Code). Mesmo padrão de FeatureOrigin.
export type TaskOrigin = 'manual' | 'auto'

// Vínculo polimórfico tarefa → parent (sem FK real em parentId; tarefa
// standalone = sem vínculos). Alimenta o rollup de KRs/objetivos auto_rollup.
export interface TaskLink {
  parentType: TaskParentType
  parentId: string
}

// Persistência SQLite-only (mesmo padrão de Objective): tags são strings
// opacas (JSON na coluna); position REAL p/ ordenação manual.
export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority | null
  dueDate: number | null
  startedAt: number | null
  completedAt: number | null
  tags: string[]
  notes: string | null
  position: number
  links: TaskLink[]
  origin: TaskOrigin
  // Sessão MCP que criou a task (quando conhecida). O server MCP hoje é
  // stateless/compartilhado (electron/main/services/mcp/server.ts) — sem
  // identificação de sessão por request — então fica null por enquanto.
  sourceSessionId: string | null
  createdAt: number
  updatedAt: number
}

export interface CreateTaskInput {
  title: string
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority | null
  dueDate?: number | null
  tags?: string[]
  notes?: string | null
  position?: number
  links?: TaskLink[]
  // Default 'manual'. O handler MCP de task_create passa 'auto'.
  origin?: TaskOrigin
  sourceSessionId?: string | null
}

export interface UpdateTaskInput {
  id: string
  title?: string
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority | null
  dueDate?: number | null
  tags?: string[]
  notes?: string | null
  position?: number
}

export interface TaskListFilter {
  status?: TaskStatus
  priority?: TaskPriority
  tag?: string
  search?: string
  parentType?: TaskParentType
  parentId?: string
}

// ---- Dashboard / visão hierárquica (Fase 4) ----

// Projeção enxuta de tarefa pros nós da árvore do dashboard.
export interface OverviewTaskSummary {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority | null
  dueDate: number | null
}

// Mesmo shape de LinkedFeatureSummary — alias nomeado pro contexto do overview.
export type OverviewFeatureSummary = LinkedFeatureSummary

export interface OverviewKeyResultNode {
  keyResult: KeyResult
  progress: number | null
  tasks: OverviewTaskSummary[]
  linkedFeatures: OverviewFeatureSummary[]
}

export interface OverviewObjectiveNode {
  objective: Objective
  progress: number | null
  keyResults: OverviewKeyResultNode[]
  // Tarefas vinculadas direto ao objetivo (sem passar por KR).
  directTasks: OverviewTaskSummary[]
  linkedFeatures: OverviewFeatureSummary[]
  // Sub-objetivos via parent_objective_id.
  children: OverviewObjectiveNode[]
}

// Referência resolvida (com título do pai) de uma tarefa pendente, p/ exibição.
export interface OverviewTaskParentRef {
  type: TaskParentType
  id: string
  title: string
}

// Tarefa pendente (todo|in_progress|blocked) com os parents resolvidos.
export type OverviewPendingTask = Task & { parents: OverviewTaskParentRef[] }

export interface OverviewCounts {
  activeObjectives: number
  pendingTasks: number
  // dueToday = due_date dentro do dia local corrente; overdue = antes do
  // começo do dia local (ambos só sobre tarefas pendentes).
  dueToday: number
  overdue: number
}

// Feature em andamento com a atividade real de sessões (card da Home):
// lastSessionAt = MAX(COALESCE(ended_at, started_at)) das sessions com
// feature_id apontando pra ela; null = nenhuma sessão linkada ainda.
export interface OverviewFeatureActivity {
  id: string
  title: string
  status: FeatureStatus
  projectId: string
  lastSessionAt: number | null
  sessionCount: number
  // COUNT de feature_links (0 = "sem OKR") — mesma projeção de Feature.objectiveLinkCount.
  objectiveLinkCount: number
}

// Payload agregado do dashboard: a árvore inteira numa chamada IPC (evita N+1
// de get/listByParent a partir do renderer).
export interface OverviewData {
  // Raízes (parent null) com status active|paused|done — archived fica fora.
  objectives: OverviewObjectiveNode[]
  // Pendentes ordenadas: prioridade (high>medium>low>null) → dueDate asc
  // (null por último) → position.
  pending: OverviewPendingTask[]
  counts: OverviewCounts
  // Features ativas (in-progress|blocked|paused, não-arquivadas) com atividade
  // de sessões, ordenadas pela última sessão (fallback updated_at) desc.
  features: OverviewFeatureActivity[]
}

export interface ResumeSessionInput {
  // null = sessão avulsa: retoma no scratch dir.
  repoId: string | null
  ccSessionId: string
  cols?: number
  rows?: number
}

export interface SessionSummary {
  /** `sessions.id` interno — chave do índice sessão → feature no renderer. */
  id: string
  ccSessionId: string
  /** Feature vinculada, quando há (vem da mesma linha, sem consulta extra). */
  featureId: string | null
  name: string | null
  // Título persistido no DB (rename manual/auto), distinto do name derivado do
  // transcript — fallback de exibição/busca quando o name é nulo.
  title: string | null
  status: 'working' | 'waiting' | 'idle' | 'ended'
  lastActivityAt: number | null
  isLive: boolean
}

/**
 * Sessão vinculada a uma feature — histórico de trabalho do painel da feature.
 * Distinto de SessionSummary (que é por repo e deriva tudo do transcript): aqui
 * o eixo é a linha do banco, porque é ela que carrega o vínculo com a feature.
 */
export interface FeatureSessionSummary {
  /** sessions.id interno (o id que o PTY manager conhece). */
  id: string
  /** session-id do Claude — é este valor que o `sessions.resume` consome. */
  ccSessionId: string | null
  repoId: string | null
  /** Título persistido (rename manual/auto) com fallback no título do transcript. */
  title: string | null
  titleSource: 'manual' | 'auto' | null
  status: 'running' | 'exited' | 'crashed' | 'closed_by_user'
  startedAt: number
  endedAt: number | null
  /** true = a PTY desta sessão está viva NESTE app agora. */
  isLive: boolean
}

export interface PaneSnapshot {
  ccSessionId: string
  // null = sessão avulsa (sem repo/projeto).
  repo: Repo | null
  projectName: string | null
  projectIcon: string | null
  // Opcional: snapshots gravados antes desta feature não têm a cor (fallback null).
  projectColor?: string | null
  // Opcional: id do painel no dockview. Preservado pra que o layout salvo (que
  // referencia painéis por id) bata ao restaurar. Snapshots antigos não têm.
  paneId?: string
}

export interface WorkspaceBootState {
  openPanes: PaneSnapshot[]
  cleanShutdown: boolean
  restoreAttempts: number
  // Layout serializado do dockview (api.toJSON()). null se nunca salvo.
  dockLayout: string | null
}

export interface PtyDataEvent {
  sessionId: string
  data: string
}

export interface PtyExitEvent {
  sessionId: string
  exitCode: number
  signal: number | null
}

// Subagente (Task tool) visível no tail do transcript da sessão. 'running' =
// tool_use visto sem tool_result; 'ok'/'error' = tool_result chegou (is_error).
// Subagentes fora do tail (antigos) são omitidos da lista.
export interface SubagentActivity {
  name: string
  description: string
  state: 'running' | 'ok' | 'error'
}

export interface SessionActivity {
  ccSessionId: string
  status: 'starting' | 'working' | 'waiting' | 'idle' | 'ended'
  name: string | null
  title: string | null
  lastText: string | null
  lastActivityAt: number | null
  tokens?: { output: number; context: number }
  // Model id da última msg assistant do transcript (ex: 'claude-opus-4-...').
  // Null até a primeira resposta — fonte de verdade pro ModelPill do Terminal.
  model: string | null
  // Subagentes ativos/recentes derivados do tail (só no watch per-sessão; o
  // batch global e a lista Agents não carregam isso).
  subagents?: SubagentActivity[]
}

// Snapshot de uma sessão viva (PTY rodando neste app) para a lista global "Agents".
// Cruza a linha do DB (id numérico/UUID, ccSessionId, repo) com o estado ao vivo
// dos sessions/<pid>.json e o enriquecimento do JSONL (lastText/tokens).
export interface LiveSessionInfo {
  id: string
  ccSessionId: string
  name: string | null
  title: string | null
  status: 'starting' | 'working' | 'waiting' | 'idle' | 'ended'
  // null = sessão avulsa (sem repo/projeto).
  repo: Repo | null
  projectName: string | null
  projectIcon: string | null
  projectColor: string | null
  lastActivityAt: number | null
  lastText: string | null
  tokens?: { output: number; context: number }
  isResumable?: boolean
  // Espelho de sessions.title_source: 'manual' faz `title` carregar o rename do
  // usuário (precedência sobre o nome automático) em chips/panes re-attachados.
  titleSource?: 'manual' | 'auto' | null
}

// Batch de atualização de atividade de TODAS as sessões indexadas, emitido pelo
// watch global. Forma enxuta (sem repo/projeto) — o renderer já tem o snapshot.
export type GlobalActivityBatch = {
  ccSessionId: string
  status: 'starting' | 'working' | 'waiting' | 'idle' | 'ended'
  lastActivityAt: number | null
  lastText?: string | null
  tokens?: { output: number; context: number }
}[]

export type UpdateFormat = 'appimage' | 'deb' | 'dmg' | 'nsis' | 'zip'

export interface GithubAsset {
  name: string
  browser_download_url: string
}

export type UpdateStatus =
  | { state: 'available'; version: string; format?: UpdateFormat }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  // deb: instalação silenciosa via pkexec apt-get em andamento.
  | { state: 'installing'; version: string }
  // deb: instalado in-place; só falta relaunch.
  | { state: 'installed'; version: string }
  | { state: 'awaiting-install'; version: string }
  | { state: 'error'; message: string }

export interface UsageWindow {
  utilization: number
  resetsAt: string
}

export interface UsageStatus {
  state: 'ok' | 'no-token' | 'unauthorized' | 'error' | 'rate-limited'
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  fetchedAt: number
  // Dados anexados são do último 'ok' conhecido (429/erro de rede transitório).
  stale?: boolean
}

export interface NotificationPrefs {
  enabled: boolean
  sessionWaiting: boolean
  usageHigh: boolean
}

export interface NotificationEvent {
  title: string
  body: string
  at: number
  // Sessão associada ao evento (ex: "aguardando você"). Presente, o toast vira
  // acionável: clicar navega/abre a sessão correspondente.
  ccSessionId?: string
}

export interface PluginInfo {
  name: string
  marketplace: string
  enabled: boolean
}

// Referência a um componente individual de um plugin (skill, agent, etc).
export interface ComponentRef {
  name: string
  description?: string
}

export interface PluginComponents {
  skills: ComponentRef[]
  agents: ComponentRef[]
  commands: ComponentRef[]
  hooks: ComponentRef[]
  mcps: ComponentRef[]
}

// origin = 'user' (config user-level) ou o pluginId (`name@marketplace`).
export interface AgentInfo {
  name: string
  description: string
  origin: string
}

export interface SkillInfo {
  name: string
  description: string
  origin: string
}

// Item lançável pela command palette: uma skill ou um slash command, de origin
// 'user' ou pluginId. O `kind` decide a injeção no REPL ('/'+name p/ command).
export interface CommandInfo {
  name: string
  description: string
  origin: string
}

export interface LauncherItem {
  name: string
  description: string
  origin: string
  kind: 'skill' | 'command'
}

export interface McpInfo {
  name: string
  kind: string
  origin: string
}

export interface HookInfo {
  event: string
  origin: string
  summary: string
}

export interface ClaudeConfigs {
  plugins: PluginInfo[]
  agents: AgentInfo[]
  skills: SkillInfo[]
  mcps: McpInfo[]
  hooks: HookInfo[]
}

// Plugin gerenciado via CLI do claude (`claude plugin ...`).
export interface ManagedPluginInfo {
  id: string
  name: string
  marketplace: string
  version: string
  scope: string
  enabled: boolean
  installedAt: string | null
  maintainer: string | null
  category: string | null
  description: string | null
  author: string | null
}

export interface AvailablePlugin {
  id: string
  name: string
  marketplace: string
  maintainer: string | null
  description?: string
  category: string | null
  author: string | null
}

export interface PluginDetails {
  name: string
  description: string
  source: string
  components: {
    skills: number
    agents: number
    hooks: number
    mcpServers: number
    lspServers: number
  }
  alwaysOnTokens?: number
  raw?: string
  // Componentes nomeados lidos do installPath (complementa as contagens acima).
  componentRefs?: PluginComponents
}

export type PluginAction = 'enable' | 'disable' | 'uninstall' | 'update' | 'install'

export interface PluginActionResult {
  ok: boolean
  message: string
  restartRequired: boolean
}

// ---- Configurações do CLI claude (~/.claude/settings.json) ----

// Visão editável das chaves de alto uso. env expõe SÓ os nomes das chaves
// (valores podem ser secrets e nunca atravessam o IPC). statusLineCommand é o
// campo `command` do objeto statusLine (demais campos são preservados no write).
export interface ClaudeCliSettings {
  exists: boolean
  model: string | null
  effortLevel: string | null
  autoMemoryEnabled: boolean | null
  statusLineCommand: string | null
  language: string | null
  theme: string | null
  envKeys: string[]
}

// Escopo do editor de settings: user (~/.claude/settings.json) ou projeto
// (.claude/settings.json de um repo cadastrado). O renderer manda só o repoId —
// o main resolve o path pelo DB.
export interface ClaudeSettingsScopeInput {
  scope: 'user' | 'project'
  repoId?: string
}

export interface ClaudeSettingsWriteInput extends ClaudeSettingsScopeInput {
  patch: ClaudeCliSettingsPatch
}

// Patch parcial: chave ausente = não mexe; null = remove a chave do arquivo.
export interface ClaudeCliSettingsPatch {
  model?: string | null
  effortLevel?: string | null
  autoMemoryEnabled?: boolean | null
  statusLineCommand?: string | null
  language?: string | null
  theme?: string | null
}

export interface ClaudeWriteResult {
  ok: boolean
  message: string
}

export interface ClaudeMdFile {
  exists: boolean
  content: string
}

// Arquivo .md dentro de ~/.claude/rules (relPath relativo à pasta rules).
export interface RuleFileEntry {
  name: string
  relPath: string
}

// Script apontado por statusLine.command do settings.json (user). Editável só
// quando o path resolve pra dentro do HOME; senão ok=false com o motivo.
export interface StatuslineScriptFile {
  ok: boolean
  path?: string
  content?: string
  message?: string
}

// Entry individual de hooks[event] do ~/.claude/settings.json, com toggle.
// Para disabled=true, index é a posição no stash cc.disabledHooks (app_prefs),
// não no settings.json — é o handle usado pra religar. `entry` é o JSON cru da
// entry: no disable ele volta ao main pra casar por conteúdo (o índice fica
// stale se o arquivo mudou fora do app).
export interface HookToggleEntry {
  event: string
  index: number
  matcher: string | null
  summary: string
  disabled: boolean
  entry: unknown
}

// ---- MCP servers do CLI claude (user + projeto) ----

// target = url (http/sse) ou command+args (stdio). Headers/env NUNCA saem do
// main (podem carregar tokens).
export interface McpServerEntry {
  name: string
  scope: 'user' | 'project'
  transport: string
  target: string
  // Origem legível: caminho do arquivo de config ou label do repo.
  source: string
  repoId?: string
}

export interface McpAddInput {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  target: string
  // Só stdio: argumentos do comando (passados após `--`).
  args?: string[]
  scope: 'user' | 'project'
  // Exigido quando scope=project; o main resolve o path pelo DB.
  repoId?: string
}

export interface McpRemoveInput {
  name: string
  scope: 'user' | 'project'
  repoId?: string
}

export interface McpActionResult {
  ok: boolean
  message: string
}

export type MetricsWindow = '7d' | '30d' | 'all'
export type SessionType = 'quick_chat' | 'iteration' | 'deep_solo' | 'agent_orchestration'

export interface MetricsTotals {
  sessions: number
  turns: number
  subagentTurns: number
  agentCalls: number
  skillCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  // cacheRead / (cacheRead + input)
  cacheHitRate: number
  // parallelRounds / agentRounds (0 se agentRounds==0)
  parallelizationRatio: number
  // agentCalls / (agentCalls + inlineExploreCalls) (0 se denom==0)
  inlineDelegationRatio: number
  // subagentTurns / turns (0 se turns==0) — manager-mode score canônico
  managerModeScore: number
}

export interface MetricsDayPoint {
  day: string
  tokens: number
  costUsd: number
  turns: number
  sessions: number
}

export interface MetricsSessionRow {
  ccSessionId: string
  title: string | null
  sessionType: SessionType
  turns: number
  agentCalls: number
  costUsd: number
  lastTs: number | null
  projectId: string | null
  projectName: string
}

export interface MetricsProjectRow {
  projectId: string | null
  projectName: string
  sessions: number
  turns: number
  costUsd: number
  tokens: number
}

export interface MetricsToolRow {
  name: string
  count: number
}

export interface MetricsTypeBucket {
  type: SessionType
  sessions: number
  turns: number
  costUsd: number
}

export interface MetricsSnapshot {
  window: MetricsWindow
  generatedAt: number
  scanned: boolean
  totals: MetricsTotals
  // totais da janela imediatamente anterior (p/ delta). Ausente em 'all'.
  previousTotals?: MetricsTotals
  perDay: MetricsDayPoint[]
  perSession: MetricsSessionRow[]
  perProject: MetricsProjectRow[]
  sessionTypeDistribution: MetricsTypeBucket[]
  // distribuição de subagent_type sobre os tool_use Agent (desc por count)
  subagentTypeDistribution: { type: string; count: number }[]
  // sessões por modelo (de models_json; sessão multi-modelo conta em cada um)
  modelDistribution: { model: string; sessions: number }[]
  topTools: MetricsToolRow[]
  // modelos sem preço → custo parcial (aviso na UI)
  unknownModels: string[]
}

export interface MetricsScanProgress {
  processed: number
  total: number
  done: boolean
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
}

// Status de GPU: o que está EM VIGOR neste processo (decidido no boot, imutável)
// vs as prefs atuais — que só aplicam no próximo relaunch. A UI mostra "requer
// reiniciar" quando os pares divergem.
export interface GpuStatus {
  hwAccelDisabled: boolean
  ozoneWayland: boolean
  prefDisabled: boolean
  prefOzone: boolean
}

// Status read-only do MCP server embutido (Settings → Geral). addCommand é o
// `claude mcp add ...` pronto (inclui o bearer token) pra sessões externas.
export interface McpStatus {
  running: boolean
  port: number | null
  url: string | null
  addCommand: string | null
}

// ---- Sincronização git-backed (Fase 2) ----

export interface SyncGitStatus {
  dirty: boolean
  ahead: number
  behind: number
  lastCommit: string | null
}

// Estado persistente de sync, atualizado pelo boot, pelo coordinator (auto-sync)
// e pelas ações manuais. Sobrevive a reabrir o dialog (mora no main, não na UI).
//  - idle            — sem repo configurado.
//  - in-sync         — em paridade com o remoto.
//  - ahead           — trabalho local não-empurrado.
//  - behind          — remoto à frente (há o que importar).
//  - syncing         — operação em andamento.
//  - conflict        — divergência (escolha do usuário necessária).
//  - schema-mismatch — bundle remoto exige app mais novo (bloqueado).
//  - stale           — offline/erro não-fatal; opera com dados locais.
export type SyncState =
  'idle' | 'in-sync' | 'ahead' | 'behind' | 'syncing' | 'conflict' | 'schema-mismatch' | 'stale'

// Snapshot agregado para a aba Sync: config machine-local + git + schema +
// estado persistente derivado do boot/coordinator/ações.
export interface SyncStatus {
  configured: boolean
  repoUrl: string | null
  machineId: string
  // Raiz absoluta dos projetos NESTA máquina (machine-local). null = não definida.
  // Paths sob ela viram <CM_ROOT>/... no bundle → portáveis entre máquinas.
  projectsRoot: string | null
  lastPullAt: number | null
  lastPushAt: number | null
  schemaVersion: number
  // null quando não configurado ou git indisponível (offline/erro).
  git: SyncGitStatus | null
  // Estado persistente (último resultado conhecido de boot/auto-sync/ação).
  lastSyncState: SyncState
  // Mensagem do último erro não-fatal (offline/transport), se houver.
  lastError: string | null
  // Quando o último estado foi registrado.
  lastSyncAt: number | null
}

export interface SyncConfigureInput {
  repoUrl: string
}

export interface SyncResolveConflictInput {
  keep: 'local' | 'remote'
}

// Define a pasta-raiz dos projetos desta máquina. root vazio → limpa (null).
export interface SyncSetProjectsRootInput {
  root: string
}

// Resultado de uma operação de sync. 'conflict' carrega ahead/behind p/ a UI.
export type SyncNowResult =
  | { state: 'not-configured' }
  | { state: 'up-to-date' }
  | { state: 'pushed' }
  | { state: 'pulled' }
  | { state: 'conflict'; ahead: number; behind: number }

// Resultado de um backup manual em .zip (independente do git). 'canceled' =
// o usuário fechou o dialog. 'exported'/'imported' carregam o path do .zip.
export type SyncBackupResult =
  { state: 'canceled' } | { state: 'exported'; path: string } | { state: 'imported'; path: string }

/**
 * Backend de cifragem em repouso (safeStorage). 'basic_text' é o fallback do
 * Chromium no Linux sem keyring: chave fixa e pública — ofuscação, não proteção.
 */
export type SecretEncryptionBackend = 'unavailable' | 'basic_text' | 'os_keyring'

export interface SecretsStatus {
  backend: SecretEncryptionBackend
  /** Chaves ainda gravadas em texto claro no banco. */
  plaintextKeys: string[]
  /** Chaves cujo ciphertext não decifra mais neste cofre (valor inacessível). */
  unreadableKeys: string[]
}

export interface CustomEnvEntry {
  key: string
  hasValue: boolean
  encrypted: boolean
  unreadable: boolean
}

// Importador de .env: o renderer só vê fingerprint (máscara + últimos 4 chars +
// tamanho) e o path de origem — o valor fica no main e é relido do arquivo no
// momento do apply.

export interface EnvSourceRef {
  path: string
  fingerprint: string
}

export interface ImportCandidate {
  key: string
  canonical?: string
  serviceId?: ServiceId
  sources: EnvSourceRef[]
  /**
   * 'same' = cofre já tem este valor; 'conflict' = fontes divergem entre si ou
   * do cofre; 'shadowed' = a chave é alias de serviço e a canônica já existe no
   * cofre — importar gravaria uma var que a resolução (canônica primeiro) ignora.
   */
  status: 'new' | 'same' | 'conflict' | 'shadowed'
}

export interface ImportSelection {
  key: string
  sourcePath: string
}

export interface ApplyImportResult {
  applied: string[]
  /** Chaves que não existiam (mais) no arquivo escolhido no momento do apply. */
  missing: string[]
  /** Chaves cujo sourcePath falhou a revalidação do apply (fora da raiz, symlink, nome inválido) — nada foi lido. */
  rejected: string[]
  /** Chaves gravadas em claro (cofre indisponível) — a UI avisa. */
  plaintext: string[]
}

// Status dos serviços do env hub (cards da aba Integrações). Health roda no
// main com cache TTL; a auditoria vem de service_proxy_calls (erros já
// redigidos antes de persistir — nenhum valor de credencial chega aqui).

export type ServiceHealthStatus = 'ok' | 'error' | 'unconfigured' | 'unsupported'

export interface ServiceHealth {
  status: ServiceHealthStatus
  checkedAt: number
  httpStatus?: number
  error?: string
}

export interface ServiceAuditEntry {
  id: string
  ts: number
  sessionId: string | null
  service: string
  operation: string
  status: 'ok' | 'error'
  durationMs: number
  error: string | null
}

export interface ServiceStatusEntry {
  id: ServiceId
  title: string
  configured: boolean
  health: ServiceHealth
  lastCall: ServiceAuditEntry | null
}

// ---------------------------------------------------------------------------
// Diagrams (canvas Excalidraw)
// ---------------------------------------------------------------------------

export type DiagramKind = 'architecture' | 'flow' | 'sequence' | 'er' | 'mindmap' | 'other'

export type DiagramStatus = 'active' | 'archived'

export type DiagramAuthor = 'claude' | 'human'

// Parents linkáveis: um diagrama pode ilustrar qualquer entidade do app.
export type DiagramParentType =
  | 'project'
  | 'repo'
  | 'feature'
  | 'task'
  | 'objective'
  | 'key_result'
  | 'session'
  | 'handoff'

// Origem da cena: skeleton (gerado pelo Claude via shared/diagram-skeleton),
// mermaid (convertido), scene (desenhado direto no canvas). null = desconhecida.
export type DiagramSourceFormat = 'skeleton' | 'mermaid' | 'scene'

// Cena Excalidraw. `elements` fica unknown[] de propósito: o shape é do
// Excalidraw, não nosso — o main não valida elemento a elemento.
export interface DiagramScene {
  elements: unknown[]
  appState?: Record<string, unknown>
}

export interface DiagramLink {
  diagramId: string
  parentType: DiagramParentType
  parentId: string
}

// Cabeçalho sem a cena: é o que o list() devolve (a cena pode ter megabytes;
// a lista não deve carregá-la). `thumbnail` viaja aqui porque é o preview.
export interface DiagramMeta {
  id: string
  title: string
  kind: DiagramKind
  status: DiagramStatus
  version: number
  sourceFormat: DiagramSourceFormat | null
  thumbnail: string | null
  createdAt: number
  updatedAt: number
}

export type Diagram = DiagramMeta & {
  scene: DiagramScene
  links: DiagramLink[]
}

// Linha do histórico sem a cena — o que listVersions() devolve.
export interface DiagramVersionMeta {
  id: string
  diagramId: string
  version: number
  author: DiagramAuthor
  summary: string
  createdAt: number
}

export interface DiagramVersion extends DiagramVersionMeta {
  scene: DiagramScene
}

export interface DiagramListFilter {
  // Default 'active' no store: arquivado só aparece quando pedido.
  status?: DiagramStatus | 'all'
  kind?: DiagramKind
  parentType?: DiagramParentType
  parentId?: string
  search?: string
}

export interface CreateDiagramInput {
  title: string
  kind?: DiagramKind
  scene: DiagramScene
  sourceFormat?: DiagramSourceFormat | null
  source?: string | null
  author: DiagramAuthor
  // Linha de changelog da versão 1 (o store aplica default quando omitida).
  summary?: string
  links?: Array<{ parentType: DiagramParentType; parentId: string }>
}

// snapshot=false: salva rascunho (só a cabeça). snapshot=true: bump de versão
// + linha no histórico — e aí `summary` é obrigatório (o store lança sem ele).
export interface UpdateDiagramSceneInput {
  id: string
  scene: DiagramScene
  // Default 'human' na camada IPC (a UI é sempre humana); o MCP passa 'claude'.
  author?: DiagramAuthor
  summary?: string
  snapshot: boolean
}

// ---------------------------------------------------------------------------
// Diagram shape library (.excalidrawlib)
// ---------------------------------------------------------------------------

export type DiagramLibraryStatus = 'published' | 'unpublished'

// Item da biblioteca de shapes do Excalidraw — GLOBAL (uma por app, não por
// diagrama), como no Excalidraw web. `elements` fica unknown[] pela mesma
// regra da cena: o shape é do Excalidraw, não nosso. `name` null ⇄ name?
// opcional do LibraryItem (SQL não tem undefined).
export interface DiagramLibraryItem {
  id: string
  name: string | null
  status: DiagramLibraryStatus
  elements: unknown[]
  created: number
}

// Resultado de instalar uma biblioteca: o conjunto completo pós-merge + quantos
// itens o arquivo instalado trouxe (pro toast "N shapes adicionados").
export interface InstallDiagramLibraryResult {
  items: DiagramLibraryItem[]
  added: number
}

// Resultado da transcrição de um ditado. Erros já vêm em PT, prontos pra tela
// (porte das mensagens de vozapp/stt.py).
export type VoiceTranscribeResult = { ok: true; text: string } | { ok: false; error: string }

// Resultado da condensação de um ditado longo. Falha é fail-open: o texto volta
// intacto com condensed=false — o ditado nunca se perde.
export interface VoiceCondenseResult {
  text: string
  condensed: boolean
}

// Status da config de voz (~/.config/voz/voz.env) — alimenta a seção "Voz" das
// configurações. Nunca carrega credencial, só campos seguros de mostrar.
export type VoiceConfigStatus =
  | {
      ok: true
      path: string
      sttUrl: string
      sttModel: string
      sttLanguage: string
      ttsVoice: string
      ttsModel: string
      ttsSpeed: number
    }
  | { ok: false; path: string; error: string }

// Resultado da síntese de fala (ElevenLabs). bytes é o mp3 inteiro — o renderer
// toca via Blob/objectURL. Erros já vêm em PT (porte de vozapp/tts.py).
export type VoiceTtsResult =
  { ok: true; bytes: Uint8Array; mime: string } | { ok: false; error: string }

// Resumo de fim de turno: emitido pelo main em voice:summary quando um turno
// termina em texto de assistant e o resumo automático da sessão está ligado —
// ou quando o usuário pede um resumo sob demanda (voice:summarize-now).
export interface VoiceSummaryEvent {
  ccSessionId: string
  summary: string
}

// Resultado do resumo sob demanda. ok=true → o resumo (se houver) chega pelo
// broadcast voice:summary; erros já vêm em PT, prontos pra tela.
export type VoiceSummarizeNowResult = { ok: true } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Video Lab (migration 041_video_lab)
// ---------------------------------------------------------------------------
//
// O eixo da área é REUSO: uma peça nunca nasce do zero, ela nasce de um TEMPLATE
// de uma categoria, herdando estilo (brand kit), elenco e blueprint de cenas.
// Brand kit, personagem e template NÃO pertencem a peça nenhuma — por isso não
// têm projectId aqui nem project_id no schema.
//
// O problema difícil da área é CONSISTÊNCIA, não geração: o personagem precisa
// parecer o mesmo em oito cenas geradas separadamente. Daí `VideoVisualSpec`
// (texto canônico injetado em TODO prompt) + `VideoCharacterRef` (imagens
// aprovadas passadas como referência ao gerador), e daí todo asset registrar
// `provider`/`model`/`prompt`/`refIds`: a peça é reproduzível, não sorteada.

/** Paleta e tipografia do brand kit. Leitura defensiva no store: a coluna é TEXT. */
export interface VideoBrandTokens {
  /** Nome do token → cor (ex: `accent`, `bg`, `text-dim`). */
  palette: Record<string, string>
  typography: { display?: string; mono?: string; body?: string }
}

export interface VideoBrandDoDont {
  do: string[]
  dont: string[]
}

export interface VideoBrandKit {
  id: string
  name: string
  tokens: VideoBrandTokens
  toneOfVoice: string
  doDont: VideoBrandDoDont
  /** Asset COMPARTILHADO (projectId null) — o logo não morre com uma peça. */
  logoAssetId: string | null
  /** locale → voiceId de TTS preferida (ex: `{'pt-BR': 'x6uRgOliu4lpcrqMH3s1'}`). */
  ttsVoices: Record<string, string>
  createdAt: number
  updatedAt: number
}

/** Os traços que NÃO podem variar entre cenas. É o que sustenta a consistência. */
export interface VideoVisualSpec {
  /** Texto canônico injetado, literal, em TODO prompt de imagem do personagem. */
  canonical: string
  /** Traços item a item (cabelo, roupa, idade aparente) — o checklist da revisão. */
  invariants: string[]
  /** O que nunca deve aparecer (negative prompt). */
  negative: string[]
}

/** Imagem aprovada do personagem, passada como referência ao gerador. */
export interface VideoCharacterRef {
  id: string
  characterId: string
  assetId: string
  /** Só ref aprovada entra no prompt; o resto é histórico de tentativa. */
  isApproved: boolean
  ord: number
}

/** Sem as refs: é o que o list() devolve. */
export interface VideoCharacterMeta {
  id: string
  name: string
  canonicalDescription: string
  visualSpec: VideoVisualSpec
  voiceId: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export type VideoCharacter = VideoCharacterMeta & {
  refs: VideoCharacterRef[]
}

/**
 * Papel + duração-alvo de uma cena no template. SEM roteiro: narração e texto
 * de tela são da PEÇA (`VideoScriptLine`), não do template — é o que permite o
 * mesmo blueprint gerar peças diferentes.
 */
export interface VideoSceneBlueprint {
  /** Id textual da cena ('cold-open', 'logo') — o mesmo do motor Remotion. */
  sceneId: string
  role: string
  targetSec: number
  /** Direção de arte genérica da cena, quando o template já a fixa. */
  visualHint?: string
}

/** Personagem escalado num papel (no elenco default do template ou na peça). */
export interface VideoCastSlot {
  characterId: string
  roleInPiece: string
}

export interface VideoTemplate {
  id: string
  /** Categoria ABERTA ('promo', 'character-story', ...): não é enum no banco. */
  kind: string
  name: string
  description: string
  sceneBlueprint: VideoSceneBlueprint[]
  brandKitId: string | null
  defaultCast: VideoCastSlot[]
  createdAt: number
  updatedAt: number
}

/** Etapa da esteira. Arquivar é `archivedAt` — as duas coisas são ortogonais. */
export type VideoProjectStatus = 'draft' | 'scripting' | 'assets' | 'rendering' | 'done'

/** Cabeçalho da peça, sem cenas nem elenco: é o que o list() devolve. */
export interface VideoProjectMeta {
  id: string
  slug: string
  title: string
  description: string
  kind: string
  templateId: string | null
  brandKitId: string | null
  locales: string[]
  /** Preset de tema do app usado na direção de arte (ex: 'slate'). */
  themePreset: string | null
  status: VideoProjectStatus
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

/**
 * A peça com o que é barato carregar junto. O ROTEIRO fica de fora de
 * propósito: é por locale e cresce sem teto — vem por `script.list`.
 */
export type VideoProject = VideoProjectMeta & {
  cast: VideoProjectCastEntry[]
  scenes: VideoScene[]
}

export interface VideoProjectCastEntry {
  projectId: string
  characterId: string
  roleInPiece: string
}

export interface VideoScene {
  id: string
  projectId: string
  /** Id textual, único dentro da peça — é a chave que roteiro e assets citam. */
  sceneId: string
  ord: number
  role: string
  targetSec: number
  /** Direção de arte desta cena nesta peça. */
  visual: string
  createdAt: number
  updatedAt: number
}

export type VideoScriptLineKind = 'narration' | 'on_screen'

export interface VideoScriptLine {
  id: string
  projectId: string
  sceneId: string
  locale: string
  kind: VideoScriptLineKind
  text: string
  /** sha256 do texto: a chave que casa a linha com o áudio já gerado. */
  textHash: string
  ord: number
}

export type VideoAssetKind = 'audio' | 'texture' | 'keyvisual' | 'character' | 'sfx' | 'music'

/**
 * Arquivo no disco + a PROCEDÊNCIA que o gerou. `projectId` null = asset
 * COMPARTILHADO (logo, ref de personagem): não morre quando uma peça é apagada.
 * `path` viaja como caminho, nunca data-url — payload de mídia não passa por IPC.
 */
export interface VideoAsset {
  id: string
  projectId: string | null
  sceneId: string | null
  kind: VideoAssetKind
  locale: string | null
  path: string
  /** Chave de idempotência (ex: sha256(text+voiceId+modelId) no TTS). */
  hash: string | null
  provider: string | null
  model: string | null
  /** Prompt exato que produziu o asset — sem ele a peça não é reproduzível. */
  prompt: string | null
  /** Ids dos assets passados como REFERÊNCIA na geração (as refs do personagem). */
  refIds: string[]
  costCents: number
  bytes: number | null
  durationSec: number | null
  createdAt: number
}

export type VideoRenderStatus = 'queued' | 'running' | 'done' | 'failed'

/** Sem o log (que cresce com a saída do Remotion): é o que o list() devolve. */
export interface VideoRenderMeta {
  id: string
  projectId: string
  locale: string
  status: VideoRenderStatus
  outPath: string | null
  bytes: number | null
  durationSec: number | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type VideoRender = VideoRenderMeta & {
  log: string | null
}

// --- Filtros -------------------------------------------------------------

export interface VideoProjectListFilter {
  /** Default no store: só não-arquivadas. */
  includeArchived?: boolean
  status?: VideoProjectStatus
  kind?: string
  templateId?: string
  brandKitId?: string
  search?: string
}

export interface VideoCharacterListFilter {
  includeArchived?: boolean
  search?: string
}

export interface VideoTemplateListFilter {
  kind?: string
  search?: string
}

export interface VideoAssetListFilter {
  /** null explícito = só os COMPARTILHADOS; omitido = todos. */
  projectId?: string | null
  sceneId?: string
  kind?: VideoAssetKind
  locale?: string
  hash?: string
}

export interface VideoRenderListFilter {
  projectId?: string
  locale?: string
  status?: VideoRenderStatus
}

// --- Inputs de escrita ---------------------------------------------------

export interface CreateVideoBrandKitInput {
  name: string
  tokens?: VideoBrandTokens
  toneOfVoice?: string
  doDont?: VideoBrandDoDont
  logoAssetId?: string | null
  ttsVoices?: Record<string, string>
}

export type UpdateVideoBrandKitInput = Partial<CreateVideoBrandKitInput> & { id: string }

export interface CreateVideoCharacterInput {
  name: string
  canonicalDescription?: string
  visualSpec?: VideoVisualSpec
  voiceId?: string | null
}

export type UpdateVideoCharacterInput = Partial<CreateVideoCharacterInput> & { id: string }

/** Substitui o conjunto inteiro de refs (a ordem do array vira `ord`). */
export interface SetVideoCharacterRefsInput {
  characterId: string
  refs: Array<{ assetId: string; isApproved: boolean }>
}

export interface CreateVideoTemplateInput {
  kind: string
  name: string
  description?: string
  sceneBlueprint?: VideoSceneBlueprint[]
  brandKitId?: string | null
  defaultCast?: VideoCastSlot[]
}

export type UpdateVideoTemplateInput = Partial<CreateVideoTemplateInput> & { id: string }

/**
 * Criar peça É instanciar template: o store copia blueprint → cenas, brand kit
 * e elenco default numa transação. Sem `templateId` a peça nasce vazia (caminho
 * de exceção, não o normal).
 */
export interface CreateVideoProjectInput {
  slug: string
  title: string
  description?: string
  kind?: string
  templateId?: string | null
  /** Omitido: herda o do template. */
  brandKitId?: string | null
  locales: string[]
  themePreset?: string | null
}

export interface UpdateVideoProjectInput {
  id: string
  title?: string
  description?: string
  kind?: string
  brandKitId?: string | null
  locales?: string[]
  themePreset?: string | null
  status?: VideoProjectStatus
}

/** Substitui o elenco inteiro da peça. */
export interface SetVideoProjectCastInput {
  projectId: string
  cast: VideoCastSlot[]
}

/** Cria ou atualiza a cena (chave: projectId + sceneId). */
export interface UpsertVideoSceneInput {
  projectId: string
  sceneId: string
  ord?: number
  role?: string
  targetSec?: number
  visual?: string
}

export interface ReorderVideoScenesInput {
  projectId: string
  /** Ids textuais na ordem final. */
  sceneIds: string[]
}

/**
 * Grava o roteiro de UM locale de uma vez (o store calcula `textHash` e
 * substitui as linhas daquele locale). Batch porque roteiro se edita inteiro.
 */
export interface SetVideoScriptInput {
  projectId: string
  locale: string
  lines: Array<{
    sceneId: string
    kind: VideoScriptLineKind
    text: string
    ord?: number
  }>
}

/** Registra um arquivo já existente no disco (import manual ou saída de job). */
export interface RegisterVideoAssetInput {
  projectId?: string | null
  sceneId?: string | null
  kind: VideoAssetKind
  locale?: string | null
  path: string
  hash?: string | null
  provider?: string | null
  model?: string | null
  prompt?: string | null
  refIds?: string[]
  costCents?: number
  bytes?: number | null
  durationSec?: number | null
}

/**
 * Gera a narração das cenas de um locale via TTS. Idempotente por `textHash`:
 * cena cujo áudio já existe com o mesmo hash é REUSADA, não re-paga.
 */
export interface GenerateVideoAudioInput {
  projectId: string
  locale: string
  /** Omitido: todas as cenas da peça. */
  sceneIds?: string[]
  /** Omitido: a voz do brand kit para o locale. */
  voiceId?: string
  /** Regera mesmo com hash igual (o usuário trocou a voz e quer ouvir). */
  force?: boolean
  /**
   * DRY-RUN é o default (porte de `video/scripts/tts.mjs`): sem `go: true`
   * nenhuma chamada à API é feita e `costCents` no resultado é a ESTIMATIVA do
   * que seria gasto. Quem gasta dinheiro diz que quer gastar.
   */
  go?: boolean
}

/**
 * Gera imagem via Gemini. `characterId` é o que injeta `visualSpec.canonical` no
 * prompt e passa as refs aprovadas — é o caminho da CONSISTÊNCIA.
 */
export interface GenerateVideoImageInput {
  projectId: string
  sceneId?: string
  kind: Extract<VideoAssetKind, 'keyvisual' | 'texture' | 'character'>
  prompt: string
  characterId?: string
  /** Refs extras além das aprovadas do personagem. */
  refAssetIds?: string[]
  force?: boolean
  /** DRY-RUN é o default: sem `go: true` nada é gerado e nada é cobrado. */
  go?: boolean
  /**
   * TETO DE CUSTO em centavos, OBRIGATÓRIO quando `go: true` — gerar sem
   * orçamento declarado é proibido por construção. Comparado contra o que a
   * peça JÁ gastou; estourou, aborta ANTES da chamada em vez de rebaixar o
   * modelo em silêncio (rebaixar quebra a consistência visual da série).
   */
  budgetCents?: number
}

/** Resultado de um lote de geração — `reused` é a prova de que a idempotência pegou. */
export interface GenerateVideoAssetsResult {
  assets: VideoAsset[]
  generated: number
  reused: number
  failed: number
  costCents: number
}

/**
 * "Salvar peça como template": promove a ESTRUTURA da peça a molde (cenas,
 * brand kit, elenco). O ROTEIRO fica de fora — narração é da peça, não do
 * molde, e é isso que deixa o mesmo blueprint gerar peças diferentes.
 */
export interface SaveVideoTemplateFromProjectInput {
  projectId: string
  name: string
  /** Omitido: herda a categoria da própria peça. */
  kind?: string
  description?: string
}

export interface StartVideoRenderInput {
  projectId: string
  locale: string
}

// --- Eventos de processo longo -------------------------------------------

/** Progresso do render (Remotion): um evento por linha lida do stdout. */
export interface VideoRenderProgressEvent {
  renderId: string
  projectId: string
  locale: string
  status: VideoRenderStatus
  /** 0..1; null enquanto nenhum frame foi reportado. */
  progress: number | null
  renderedFrames: number | null
  totalFrames: number | null
  message: string | null
}

/** Progresso da geração de assets. `reused` = achou pelo hash e não pagou API. */
export interface VideoAssetJobEvent {
  projectId: string
  kind: VideoAssetKind
  sceneId: string | null
  locale: string | null
  status: 'started' | 'reused' | 'done' | 'failed'
  assetId: string | null
  error: string | null
}

/**
 * Superfície IPC da área. Declarada separada de `Api` por legibilidade (o bloco
 * é grande), e ligada lá embaixo por `video: VideoApi` — a chave e a
 * implementação no preload entraram juntas, como `const api: Api` exige.
 */
export interface VideoApi {
  brandKits: {
    list(): Promise<VideoBrandKit[]>
    get(id: string): Promise<VideoBrandKit | null>
    create(input: CreateVideoBrandKitInput): Promise<VideoBrandKit>
    update(input: UpdateVideoBrandKitInput): Promise<VideoBrandKit>
    remove(id: string): Promise<void>
    /** Payload = VideoBrandKit completo ou marcador { id, deleted }. */
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  characters: {
    /** Sem as refs: lista leve. */
    list(filter?: VideoCharacterListFilter): Promise<VideoCharacterMeta[]>
    get(id: string): Promise<VideoCharacter | null>
    create(input: CreateVideoCharacterInput): Promise<VideoCharacter>
    update(input: UpdateVideoCharacterInput): Promise<VideoCharacter>
    /** Substitui o conjunto inteiro de refs; devolve o personagem atualizado. */
    setRefs(input: SetVideoCharacterRefsInput): Promise<VideoCharacter>
    archive(id: string): Promise<VideoCharacter>
    unarchive(id: string): Promise<VideoCharacter>
    /** Payload = VideoCharacter completo. */
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  templates: {
    list(filter?: VideoTemplateListFilter): Promise<VideoTemplate[]>
    get(id: string): Promise<VideoTemplate | null>
    create(input: CreateVideoTemplateInput): Promise<VideoTemplate>
    update(input: UpdateVideoTemplateInput): Promise<VideoTemplate>
    remove(id: string): Promise<void>
    /** Fecha o ciclo de reuso: a peça que ficou boa vira molde da próxima. */
    saveFromProject(input: SaveVideoTemplateFromProjectInput): Promise<VideoTemplate>
    /** Payload = VideoTemplate completo ou marcador { id, deleted }. */
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  projects: {
    /** Sem cenas nem elenco: lista leve. */
    list(filter?: VideoProjectListFilter): Promise<VideoProjectMeta[]>
    get(id: string): Promise<VideoProject | null>
    /** Instancia o template (blueprint → cenas, brand kit, elenco) numa transação. */
    create(input: CreateVideoProjectInput): Promise<VideoProject>
    update(input: UpdateVideoProjectInput): Promise<VideoProject>
    setCast(input: SetVideoProjectCastInput): Promise<VideoProject>
    archive(id: string): Promise<VideoProject>
    unarchive(id: string): Promise<VideoProject>
    /** Apaga a peça e o que é dela (cenas, roteiro, assets, renders). */
    remove(id: string): Promise<void>
    /** Payload = VideoProject completo. */
    onUpdated(handler: (payload: unknown) => void): () => void
    /** Payload = { id }. */
    onDeleted(handler: (payload: unknown) => void): () => void
  }
  scenes: {
    list(projectId: string): Promise<VideoScene[]>
    upsert(input: UpsertVideoSceneInput): Promise<VideoScene>
    reorder(input: ReorderVideoScenesInput): Promise<VideoScene[]>
    /** Apagar a cena leva as linhas de roteiro e os assets dela (FK composta). */
    remove(projectId: string, sceneId: string): Promise<void>
    /** Payload = { projectId, scenes }. */
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  script: {
    list(projectId: string, locale: string): Promise<VideoScriptLine[]>
    /** Substitui o roteiro daquele locale; o store calcula os textHash. */
    set(input: SetVideoScriptInput): Promise<VideoScriptLine[]>
    /** Payload = { projectId, locale }. */
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  assets: {
    list(filter?: VideoAssetListFilter): Promise<VideoAsset[]>
    get(id: string): Promise<VideoAsset | null>
    register(input: RegisterVideoAssetInput): Promise<VideoAsset>
    /** TTS por cena, idempotente por textHash. */
    generateAudio(input: GenerateVideoAudioInput): Promise<GenerateVideoAssetsResult>
    /** Imagem via Gemini, com visualSpec + refs aprovadas do personagem. */
    generateImage(input: GenerateVideoImageInput): Promise<GenerateVideoAssetsResult>
    /** Apaga a linha; o arquivo em disco é do serviço, não da UI. */
    remove(id: string): Promise<void>
    /** Payload = VideoAsset completo ou marcador { id, deleted }. */
    onUpdated(handler: (payload: unknown) => void): () => void
    /** Payload = VideoAssetJobEvent — progresso de lote, inclusive 'reused'. */
    onJobEvent(handler: (payload: unknown) => void): () => void
  }
  renders: {
    /** Sem o log: lista leve. */
    list(filter?: VideoRenderListFilter): Promise<VideoRenderMeta[]>
    get(id: string): Promise<VideoRender | null>
    /** Enfileira o render; o progresso chega por onProgress. Nunca lança por
     *  falha do render: a row gravada com status 'failed' É o resultado. */
    start(input: StartVideoRenderInput): Promise<VideoRenderMeta>
    cancel(id: string): Promise<VideoRenderMeta>
    /** Abre o MP4 no player do sistema. */
    reveal(id: string): Promise<void>
    /** Payload = VideoRenderProgressEvent. */
    onProgress(handler: (payload: unknown) => void): () => void
    /** Payload = VideoRenderMeta — transição de status persistida. */
    onUpdated(handler: (payload: unknown) => void): () => void
  }
}

export interface MeetingsApi {
  /** Inicia gravação (sistema + mic) e devolve a reunião em status 'recording'. */
  start(input?: StartMeetingInput): Promise<Meeting>
  /** Para a gravação; resumo e extração seguem em background (processing → done). */
  stop(): Promise<Meeting>
  state(): Promise<MeetingLiveState>
  list(): Promise<Meeting[]>
  get(id: string): Promise<MeetingDetail>
  update(input: UpdateMeetingInput): Promise<Meeting>
  /** Anexa "- [mm:ss] texto" às notas no main (sem clobber do editor). */
  quickNote(meetingId: string, text: string): Promise<Meeting>
  delete(id: string): Promise<void>
  /** Re-roda resumo + extração de tarefas. */
  resummarize(id: string): Promise<Meeting>
  /** 'created' força criar a task mesmo sem grounding. */
  actionItem(input: MeetingActionItemDecision): Promise<MeetingActionItem>
  floating(action: MeetingFloatingAction): Promise<void>
  checkSetup(): Promise<MeetingSetupStatus>
  /** Estado ao vivo, segmentos, reunião e action items — um canal só. */
  onEvent(handler: (event: MeetingEvent) => void): () => void
}

export interface Api {
  projects: {
    list(): Promise<Project[]>
    create(input: CreateProjectInput): Promise<Project>
    update(input: UpdateProjectInput): Promise<Project>
    delete(id: string): Promise<void>
    reorder(ids: string[]): Promise<void>
    listRepos(projectId: string): Promise<Repo[]>
    createRepo(input: CreateRepoInput): Promise<Repo>
    updateRepo(input: UpdateRepoInput): Promise<Repo>
    deleteRepo(id: string): Promise<void>
    reorderRepos(input: ReorderReposInput): Promise<void>
    // Todos os repos de todos os projetos (vista de arquitetura global).
    listAllRepos(): Promise<Repo[]>
  }
  sessions: {
    spawn(input: SpawnSessionInput): Promise<Session>
    resume(input: ResumeSessionInput): Promise<Session>
    isResumable(ccSessionId: string): Promise<boolean>
    listByRepo(repoId: string): Promise<SessionSummary[]>
    /** Sessões de uma feature, da mais recente pra mais antiga. */
    listByFeature(featureId: string): Promise<FeatureSessionSummary[]>
    getBacklog(sessionId: string): Promise<string>
    write(sessionId: string, data: string): Promise<void>
    /** Grava uma imagem (paste/drag) como binário em <userData>/tmp e devolve o path absoluto. */
    saveImage(sessionId: string, bytes: ArrayBuffer, mime: string): Promise<string>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    kill(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    /** Vincula (ou desvincula, com null) a sessão a uma feature. */
    setFeature(sessionId: string, featureId: string | null): Promise<void>
    list(): Promise<Session[]>
    onData(handler: (event: PtyDataEvent) => void): () => void
    onExit(handler: (event: PtyExitEvent) => void): () => void
    watchActivity(ccSessionId: string): Promise<void>
    unwatchActivity(ccSessionId: string): Promise<void>
    onActivity(handler: (event: SessionActivity) => void): () => void
    listLiveGlobal(): Promise<LiveSessionInfo[]>
    /** Sessões encerradas com transcript no disco (todas retomáveis), globais. */
    listEndedGlobal(): Promise<LiveSessionInfo[]>
    watchGlobalActivity(): void
    unwatchGlobalActivity(): void
    onGlobalActivity(handler: (batch: GlobalActivityBatch) => void): () => void
    /** Informa o main qual sessão está no pane ativo/visível (supressão de notificação). */
    setRendererFocus(ccSessionId: string | null): void
  }
  chat: {
    /** Read inicial: resolve cc_session_id → transcript → lista ordenada de mensagens. */
    getTranscript(sessionId: string): Promise<ChatTranscript>
    /** Lê um arquivo de plano (validado dentro de ~/.claude/plans/); null se inválido/ilegível. */
    readPlanFile(path: string): Promise<string | null>
    /** Começa a observar o JSONL da sessão; emite chat:transcript-update em cada mudança. */
    watch(sessionId: string): void
    /** Para o watcher (também é chamado automaticamente no pty:exit). */
    unwatch(sessionId: string): void
    onTranscriptUpdate(handler: (event: ChatTranscriptUpdate) => void): () => void
  }
  shell: {
    openPath(path: string): Promise<void>
    openExternal(url: string): Promise<void>
  }
  app: {
    getInfo(): Promise<AppInfo>
  }
  gpu: {
    status(): Promise<GpuStatus>
    setDisabled(disabled: boolean): Promise<void>
    setOzone(ozone: boolean): Promise<void>
    /** Reinicia o app (aplica mudanças de GPU, que só valem antes do ready). */
    relaunch(): Promise<void>
    /** Sistema voltou de suspend (powerMonitor.resume) — terminais devem se curar. */
    onResumed(handler: () => void): () => void
    /** Processo de GPU crashou — terminais devem largar o WebGL (fallback DOM). */
    onCrashed(handler: () => void): () => void
  }
  dialog: {
    openDirectory(): Promise<string | null>
  }
  prefs: {
    /** Rejeita chaves de segredo (custom_env_vars) — essas vão por `secrets`. */
    get<T>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
  }
  voice: {
    /** Transcreve áudio gravado no renderer (webm/opus ou wav) via proxy STT. */
    transcribe(bytes: Uint8Array, mime: string): Promise<VoiceTranscribeResult>
    /** Condensa ditado longo num prompt limpo via claude -p (fail-open). */
    condense(text: string): Promise<VoiceCondenseResult>
    /** Status da config voz.env — nunca inclui credenciais. */
    configStatus(): Promise<VoiceConfigStatus>
    /** Sintetiza fala (mp3) do texto via ElevenLabs — bytes prontos pra tocar. */
    tts(text: string): Promise<VoiceTtsResult>
    /** Liga/desliga o resumo automático de fim de turno DESTA sessão. */
    autoSummarySet(ccSessionId: string, enabled: boolean): Promise<void>
    /** Estado atual do resumo automático da sessão (fonte da verdade: main). */
    autoSummaryGet(ccSessionId: string): Promise<boolean>
    /** Resume o último turno agora (bypass do gate automático; lock mantido). */
    summarizeNow(ccSessionId: string): Promise<VoiceSummarizeNowResult>
    /** Resumo do turno que acabou (2-3 frases, PT) — automático ou sob demanda. */
    onSummary(handler: (event: VoiceSummaryEvent) => void): () => void
  }
  secrets: {
    /** Estado da cifragem em repouso — alimenta o aviso da tela de configurações. */
    status(): Promise<SecretsStatus>
    /** Nomes das env vars + se têm valor. NUNCA devolve o valor. */
    list(): Promise<CustomEnvEntry[]>
    /** Valor decifrado de UMA chave, sob ação explícita do usuário. */
    reveal(key: string): Promise<string | null>
    set(key: string, value: string): Promise<SecretsStatus>
    remove(key: string): Promise<SecretsStatus>
    rename(from: string, to: string): Promise<SecretsStatus>
    /** Varre .env de ~/projetos e compara com o cofre. Só fingerprints, nunca valores. */
    importScan(): Promise<ImportCandidate[]>
    /** Grava as seleções; o main relê o valor do arquivo escolhido (segredo não trafega). */
    importApply(selections: ImportSelection[]): Promise<ApplyImportResult>
    /** Cards da aba Integrações: configurado + health (cache TTL) + última chamada auditada. */
    servicesStatus(): Promise<ServiceStatusEntry[]>
  }
  vault: {
    getRoot(): Promise<string>
    isConfigured(): Promise<boolean>
    setRoot(root: string): Promise<void>
    ensureDir(path: string): Promise<{ created: boolean; wasEmpty: boolean }>
    isInside(vaultPath: string, target: string): Promise<boolean>
    listUntracked(projectId: string): Promise<UntrackedFolder[]>
  }
  fs: {
    listDir(path: string): Promise<FsEntry[]>
    readFile(path: string): Promise<FsFile>
    writeFile(path: string, content: string): Promise<void>
  }
  repo: {
    moveIntoVault(source: string, vaultPath: string, label: string): Promise<{ path: string }>
    symlinkIntoVault(source: string, vaultPath: string, label: string): Promise<{ path: string }>
    removeSymlink(target: string): Promise<{ removed: boolean }>
    cloneUrl(url: string, vaultPath: string): Promise<{ path: string }>
    createBlank(vaultPath: string, name: string, gitInit: boolean): Promise<{ path: string }>
    listMissing(): Promise<MissingRepo[]>
    cloneMissing(): Promise<CloneMissingResult[]>
    pullAll(): Promise<PullRepoResult[]>
    pullOne(selector: { repoId?: string; path?: string }): Promise<PullRepoResult>
    lastPullRun(): Promise<LastPullRun | null>
  }
  workspace: {
    getActive(): Promise<string | null>
    setActive(projectId: string | null): Promise<void>
    savePanes(panes: PaneSnapshot[]): Promise<void>
    saveLayout(layout: string | null): Promise<void>
    getBootState(): Promise<WorkspaceBootState>
    bumpRestoreAttempts(): Promise<void>
    resetRestoreAttempts(): Promise<void>
  }
  ccConfigs: {
    read(): Promise<ClaudeConfigs>
    listLauncherItems(): Promise<LauncherItem[]>
  }
  ccPlugins: {
    list(): Promise<ManagedPluginInfo[]>
    available(): Promise<AvailablePlugin[]>
    details(name: string): Promise<PluginDetails>
    action(action: PluginAction, name: string): Promise<PluginActionResult>
  }
  ccSettings: {
    read(scope?: ClaudeSettingsScopeInput): Promise<ClaudeCliSettings>
    write(input: ClaudeSettingsWriteInput): Promise<ClaudeWriteResult>
    readClaudeMd(): Promise<ClaudeMdFile>
    writeClaudeMd(content: string): Promise<ClaudeWriteResult>
    listRules(): Promise<RuleFileEntry[]>
    readRule(relPath: string): Promise<ClaudeMdFile>
    listHooks(): Promise<HookToggleEntry[]>
    disableHook(event: string, index: number, entry: unknown): Promise<ClaudeWriteResult>
    enableHook(event: string, disabledIndex: number): Promise<ClaudeWriteResult>
    readKeybindings(): Promise<ClaudeMdFile>
    writeKeybindings(content: string): Promise<ClaudeWriteResult>
    readStatuslineScript(): Promise<StatuslineScriptFile>
    writeStatuslineScript(content: string): Promise<ClaudeWriteResult>
  }
  updates: {
    onStatus(handler: (status: UpdateStatus) => void): () => void
    apply(): Promise<void>
    install(): Promise<void>
    openRelease(): Promise<void>
    openDownloads(): Promise<void>
  }
  usage: {
    get(): Promise<UsageStatus>
    refresh(): Promise<UsageStatus>
    onStatus(handler: (status: UsageStatus) => void): () => void
  }
  metrics: {
    get(window: MetricsWindow): Promise<MetricsSnapshot>
    refresh(): Promise<MetricsSnapshot>
    onProgress(handler: (p: MetricsScanProgress) => void): () => void
  }
  features: {
    list(projectId?: string): Promise<Feature[]>
    listWithStats(opts?: FeatureListStatsOpts): Promise<FeatureWithStats[]>
    get(id: string): Promise<Feature | null>
    create(input: CreateFeatureInput): Promise<Feature>
    update(input: UpdateFeatureInput): Promise<Feature>
    archive(id: string): Promise<void>
    setRepos(input: SetFeatureReposInput): Promise<Feature>
    setObjectiveLinks(input: SetFeatureObjectiveLinksInput): Promise<Feature>
    listObjectiveLinks(featureId: string): Promise<FeatureObjectiveLink[]>
    backfill(): Promise<FeatureBackfillResult>
    // Foco da parede (Fase 4): vive no namespace `features` (e não em `loop`)
    // porque pinned/focus_rank são colunas de `features`, sincronizadas com a
    // tabela — o broadcast tem que ser 'feature:updated', que é o que pinga o
    // coordinator de sync.
    setFocus(input: SetFeatureFocusInput): Promise<Feature>
    /** "Não é duplicata": some com o aviso sem mexer em mais nada. */
    dismissDuplicate(featureId: string): Promise<Feature>
    /** Absorve o rascunho no destino e ARQUIVA a origem (nunca apaga). */
    mergeDuplicate(input: MergeFeatureDuplicateInput): Promise<Feature>
    onUpdated(handler: (feature: Feature) => void): () => void
    onSynthError(handler: (event: FeatureSynthError) => void): () => void
  }
  // Loop da feature (pulso/ledger/métricas). Namespace próprio: o loop tem
  // ciclo de vida e canal de broadcast ('loop:updated') separados de features.
  loop: {
    snapshot(featureId: string): Promise<FeatureLoopSnapshot>
    setPulse(input: SetPulseInput): Promise<FeaturePulse>
    pulseHistory(featureId: string, limit?: number): Promise<FeaturePulse[]>
    appendLedger(input: AppendLedgerInput): Promise<FeatureLedgerEntry>
    listLedger(featureId: string, opts?: ListLedgerOpts): Promise<FeatureLedgerEntry[]>
    declareMetric(input: DeclareMetricInput): Promise<FeatureMetricColumn>
    recordMetricPoint(input: RecordMetricPointInput): Promise<FeatureMetricPoint>
    onUpdated(handler: (payload: { featureId: string }) => void): () => void
  }
  repoDeps: {
    list(projectId: string): Promise<RepoDependency[]>
    // Todas as arestas de todos os projetos (vista de arquitetura global).
    listAll(): Promise<RepoDependency[]>
    create(input: CreateRepoDependencyInput): Promise<RepoDependency>
    update(input: UpdateRepoDependencyInput): Promise<RepoDependency>
    delete(input: { id: string; projectId: string }): Promise<void>
    setRepoPosition(input: {
      repoId: string
      x: number
      y: number
      projectId: string
    }): Promise<void>
    setRepoHub(input: SetRepoHubInput): Promise<void>
    connectHubToAll(input: ConnectHubToAllInput): Promise<RepoDependency[]>
    onUpdated(handler: (event: { projectId: string | null }) => void): () => void
  }
  handoffs: {
    list(opts?: { status?: HandoffStatus | HandoffStatus[] }): Promise<Handoff[]>
    get(id: string): Promise<Handoff | null>
    approve(input: { id: string; composedPrompt?: string }): Promise<Handoff>
    // Cria um handoff na mão (diálogo de nova sessão): persiste o registro com o
    // briefing composto e devolve o apelido resolvido. NÃO spawna — o spawn é do
    // renderer, pelo mesmo dispatch do gate de aprovação.
    createManual(input: CreateManualHandoffInput): Promise<ManualHandoffCreated>
    // Adota uma sessão já aberta como filha: cria o handoff e RELANÇA a sessão
    // (mata a PTY e sobe de novo com --resume + apelido + accept-inbound).
    adoptSession(input: AdoptSessionInput): Promise<AdoptedSession>
    reject(id: string): Promise<Handoff>
    markRunning(input: { id: string; childSessionId: string }): Promise<Handoff>
    fail(input: { id: string; error: string }): Promise<Handoff>
    // Entrega uma mensagem do humano à sessão-filha (texto livre ou resposta a um
    // handoff_ask). Resolve o childSessionId pelo handoffId; rejeita se a filha não
    // estiver viva. Injeta via bracketed-paste (com submit), não write cru.
    sendMessage(input: { id: string; text: string }): Promise<void>
    spawnContext(id: string): Promise<HandoffSpawnContext>
    // Feedback humano sobre a utilidade de um handoff concluído (instrumentação).
    setOutcome(input: { id: string; outcome: HandoffOutcome }): Promise<Handoff>
    // Tira o handoff de vista no Crew Dock (carimba dismissedAt). Não altera o
    // status nem encerra a sessão-filha.
    dismiss(id: string): Promise<Handoff>
    // Inverso do dismiss: apaga o carimbo e o card volta ao Crew Dock. É o que o
    // "Desfazer" do toast de dispensa chama.
    undismiss(id: string): Promise<Handoff>
    // Solta a filha do painel: além de carimbar dismissedAt, ZERA o childSessionId
    // — o vínculo mãe→filha deixa de existir e a sessão volta a ser uma sessão
    // normal (strip/switcher, notificações próprias). Não encerra a PTY nem desfaz
    // as permissões restritas com que a filha foi lançada.
    release(id: string): Promise<Handoff>
    // Retoma um handoff INTERROMPIDO: re-spawna a filha via `claude --resume`,
    // re-injeta o kickoff e devolve o handoff a 'running'. Rejeita se o status não
    // for 'interrupted' ou se o transcript da filha não existir mais.
    resume(id: string): Promise<Handoff>
    // Gate de UI do "Retomar": true só se o handoff está interrompido E o
    // transcript da filha ainda existe (mesma checagem do resume).
    isResumable(id: string): Promise<boolean>
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  baton: {
    // Destila o transcript da sessão no briefing que o humano vai editar. Síncrono
    // e caro (claude -p, até 90s): quem chama mostra progresso.
    distill(input: DistillBatonInput): Promise<string>
    // Sobe a sucessora com o briefing APROVADO, no mesmo repo/feature. Herda o papel
    // de filha de handoff quando houver. NÃO encerra a antecessora.
    pass(input: PassBatonInput): Promise<PassBatonResult>
  }
  objectives: {
    list(filter?: ObjectiveListFilter): Promise<ObjectiveWithProgress[]>
    get(id: string): Promise<ObjectiveDetail | null>
    overview(): Promise<OverviewData>
    create(input: CreateObjectiveInput): Promise<Objective>
    update(input: UpdateObjectiveInput): Promise<Objective>
    archive(id: string): Promise<void>
    createKeyResult(input: CreateKeyResultInput): Promise<KeyResult>
    updateKeyResult(input: UpdateKeyResultInput): Promise<KeyResult>
    deleteKeyResult(id: string): Promise<void>
    // Payload varia por mutação (Objective completo, ou marcador {id, archived}
    // / {keyResultId, ...}) — o renderer trata como sinal de recarga.
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  tasks: {
    list(filter?: TaskListFilter): Promise<Task[]>
    get(id: string): Promise<Task | null>
    listByParent(parentType: TaskParentType, parentId: string): Promise<Task[]>
    create(input: CreateTaskInput): Promise<Task>
    update(input: UpdateTaskInput): Promise<Task>
    delete(id: string): Promise<void>
    setLinks(taskId: string, links: TaskLink[]): Promise<Task>
    reorder(taskId: string, position: number): Promise<Task>
    // Payload varia por mutação (Task completa ou marcador {id, deleted}) —
    // o renderer trata como sinal de recarga. Mutações com parent
    // objective/key_result também emitem 'objective:updated' com {id}.
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  diagrams: {
    // Sem a cena: lista leve. status default 'active'; 'all' inclui arquivados.
    list(filter?: DiagramListFilter): Promise<DiagramMeta[]>
    get(id: string): Promise<Diagram | null>
    // Cria a cabeça + versão 1 numa transação.
    create(input: CreateDiagramInput): Promise<Diagram>
    // Sempre atualiza a cabeça; snapshot=true bumpa versão e grava histórico
    // (cap de 30 snapshots por diagrama).
    updateScene(input: UpdateDiagramSceneInput): Promise<Diagram>
    rename(id: string, title: string): Promise<Diagram>
    archive(id: string): Promise<Diagram>
    unarchive(id: string): Promise<Diagram>
    // Delete direto (a UI confirma; o two-step archive→delete é regra do MCP).
    delete(id: string): Promise<void>
    link(input: DiagramLink): Promise<DiagramLink[]>
    unlink(input: DiagramLink): Promise<DiagramLink[]>
    listVersions(diagramId: string): Promise<DiagramVersionMeta[]>
    getVersion(diagramId: string, version: number): Promise<DiagramVersion | null>
    // Git-revert: copia o snapshot pra cabeça e grava versão NOVA — o
    // histórico nunca é reescrito.
    restoreVersion(diagramId: string, version: number, author?: DiagramAuthor): Promise<Diagram>
    // Só o preview: não versiona nem bumpa updated_at.
    setThumbnail(id: string, dataUrl: string): Promise<void>
    // Payload = Diagram completo.
    onUpdated(handler: (payload: unknown) => void): () => void
    // Payload = { id }.
    onDeleted(handler: (payload: unknown) => void): () => void
    // Payload = { diagramId, links }.
    onLinksUpdated(handler: (payload: unknown) => void): () => void
    // Biblioteca de shapes (.excalidrawlib) — GLOBAL, compartilhada entre
    // diagramas. replace é o caminho do onLibraryChange do editor (array
    // completo, na ordem do painel); installUrl baixa no main (15s/5MB).
    library: {
      get(): Promise<DiagramLibraryItem[]>
      replace(items: DiagramLibraryItem[]): Promise<DiagramLibraryItem[]>
      remove(id: string): Promise<DiagramLibraryItem[]>
      installUrl(url: string): Promise<InstallDiagramLibraryResult>
      // Payload = { items: DiagramLibraryItem[] }.
      onUpdated(handler: (payload: unknown) => void): () => void
    }
  }
  notifications: {
    onEvent(handler: (event: NotificationEvent) => void): () => void
    /** Clique na notificação NATIVA: o main pede pro renderer abrir/focar a sessão. */
    onOpenSession(handler: (ccSessionId: string) => void): () => void
  }
  mcp: {
    status(): Promise<McpStatus>
    // Gestão dos MCP servers do CLI claude (user + projeto). Listagem lê os
    // arquivos de config; add/remove fazem shell-out validado a `claude mcp`.
    listServers(): Promise<McpServerEntry[]>
    addServer(input: McpAddInput): Promise<McpActionResult>
    removeServer(input: McpRemoveInput): Promise<McpActionResult>
  }
  sync: {
    status(): Promise<SyncStatus>
    configure(input: SyncConfigureInput): Promise<SyncStatus>
    setProjectsRoot(input: SyncSetProjectsRootInput): Promise<SyncStatus>
    now(): Promise<SyncNowResult>
    exportForce(): Promise<SyncNowResult>
    importForce(): Promise<SyncNowResult>
    resolveConflict(input: SyncResolveConflictInput): Promise<SyncNowResult>
    // Backup manual em .zip (independente do git; abre dialog no main).
    backupExport(): Promise<SyncBackupResult>
    backupImport(): Promise<SyncBackupResult>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    onMaximizeChange(handler: (maximized: boolean) => void): () => void
  }
  video: VideoApi
  meetings: MeetingsApi
  design: DesignApi
}
