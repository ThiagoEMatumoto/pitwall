// Tipos compartilhados main ↔ renderer via contextBridge.
// Toda feature nova adiciona seus tipos aqui e estende `Api` no preload.

// Tipos do Chat View (Fase 5) moram em ./chat e são re-exportados aqui pra que os
// consumidores sigam importando tudo de '@shared/types/ipc'.
export type { ChatMessage, ChatQuestion, ChatTranscript, ChatTranscriptUpdate } from './chat'
import type { ChatTranscript, ChatTranscriptUpdate } from './chat'

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
// ('dirty' | 'diverged' | 'sem .git'); 'pulled' = algo avançou; 'up-to-date' =
// tudo já em dia; 'error' = alguma unidade falhou.
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
// ausente quando nenhuma branch reportou atraso (ex.: fetch falhou).
export interface RepoPullStatus {
  repoId: string
  status: PullRepoResult['status']
  behind?: number
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

// ---- Research Dossier (pesquisa profunda com proveniência) ----
//
// Hierarquia: Dossier (a pergunta persistente) → DossierRun (cada execução do
// funil de 6 estágios + 2 gates) → Source (fonte ingerida) → EvidenceRecord (o
// claim atômico amarrado a fonte + verbatim + anchor). É a fonte da verdade: nada
// no relatório existe sem um EvidenceRecord por trás.

// Classe da fonte, atribuída na ingestão. Deriva o trust_tier.
export type SourceClass =
  | 'primary_official'
  | 'academic'
  | 'reputable_press'
  | 'practitioner_video'
  | 'forum_ugc'
  | 'vendor_marketing'
  | 'blog_seo'

// Confiabilidade derivada da classe: primary/academic=high; press=medium;
// video=medium-com-contexto; forum=low-autêntico; vendor=biased.
export type TrustTier = 'high' | 'medium' | 'low' | 'biased'

// Estado de verificação de um claim. unverified ≠ refuted (a falha instrutiva da
// skill deep-research foi colapsar não-checado em refutado).
export type EvidenceState =
  | 'primary_accepted'
  | 'corroborated'
  | 'single_source'
  | 'contested'
  | 'unverified'
  | 'refuted'

// Ciclo de vida do dossiê: active (vivo, re-rodável) → archived.
export type DossierStatus = 'active' | 'archived'

// Estágio/estado de uma run no funil semi-autônomo. awaiting_gate_a/b são as duas
// pausas humanas; paused é checkpoint por throttle (retoma, não destrói).
export type DossierRunStatus =
  | 'planning'
  | 'awaiting_gate_a'
  | 'searching'
  | 'fetching'
  | 'extracting'
  | 'awaiting_gate_b'
  | 'verifying'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'paused'

// Estado de ingestão de uma fonte: snippet (só rankeada na busca) → fetched
// (página/transcrição baixada) | failed.
export type SourceStatus = 'snippet' | 'fetched' | 'failed'

export interface Dossier {
  id: string
  title: string
  question: string
  // Classes de fonte escolhidas no plano (persistido como JSON array).
  sourceClasses: SourceClass[]
  // Budget de tokens por dossiê (Gate A); null = sem cap explícito.
  budgetTokens: number | null
  status: DossierStatus
  createdAt: number
  updatedAt: number
}

export interface DossierRun {
  id: string
  dossierId: string
  status: DossierRunStatus
  // Estágio textual livre pra UI (sub-passo dentro do status). Null no início.
  stage: string | null
  // Plano do estágio 0 (JSON serializado): decomposição + classes + budget.
  planJson: string | null
  // Checkpoint após cada estágio (JSON serializado): permite retomar após throttle.
  checkpointJson: string | null
  // Custo acumulado de tokens da run.
  costTokens: number
  summary: string | null
  error: string | null
  startedAt: number
  updatedAt: number
  // Preenchido nos estados terminais (done/failed).
  finishedAt: number | null
}

export interface Source {
  id: string
  dossierRunId: string
  url: string
  title: string | null
  publisher: string | null
  sourceClass: SourceClass
  trustTier: TrustTier
  // Quando a página/transcrição foi baixada (null enquanto é só snippet).
  retrievedAt: number | null
  // Ponteiro pro conteúdo bruto ingerido (ex.: path/blob ref); null se não-fetched.
  contentRef: string | null
  status: SourceStatus
  createdAt: number
}

export interface EvidenceRecord {
  id: string
  dossierRunId: string
  sourceId: string
  // Afirmação atômica e falsificável.
  claim: string
  // O trecho EXATO de onde o claim saiu (proveniência verbatim).
  verbatimQuote: string
  // Offset de char (texto) OU timestamp "12:34" (vídeo). Null se não amarrado.
  anchor: string | null
  state: EvidenceState
  // importance × (1 − confiança) roteia a verificação cara; default 0.
  importance: number
  // Ids de outros EvidenceRecords que confirmam/contradizem (JSON array de string).
  corroboratedByJson: string | null
  contradictedByJson: string | null
  createdAt: number
}

export interface CreateDossierInput {
  // Id pré-gerado opcional; se omitido, o store gera.
  id?: string
  title: string
  question: string
  sourceClasses: SourceClass[]
  budgetTokens?: number | null
  // Omitido = 'active'.
  status?: DossierStatus
}

// Input do front-door (renderer → IPC dossiers:create). Diferente de
// CreateDossierInput (usado pelo store, que aceita id pré-gerado e status): aqui
// o usuário só informa o que digita no form.
export interface CreateDossierApiInput {
  title: string
  question: string
  sourceClasses: SourceClass[]
  budgetTokens?: number | null
}

// Plano editável passado no Gate A (renderer → IPC). Espelha DossierPlan do motor
// sem acoplar o shared aos tipos internos do pipeline.
export interface DossierPlanInput {
  question: string
  subQuestions: string[]
  sourceClasses: SourceClass[]
}

export interface CreateDossierRunInput {
  id?: string
  dossierId: string
  // Omitido = 'planning'.
  status?: DossierRunStatus
  stage?: string | null
  planJson?: string | null
  checkpointJson?: string | null
}

export interface AddSourceInput {
  id?: string
  dossierRunId: string
  url: string
  title?: string | null
  publisher?: string | null
  sourceClass: SourceClass
  trustTier: TrustTier
  retrievedAt?: number | null
  contentRef?: string | null
  // Omitido = 'snippet'.
  status?: SourceStatus
}

export interface AddEvidenceInput {
  id?: string
  dossierRunId: string
  sourceId: string
  claim: string
  verbatimQuote: string
  anchor?: string | null
  state: EvidenceState
  importance?: number
  // Ids de records corroborantes/contraditórios; o store serializa como JSON.
  corroboratedBy?: string[] | null
  contradictedBy?: string[] | null
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
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'dontAsk'

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
  keyResults: Array<KeyResult & { progress: number | null; linkedFeatures: LinkedFeatureSummary[] }>
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

// ---- Scheduled Jobs (Fase 1) ----

// Ciclo de vida de uma execução: scheduled (row criada pelo claim, aguardando
// spawn) → running (sessão viva) → success | failed | interrupted. `missed` =
// vencido com o app fechado (skip-with-marker, sem spawn).
export type JobRunStatus =
  | 'scheduled'
  | 'running'
  | 'success'
  | 'failed'
  | 'interrupted'
  | 'missed'

// Qualidade da captura do relatório pull (transcript): full (texto íntegro),
// partial (truncado em MAX_TEXT) ou none (transcript ausente). Evita falha
// silenciosa quando a sessão sai sem produzir texto.
export type CaptureQuality = 'full' | 'partial' | 'none'

// Discriminador do tipo de job (decisão técnica explícita — nunca inferida do
// prompt): 'critique' critica código/texto (comportamento atual); 'web-audit'
// dirige um browser (Playwright) contra targetUrl e mede desempenho + usabilidade.
// O runner usa o kind para liberar as browser tools só no web-audit.
export type JobKind = 'critique' | 'web-audit'

// Agendamento hand-rolled (sem lib de cron no MVP). Discriminated union:
// - interval: a cada N horas a partir do último run.
// - daily: todo dia às HH:MM (hora local).
// - weekly: no dia da semana (0=domingo..6=sábado) às HH:MM (hora local).
// Persistido como JSON na coluna `schedule`. next_run_at é derivado dele num
// único helper (computeNextRunAt) — fonte única do claim atômico.
export type JobSchedule =
  | { type: 'interval'; hours: number }
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'weekly'; dayOfWeek: number; hour: number; minute: number }

// Snapshot self-contained dos params de spawn (model/effort/permissionMode/
// advisorModel/prompt/systemPrompt) — imune a mudança de preset. permissionMode
// default 'plan' = observe-only; disallowedTools são strings opacas (JSON).
export interface ScheduledJob {
  id: string
  name: string
  // Tipo do job: 'critique' (default, retrocompatível) ou 'web-audit'.
  kind: JobKind
  repoId: string | null
  prompt: string
  systemPrompt: string | null
  // URL auditada — só web-audit preenche; null em jobs 'critique'.
  targetUrl: string | null
  schedule: JobSchedule
  nextRunAt: number
  lastRunAt: number | null
  enabled: boolean
  catchUp: boolean
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
  advisorModel: AdvisorModel | null
  disallowedTools: string[]
  createdAt: number
  updatedAt: number
}

// Métricas estruturadas de um web-audit, parseadas do bloco ```json que a sessão
// emite ao fim do relatório (ver web-audit-metrics.ts). Cada chave é número|null
// (null = não medido). Persistido como JSON string em job_runs.metrics_json.
export interface JobMetrics {
  lcp: number | null
  ttfb: number | null
  consoleErrors: number | null
  networkFailures: number | null
}

// Uma execução do job. sessionId = sessions.id interno; ccSessionId = id da
// sessão Claude Code (usado pra achar o transcript na captura). reportText =
// markdown do crítique capturado (Fase 2).
export interface JobRun {
  id: string
  jobId: string
  status: JobRunStatus
  startedAt: number | null
  finishedAt: number | null
  sessionId: string | null
  ccSessionId: string | null
  reportText: string | null
  captureQuality: CaptureQuality | null
  // Métricas estruturadas do web-audit (LCP/TTFB/console/network) como JSON. Null
  // em 'critique' e enquanto a Fase 2 (parse) não popula. String opaca por ora.
  metricsJson: string | null
  tokens: number | null
  model: string | null
  error: string | null
  createdAt: number
}

export interface CreateScheduledJobInput {
  name: string
  // Default 'critique' quando omitido (o store aplica o default).
  kind?: JobKind
  repoId?: string | null
  prompt: string
  systemPrompt?: string | null
  targetUrl?: string | null
  schedule: JobSchedule
  enabled?: boolean
  catchUp?: boolean
  model?: string | null
  effort?: EffortLevel | null
  permissionMode?: PermissionMode | null
  advisorModel?: AdvisorModel | null
  disallowedTools?: string[] | null
}

export interface UpdateScheduledJobInput {
  id: string
  name?: string
  kind?: JobKind
  repoId?: string | null
  prompt?: string
  systemPrompt?: string | null
  targetUrl?: string | null
  // Trocar o schedule recomputa next_run_at a partir de agora.
  schedule?: JobSchedule
  enabled?: boolean
  catchUp?: boolean
  model?: string | null
  effort?: EffortLevel | null
  permissionMode?: PermissionMode | null
  advisorModel?: AdvisorModel | null
  disallowedTools?: string[] | null
}

export interface CreateJobRunInput {
  jobId: string
  status?: JobRunStatus
  model?: string | null
}

export interface UpdateJobRunInput {
  id: string
  status?: JobRunStatus
  startedAt?: number | null
  finishedAt?: number | null
  sessionId?: string | null
  ccSessionId?: string | null
  reportText?: string | null
  captureQuality?: CaptureQuality | null
  metricsJson?: string | null
  tokens?: number | null
  model?: string | null
  error?: string | null
}

export interface ScheduledJobListFilter {
  enabled?: boolean
  repoId?: string
}

export interface JobRunListFilter {
  jobId?: string
  status?: JobRunStatus
  limit?: number
}

// ---- Reuniões (Meeting Intelligence) ----

export type MeetingStatus =
  | 'idle'
  | 'capturing'
  | 'recording'
  | 'transcribing'
  | 'diarizing'
  | 'ready'
  | 'extracted'
  | 'failed'

export type ExtractionKind =
  | 'action_item'
  | 'decision'
  | 'feedback'
  | 'risk'
  | 'question'

// Cabeçalho da reunião + proveniência (stt/diar/extractor) + notas livres.
// Persistência SQLite-only (molde de Task): segments/speakers/extractions vivem
// em tabelas filhas (CASCADE) e são carregados sob demanda, não embutidos aqui.
export interface Meeting {
  id: string
  title: string
  startedAt: number | null
  endedAt: number | null
  source: string | null
  audioPath: string | null
  durationMs: number | null
  lang: string
  sttModel: string | null
  diarModel: string | null
  extractor: string | null
  status: MeetingStatus
  rawNotes: string | null
  augmentedNotes: string | null
  summary: string | null
  createdAt: number
  updatedAt: number
}

// label→pessoa: o sidecar emite labels anônimos (SPEAKER_00…); a UI resolve o
// nome e marca o canal do mic como o usuário local ("você").
export interface MeetingSpeaker {
  meetingId: string
  label: string
  displayName: string | null
  isLocalUser: boolean
}

// Trecho do transcript. is_partial=true = provisório (janela ao vivo); o
// fechamento reconcilia speaker_label e marca is_partial=false. words_json
// guarda timestamps por palavra p/ citação fina.
export interface MeetingSegment {
  id: string
  meetingId: string
  idx: number
  startMs: number | null
  endMs: number | null
  speakerLabel: string | null
  text: string
  wordsJson: string | null
  avgLogprob: number | null
  noSpeechProb: number | null
  isPartial: boolean
}

// Item extraído (action item/decisão/feedback…) com quote literal + grounded;
// materializedTaskId dá idempotência na virada pra task real.
export interface MeetingExtraction {
  id: string
  meetingId: string
  type: ExtractionKind
  text: string
  assignee: string | null
  dueHint: string | null
  quote: string | null
  quoteSegmentId: string | null
  startMs: number | null
  endMs: number | null
  speakerLabel: string | null
  confidence: number | null
  grounded: boolean
  materializedTaskId: string | null
  createdAt: number
}

export interface CreateMeetingInput {
  title: string
  source?: string | null
  lang?: string
  status?: MeetingStatus
  rawNotes?: string | null
}

export interface UpdateMeetingInput {
  id: string
  title?: string
  startedAt?: number | null
  endedAt?: number | null
  source?: string | null
  audioPath?: string | null
  durationMs?: number | null
  lang?: string
  sttModel?: string | null
  diarModel?: string | null
  extractor?: string | null
  status?: MeetingStatus
  rawNotes?: string | null
  augmentedNotes?: string | null
  summary?: string | null
}

export interface MeetingListFilter {
  status?: MeetingStatus
  search?: string
}

// Eventos do sidecar broadcastados ao renderer durante a captura.
export interface MeetingStatusEvent {
  id: string
  status: MeetingStatus
}

// Segmento provisório (NDJSON `partial`): efêmero, NÃO persiste. Renderizado e
// substituído pelo `segment` final que carrega o mesmo idx. Diferente de
// MeetingSegment (persistido) por não ter id de banco.
export interface MeetingPartialEvent {
  meetingId: string
  idx: number
  startMs: number | null
  endMs: number | null
  speakerLabel: string | null
  text: string
}

// Stream da instalação do sidecar (botão "Instalar transcrição"): uma linha de
// stdout/stderr do setup-meeting-sidecar.sh por evento.
export interface MeetingInstallLogEvent {
  line: string
}

// Fim da instalação do sidecar: ok=true quando o script saiu com código 0.
export interface MeetingInstallDoneEvent {
  ok: boolean
  code?: number | null
  error?: string
}

// Origem do trecho que casou na busca FTS5 (transcript, notas aumentadas ou
// item extraído). Deixa a UI rotular de onde veio o match.
export type MeetingSearchSource = 'segment' | 'notes' | 'extraction'

// Um match de `meetings:search`: a reunião + o snippet (com <mark>…</mark> nos
// termos) + de onde o trecho veio + um score (bm25, menor = mais relevante).
export interface MeetingSearchMatch {
  meeting: Meeting
  snippet: string
  source: MeetingSearchSource
  score: number
}

// Resultado da extração (`meetings:extract`): notas aumentadas + resumo
// persistidos + os itens já com grounding. A UI mostra pra revisão humana.
export interface MeetingExtractResult {
  summary: string | null
  augmentedNotes: string | null
  extractions: MeetingExtraction[]
}

// Renomear um speaker da reunião (SPEAKER_0X → pessoa). O label é o gerado pela
// diarização; displayName é persistido em meeting_speakers.display_name e
// substitui o label na UI.
export interface SetSpeakerNameInput {
  meetingId: string
  label: string
  displayName: string
}

// Materialização de UMA extração revisada como task real. O vínculo (objective/
// feature) é o conjunto reusado do TaskDialog; quote/speaker/timestamp viram
// proveniência na descrição. extractionId dá idempotência (markMaterialized).
export interface MaterializeMeetingTaskInput {
  extractionId?: string
  title: string
  description?: string | null
  priority?: TaskPriority | null
  link?: TaskLink | null
  quote?: string | null
  speakerLabel?: string | null
  startMs?: number | null
}

// Ativação assistida por Google Calendar: quando o watcher detecta um evento do
// Meet começando agora, o main emite este draft pro renderer (canal
// 'meeting:calendar:activate') no clique da notificação nativa. A MeetingsArea
// cria uma reunião pré-preenchida com title/attendees. meetUrl/startMs entram na
// proveniência.
export interface MeetingActivationDraft {
  title: string
  attendees: string[]
  meetUrl: string | null
  startMs: number | null
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
  ccSessionId: string
  name: string | null
  // Título persistido no DB (rename manual/auto), distinto do name derivado do
  // transcript — fallback de exibição/busca quando o name é nulo.
  title: string | null
  status: 'working' | 'waiting' | 'idle' | 'ended'
  lastActivityAt: number | null
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
  | 'idle'
  | 'in-sync'
  | 'ahead'
  | 'behind'
  | 'syncing'
  | 'conflict'
  | 'schema-mismatch'
  | 'stale'

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
  | { state: 'canceled' }
  | { state: 'exported'; path: string }
  | { state: 'imported'; path: string }

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
    getBacklog(sessionId: string): Promise<string>
    write(sessionId: string, data: string): Promise<void>
    /** Grava uma imagem (paste/drag) como binário em <userData>/tmp e devolve o path absoluto. */
    saveImage(sessionId: string, bytes: ArrayBuffer, mime: string): Promise<string>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    kill(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
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
    get<T>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
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
    onUpdated(handler: (feature: Feature) => void): () => void
    onSynthError(handler: (event: FeatureSynthError) => void): () => void
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
    // Retoma um handoff INTERROMPIDO: re-spawna a filha via `claude --resume`,
    // re-injeta o kickoff e devolve o handoff a 'running'. Rejeita se o status não
    // for 'interrupted' ou se o transcript da filha não existir mais.
    resume(id: string): Promise<Handoff>
    // Gate de UI do "Retomar": true só se o handoff está interrompido E o
    // transcript da filha ainda existe (mesma checagem do resume).
    isResumable(id: string): Promise<boolean>
    onUpdated(handler: (payload: unknown) => void): () => void
  }
  dossiers: {
    create(input: CreateDossierApiInput): Promise<Dossier>
    list(opts?: { status?: DossierStatus }): Promise<Dossier[]>
    get(id: string): Promise<Dossier | null>
    archive(id: string): Promise<Dossier>
    // Arranca uma nova run: cria a run, monta o plano e PARA em awaiting_gate_a.
    startRun(input: { dossierId: string }): Promise<DossierRun>
    // Gate A aprovado: busca → fetch → extração, depois PARA em awaiting_gate_b.
    // plan opcional = plano editado pelo humano antes de gastar.
    approveGateA(input: { runId: string; plan?: DossierPlanInput }): Promise<DossierRun>
    // Gate B aprovado: poda opcional → verificação roteada → síntese graduada.
    approveGateB(input: { runId: string; keepEvidenceIds?: string[] }): Promise<DossierRun>
    // Retoma uma run parada (ex: throttle) a partir do checkpoint, respeitando os gates.
    resumeRun(input: { runId: string }): Promise<DossierRun>
    listRuns(dossierId: string): Promise<DossierRun[]>
    getRun(runId: string): Promise<DossierRun | null>
    listEvidence(runId: string): Promise<EvidenceRecord[]>
    listSources(runId: string): Promise<Source[]>
    // false = sem TAVILY_API_KEY: a busca web cai no provedor stub e a UI avisa.
    isWebSearchEnabled(): Promise<boolean>
    // Payload é a DossierRun atualizada; o renderer trata como sinal de recarga.
    onRunUpdated(handler: (payload: unknown) => void): () => void
    onUpdated(handler: (payload: unknown) => void): () => void
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
  scheduledJobs: {
    list(filter?: ScheduledJobListFilter): Promise<ScheduledJob[]>
    get(id: string): Promise<ScheduledJob | null>
    create(input: CreateScheduledJobInput): Promise<ScheduledJob>
    update(input: UpdateScheduledJobInput): Promise<ScheduledJob>
    delete(id: string): Promise<void>
    listRuns(filter?: JobRunListFilter): Promise<JobRun[]>
    // Dispara um run ad-hoc agora (fora do schedule). Retorna a run criada.
    runNow(id: string): Promise<JobRun>
    // Preview dos próximos `count` disparos a partir de agora (timestamps ms).
    // Puro: não cria runs nem toca next_run_at.
    previewRuns(schedule: JobSchedule, count: number): Promise<number[]>
    // Payload = ScheduledJob completo ou marcador {id, deleted} — o renderer
    // trata como sinal de recarga.
    onUpdated(handler: (payload: unknown) => void): () => void
    // Payload = JobRun atualizado — sinal de recarga do histórico de runs.
    onRunUpdated(handler: (payload: unknown) => void): () => void
  }
  meetings: {
    list(filter?: MeetingListFilter): Promise<Meeting[]>
    get(id: string): Promise<Meeting | null>
    create(input: CreateMeetingInput): Promise<Meeting>
    update(input: UpdateMeetingInput): Promise<Meeting>
    delete(id: string): Promise<void>
    listSegments(meetingId: string): Promise<MeetingSegment[]>
    // Speakers da reunião (label→pessoa + is_local_user da diarização).
    listSpeakers(meetingId: string): Promise<MeetingSpeaker[]>
    // Renomeia SPEAKER_0X → pessoa (persistido em display_name).
    setSpeakerName(input: SetSpeakerNameInput): Promise<MeetingSpeaker>
    // Busca full-text (FTS5) entre reuniões: casa transcript + notas aumentadas
    // + itens extraídos e devolve as reuniões com snippet/origem do match.
    search(query: string): Promise<MeetingSearchMatch[]>
    // Sidecar REAL de transcrição configurado? (pref `meeting_sidecar_python` +
    // python + sidecar.py existem). false → app cai no fake (dev) e a UI avisa.
    sidecarConfigured(): Promise<boolean>
    // Instala o sidecar (roda setup-meeting-sidecar.sh). Progresso via
    // onInstallLog; resultado via onInstallDone. Não bloqueia (stream).
    installSidecar(): Promise<void>
    // Inicia/encerra a captura do sidecar para a reunião (idle ⇄ capturing).
    startCapture(meetingId: string): Promise<void>
    stopCapture(meetingId: string): Promise<void>
    // Extração via claude -p (notas aumentadas + itens com grounding) e
    // materialização de um item revisado como task linkada.
    extract(meetingId: string): Promise<MeetingExtractResult>
    materializeTask(input: MaterializeMeetingTaskInput): Promise<Task>
    // Payload varia por mutação (Meeting completa ou marcador {id, deleted}) —
    // o renderer trata como sinal de recarga.
    onUpdated(handler: (payload: unknown) => void): () => void
    // Streams do sidecar: `segment` persistido (final) e `status` do ciclo de
    // captura. `partial` é provisório/efêmero (não persiste).
    onTranscriptSegment(handler: (segment: MeetingSegment) => void): () => void
    onTranscriptPartial(handler: (partial: MeetingPartialEvent) => void): () => void
    onStatus(handler: (payload: MeetingStatusEvent) => void): () => void
    // Stream da instalação do sidecar (uma linha por evento) e o resultado final.
    onInstallLog(handler: (event: MeetingInstallLogEvent) => void): () => void
    onInstallDone(handler: (event: MeetingInstallDoneEvent) => void): () => void
    // Speaker descoberto/renomeado (diarização ou rename manual). A UI atualiza
    // o mapa label→nome sem recarregar tudo.
    onSpeaker(handler: (speaker: MeetingSpeaker) => void): () => void
    // Ativação assistida por Google Calendar: emitido quando o usuário clica na
    // notificação nativa de "reunião começando agora". O renderer vai pra área
    // Reuniões e cria uma reunião pré-preenchida com o draft.
    onCalendarActivate(handler: (draft: MeetingActivationDraft) => void): () => void
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
}
