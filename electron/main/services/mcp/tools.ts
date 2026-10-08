// Tools MCP — handlers finos: validação zod → store → notify → retorno.
// Sem lógica de negócio própria; os broadcasts espelham 1:1 o que a camada IPC
// emite (mesmos canais/payloads), então a UI atualiza ao vivo pra writes MCP.
// Sem deletes destrutivos: archive (reversível) é o máximo de remoção exposto.
// Exceção única: diagram_delete — destrutivo, mas two-step por construção
// (exige o diagrama já arquivado via diagram_archive + confirm: true; o store
// recusa delete de diagrama ativo porque agente não recebe diálogo de
// confirmação).
import * as z from 'zod/v4'
import { serviceTools } from './service-tools'
import { videoTools } from './video-tools'
import { designTools } from './design-tools'
import { loopTools } from './loop-tools'
import { meetingTools } from './meeting-tools'
import { canvasTools } from './canvas-tools'
import { agentTools } from './agent-tools'
import type { McpServer } from '@modelcontextprotocol/server'
import * as objectiveStore from '../objective-store'
import * as overviewStore from '../overview-store'
import { attentionResponseStats } from '../attention-response-store'
import * as taskStore from '../task-store'
import * as featureStore from '../feature-store'
import { FEATURE_SECTIONS, USER_OWNED_SECTIONS } from '../../../../shared/feature-sections'
import * as repoDepStore from '../repo-dependency-store'
import * as handoffStore from '../handoff-store'
import * as repoPullStore from '../repo-pull-store'
import * as diagramStore from '../diagram-store'
import * as diagramLibraryStore from '../diagram-library-store'
import { installLibraryFromUrl, installLibraryJson } from '../diagram-library-install'
import {
  applyPatch,
  elementsToSkeleton,
  skeletonToElements,
} from '../../../../shared/diagram-skeleton'
import { composeHandoffPrompt, type HandoffEdge } from '../handoff/compose-prompt'
import { inheritFeatureId } from '../feature-session-resolver'
// Seam de injeção mãe→filha (guarded-inject → inject.ts, não ipc/sessions.ts —
// evita arrastar electron/ipcMain pros handlers e permite mockar nos testes).
import { injectIntoChildGuarded } from '../handoff/guarded-inject'
// Seam de spawn da filha (impl real em ipc/sessions.ts) — mesma motivação do
// injectIntoChild acima: nada de electron/ipcMain nos handlers.
import { spawnHandoffChild } from '../handoff/spawn-child'
import { buildHandoffAlias, roleForHandoffMode } from '../handoff/alias'
import { getActivityFor, ptyStatusFor } from '../session-activity'
import { emitSessionLinkPulse } from '../session-link-pulse'
import { ptyManager } from '../pty-manager'
import { getDb } from '../db'
import { getPref } from '../prefs-store'
import {
  assertAutonomousSpawnGuarded,
  permissionModeForHandoffMode,
  resolvePermissionMode,
} from '../spawn-flags'
import { randomUUID } from 'node:crypto'
import type {
  AgentProviderId,
  Diagram,
  DiagramLibraryItem,
  DiagramScene,
  FeatureObjectiveLink,
  Handoff,
  RepoDependency,
  TaskLink,
} from '../../../../shared/types/ipc'

// Injeção do broadcast (testável sem electron/janelas): o server monta a
// implementação real a partir de services/notify.ts.
export interface McpNotify {
  broadcast(channel: string, payload: unknown): void
  affectedObjectives(links: TaskLink[]): void
  affectedObjectivesForFeatureLinks(links: FeatureObjectiveLink[]): void
}

// Identidade carimbada pelo APP no spawn da sessão (mcp-config por sessão →
// ?s=<sessions.id> → server.ts). Nunca vem do modelo. null = sessão sem carimbo
// (config global legada) — o dedup de handoff volta ao escopo por repo.
export interface McpRequestContext {
  motherSessionId: string | null
}

export const ANONYMOUS_CONTEXT: McpRequestContext = { motherSessionId: null }

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
  [key: string]: unknown
}

export interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: z.ZodType
  // Promise SÓ pra tools com IO real (hoje: o fetch de diagram_library_install
  // e o proxy de service_call) — o registerTool do SDK aceita
  // CallToolResult | Promise<CallToolResult>.
  handler: (args: unknown) => ToolResult | Promise<ToolResult>
}

// structuredContent precisa ser objeto JSON (spec); listas vão como { items }.
export function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  }
}

// ---- enums espelhando shared/types/ipc.ts ----

const objectiveKind = z.enum(['okr', 'personal_goal', 'project', 'custom'])
const objectiveStatus = z.enum(['active', 'paused', 'done', 'archived'])
const keyResultStatus = z.enum(['active', 'paused', 'done', 'cancelled'])
const progressMode = z.enum(['auto_rollup', 'metric', 'manual'])
const progressDirection = z.enum(['increase', 'decrease', 'maintain'])
const priority = z.enum(['low', 'medium', 'high'])

// Campos de métrica compartilhados por objetivos e KRs (todos opcionais).
const metricFields = {
  progressMode: progressMode.optional(),
  progressManual: z.number().min(0).max(100).nullish(),
  baseline: z.number().nullish(),
  current: z.number().nullish(),
  target: z.number().nullish(),
  unit: z.string().nullish(),
  direction: progressDirection.nullish(),
}

// ---- objectives / key results ----

const objectiveListSchema = z.object({
  kind: objectiveKind.optional(),
  status: objectiveStatus.optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().optional(),
})

const idSchema = z.object({ id: z.string().min(1) })

// Espelha CreateObjectiveInput.
const objectiveCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  kind: objectiveKind,
  status: objectiveStatus.optional(),
  period: z.string().nullish(),
  startDate: z.number().nullish(),
  endDate: z.number().nullish(),
  parentObjectiveId: z.string().nullish(),
  priority: priority.nullish(),
  owner: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  ...metricFields,
})

// Espelha UpdateObjectiveInput (id obrigatório, resto parcial).
const objectiveUpdateSchema = objectiveCreateSchema.partial().extend({ id: z.string().min(1) })

// Espelha CreateKeyResultInput.
const keyResultCreateSchema = z.object({
  objectiveId: z.string().min(1),
  title: z.string().min(1),
  owner: z.string().nullish(),
  status: keyResultStatus.optional(),
  weight: z.number().nullish(),
  ...metricFields,
})

// Espelha UpdateKeyResultInput.
const keyResultUpdateSchema = keyResultCreateSchema
  .partial()
  .omit({ objectiveId: true })
  .extend({ id: z.string().min(1) })

function objectiveTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'objective_list',
      title: 'List objectives',
      description:
        'List objectives (OKRs, personal goals, projects) with computed progress (0-100, null = indeterminate). Optional filters: kind, status, tags, free-text search.',
      inputSchema: objectiveListSchema,
      handler: (args) => {
        const filter = objectiveListSchema.parse(args)
        return ok({ items: objectiveStore.list(filter) })
      },
    },
    {
      name: 'objective_get',
      title: 'Get objective detail',
      description:
        'Get one objective by id, including key results (with progress) and linked features. Returns { objective: null } when not found.',
      inputSchema: idSchema,
      handler: (args) => {
        const { id } = idSchema.parse(args)
        return ok({ objective: objectiveStore.get(id) })
      },
    },
    {
      name: 'objective_create',
      title: 'Create objective',
      description:
        'Create an objective. kind: okr | personal_goal | project | custom. Progress is computed (auto_rollup from key results/tasks/features by default).',
      inputSchema: objectiveCreateSchema,
      handler: (args) => {
        const input = objectiveCreateSchema.parse(args)
        const objective = objectiveStore.create(input)
        notify.broadcast('objective:updated', objective)
        return ok({ objective })
      },
    },
    {
      name: 'objective_update',
      title: 'Update objective',
      description: 'Update fields of an existing objective by id. Only provided fields change.',
      inputSchema: objectiveUpdateSchema,
      handler: (args) => {
        const input = objectiveUpdateSchema.parse(args)
        const objective = objectiveStore.update(input)
        notify.broadcast('objective:updated', objective)
        return ok({ objective })
      },
    },
    {
      name: 'objective_archive',
      title: 'Archive objective',
      description: 'Archive an objective (reversible soft-delete; it leaves active listings).',
      inputSchema: idSchema,
      handler: (args) => {
        const { id } = idSchema.parse(args)
        objectiveStore.archive(id)
        notify.broadcast('objective:updated', { id, archived: true })
        return ok({ id, archived: true })
      },
    },
    {
      name: 'key_result_create',
      title: 'Create key result',
      description: 'Create a key result under an objective (objectiveId required).',
      inputSchema: keyResultCreateSchema,
      handler: (args) => {
        const input = keyResultCreateSchema.parse(args)
        const keyResult = objectiveStore.createKeyResult(input)
        notify.broadcast('objective:updated', {
          id: keyResult.objectiveId,
          keyResultId: keyResult.id,
        })
        return ok({ keyResult })
      },
    },
    {
      name: 'key_result_update',
      title: 'Update key result',
      description: 'Update fields of an existing key result by id. Only provided fields change.',
      inputSchema: keyResultUpdateSchema,
      handler: (args) => {
        const input = keyResultUpdateSchema.parse(args)
        const keyResult = objectiveStore.updateKeyResult(input)
        notify.broadcast('objective:updated', {
          id: keyResult.objectiveId,
          keyResultId: keyResult.id,
        })
        return ok({ keyResult })
      },
    },
  ]
}

// ---- tasks ----

const taskStatus = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled'])
const taskParentType = z.enum(['objective', 'key_result', 'feature'])

const taskLinkSchema = z.object({
  parentType: taskParentType,
  parentId: z.string().min(1),
})

// Espelha TaskListFilter.
const taskListSchema = z.object({
  status: taskStatus.optional(),
  priority: priority.optional(),
  tag: z.string().optional(),
  search: z.string().optional(),
  parentType: taskParentType.optional(),
  parentId: z.string().optional(),
})

// Espelha CreateTaskInput.
const taskCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  status: taskStatus.optional(),
  priority: priority.nullish(),
  dueDate: z.number().nullish(),
  tags: z.array(z.string()).optional(),
  notes: z.string().nullish(),
  position: z.number().optional(),
  links: z.array(taskLinkSchema).optional(),
})

// Espelha UpdateTaskInput (sem links — vínculos mudam via task_set_links).
const taskUpdateSchema = taskCreateSchema
  .partial()
  .omit({ links: true })
  .extend({ id: z.string().min(1) })

const taskSetLinksSchema = z.object({
  taskId: z.string().min(1),
  links: z.array(taskLinkSchema),
})

function taskTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'task_list',
      title: 'List tasks',
      description:
        'List tasks. Optional filters: status, priority, tag, free-text search, or parent (parentType objective|key_result|feature + parentId).',
      inputSchema: taskListSchema,
      handler: (args) => {
        const filter = taskListSchema.parse(args)
        return ok({ items: taskStore.list(filter) })
      },
    },
    {
      name: 'task_create',
      title: 'Create task',
      description:
        'Create a task. Optional links attach it to objectives/key results/features (feeds auto-rollup progress).',
      inputSchema: taskCreateSchema,
      handler: (args) => {
        const input = taskCreateSchema.parse(args)
        // Todo task_create MCP vem de uma sessão Claude Code — origin='auto'
        // não é client-settable (Onda 0: coluna origin first-class).
        const task = taskStore.create({ ...input, origin: 'auto' })
        notify.broadcast('task:updated', task)
        notify.affectedObjectives(task.links)
        return ok({ task })
      },
    },
    {
      name: 'task_update',
      title: 'Update task',
      description:
        'Update fields of an existing task by id (status, priority, dueDate, etc). Links are managed via task_set_links.',
      inputSchema: taskUpdateSchema,
      handler: (args) => {
        const input = taskUpdateSchema.parse(args)
        const task = taskStore.update(input)
        notify.broadcast('task:updated', task)
        notify.affectedObjectives(task.links)
        return ok({ task })
      },
    },
    {
      name: 'task_set_links',
      title: 'Set task links',
      description:
        'Replace the full set of parent links of a task (objective/key_result/feature). Pass an empty array to detach.',
      inputSchema: taskSetLinksSchema,
      handler: (args) => {
        const { taskId, links } = taskSetLinksSchema.parse(args)
        const previous = taskStore.setLinks(taskId, links)
        const task = taskStore.get(taskId)
        if (!task) throw new Error(`task not found: ${taskId}`)
        notify.broadcast('task:updated', task)
        // Notifica tanto quem ganhou quanto quem perdeu a tarefa.
        notify.affectedObjectives([...previous, ...links])
        return ok({ task })
      },
    },
  ]
}

// ---- features ----

const featureStatus = z.enum(['pending', 'in-progress', 'blocked', 'done', 'paused'])
const featureSynthMode = z.enum(['auto', 'manual', 'threshold'])
const featureOrigin = z.enum(['manual', 'auto'])
const featureLinkTargetType = z.enum(['objective', 'key_result'])

const featureRepoLinkSchema = z.object({
  repoId: z.string().min(1),
  branch: z.string().nullable().default(null),
  worktreePath: z.string().nullable().default(null),
})

const featureListSchema = z.object({ projectId: z.string().optional() })

// Espelha CreateFeatureInput.
const featureCreateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().nullish(),
  status: featureStatus.optional(),
  synthMode: featureSynthMode.optional(),
  model: z.string().nullish(),
  repos: z.array(featureRepoLinkSchema).optional(),
  origin: featureOrigin.optional(),
  overview: z.string().optional(),
  approach: z.string().optional(),
})

// Regras de negócio e notas fixadas são do USUÁRIO e só ele as escreve, pelo
// painel da feature. As regras entram no system prompt de toda sessão futura da
// feature rotuladas "definidas pelo usuário"; aceitá-las de um agente (que pode
// ter lido um PR/issue/página hostil) abriria um canal persistente de prompt
// injection entre sessões — a restrição na descrição da tool não é enforcement.
const USER_OWNED_REFUSAL =
  'Regras de negócio e notas fixadas são do usuário: peça a ele para editá-las no painel da feature.'

// Espelha UpdateFeatureInput.
const featureUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  status: featureStatus.optional(),
  objective: z.string().nullish(),
  synthMode: featureSynthMode.optional(),
  model: z.string().nullish(),
  // Troca só UMA seção do doc. Regras de negócio e notas fixadas são recusadas
  // no handler (USER_OWNED_REFUSAL).
  section: z.enum(FEATURE_SECTIONS).optional(),
  markdown: z.string().max(100_000).optional(),
})

const featureObjectiveLinkSchema = z.object({
  targetType: featureLinkTargetType,
  targetId: z.string().min(1),
})

const featureSetObjectiveLinksSchema = z.object({
  featureId: z.string().min(1),
  links: z.array(featureObjectiveLinkSchema),
})

function featureTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'feature_list',
      title: 'List features',
      description:
        'List features (index fields only, no markdown body). Optional projectId filter. Archived features and hidden auto-drafts are excluded.',
      inputSchema: featureListSchema,
      handler: (args) => {
        const { projectId } = featureListSchema.parse(args)
        return ok({ items: featureStore.list(projectId) })
      },
    },
    {
      name: 'feature_get',
      title: 'Get feature',
      description:
        'Get one feature by id including its markdown body. Returns { feature: null } when not found.',
      inputSchema: idSchema,
      handler: (args) => {
        const { id } = idSchema.parse(args)
        return ok({ feature: featureStore.get(id) })
      },
    },
    {
      name: 'feature_create',
      title: 'Create feature',
      description:
        'Create a feature in a project (writes its markdown doc). Optional seed sections: overview, approach. Business rules are written only by the user, in the feature panel.',
      inputSchema: featureCreateSchema,
      handler: (args) => {
        if ((args as { businessRules?: unknown } | null)?.businessRules !== undefined) {
          throw new Error(USER_OWNED_REFUSAL)
        }
        const input = featureCreateSchema.parse(args)
        const feature = featureStore.create(input)
        notify.broadcast('feature:updated', feature)
        return ok({ feature })
      },
    },
    {
      name: 'feature_update',
      title: 'Update feature',
      description:
        'Update index fields of an existing feature by id (title, status, objective, synthMode, model). Pass section + markdown to replace ONE section of the feature doc (only that section changes). "Regras de negócio" and "Notas fixadas" belong to the user and are refused here: the user edits them in the feature panel.',
      inputSchema: featureUpdateSchema,
      handler: (args) => {
        const { section, markdown, ...input } = featureUpdateSchema.parse(args)
        if ((section === undefined) !== (markdown === undefined)) {
          throw new Error('section and markdown must be passed together')
        }
        if (section !== undefined && USER_OWNED_SECTIONS.includes(section)) {
          throw new Error(USER_OWNED_REFUSAL)
        }
        if (section !== undefined && markdown !== undefined) {
          featureStore.updateSection(input.id, section, markdown)
        }
        const feature = featureStore.update(input)
        notify.broadcast('feature:updated', feature)
        return ok({ feature })
      },
    },
    {
      name: 'feature_archive',
      title: 'Archive feature',
      description: 'Archive a feature (reversible soft-delete; it leaves active listings).',
      inputSchema: idSchema,
      handler: (args) => {
        const { id } = idSchema.parse(args)
        featureStore.archive(id)
        notify.broadcast('feature:updated', { id, archived: true })
        return ok({ id, archived: true })
      },
    },
    {
      name: 'feature_set_objective_links',
      title: 'Set feature objective links',
      description:
        'Replace the full set of objective/key-result links of a feature (feeds auto-rollup progress). Pass an empty array to detach.',
      inputSchema: featureSetObjectiveLinksSchema,
      handler: (args) => {
        const { featureId, links } = featureSetObjectiveLinksSchema.parse(args)
        const previous = featureStore.setObjectiveLinks(featureId, links)
        const feature = featureStore.get(featureId)
        if (!feature) throw new Error(`feature not found: ${featureId}`)
        notify.broadcast('feature:updated', feature)
        // Notifica tanto os objetivos que ganharam quanto os que perderam a feature.
        notify.affectedObjectivesForFeatureLinks([...previous, ...links])
        return ok({ feature })
      },
    },
  ]
}

// ---- overview ----

const emptySchema = z.object({})

function overviewTools(): ToolDef[] {
  return [
    {
      name: 'overview_get',
      title: 'Get overview',
      description:
        'Aggregated dashboard snapshot: objective tree with progress, pending tasks (sorted), counts, and active features with session activity. attentionResponses: TUI menu answers given from the UI in the last windowDays (count, median wait in ms since the menu appeared, crew-child subset, by choice).',
      inputSchema: emptySchema,
      handler: (args) => {
        emptySchema.parse(args ?? {})
        return ok({
          overview: overviewStore.getOverview(),
          attentionResponses: attentionResponseStats(),
        })
      },
    },
  ]
}

// ---- handoffs cross-repo ----

interface ResolvedRepo {
  id: string
  label: string
  path: string
  role: string | null
  projectId: string
  projectName: string
}

interface RepoLookupRow {
  id: string
  label: string
  path: string
  role: string | null
  project_id: string
  project_name: string
}

// Resolve um repo por label OU path (a mãe não conhece os ids internos). Lança
// erros legíveis (consumidos por outra sessão Claude): 0 → não encontrado;
// >1 → lista os candidatos pra a mãe desambiguar.
function resolveRepo(ref: string): ResolvedRepo {
  const rows = getDb()
    .prepare(
      `SELECT r.id, r.label, r.path, r.role, r.project_id, p.name AS project_name
         FROM repos r JOIN projects p ON p.id = r.project_id
        WHERE r.label = ? OR r.path = ?`,
    )
    .all(ref, ref) as RepoLookupRow[]
  if (rows.length === 0) throw new Error(`repo não encontrado: ${ref}`)
  if (rows.length > 1) {
    const candidates = rows
      .map((r) => `- label="${r.label}" path="${r.path}" project="${r.project_name}"`)
      .join('\n')
    throw new Error(
      `repo ambíguo: ${ref} corresponde a ${rows.length} repos. Desambigue pelo path exato:\n${candidates}`,
    )
  }
  const r = rows[0]
  return {
    id: r.id,
    label: r.label,
    path: r.path,
    role: r.role,
    projectId: r.project_id,
    projectName: r.project_name,
  }
}

// Resolve a atividade ao vivo da sessão-filha de um handoff: childSessionId
// (sessions.id) → cc_session_id → derivação do session-activity (status do PID +
// tail do JSONL). Null se não há filha atrelada ou se ela não está mais no índice.
// Reusa getActivityFor (mesma derivação do watcher) — sem duplicar a lógica de
// status/enrichment. Filha sem id nativo (Codex): status pela PTY.
function childActivity(childSessionId: string | null): ReturnType<typeof getActivityFor> {
  if (!childSessionId) return null
  const row = getDb()
    .prepare('SELECT cc_session_id, provider FROM sessions WHERE id = ?')
    .get(childSessionId) as { cc_session_id: string | null; provider: string | null } | undefined
  if (!row) return null
  if (row.cc_session_id) return getActivityFor(row.cc_session_id)
  if (!row.provider || row.provider === 'claude') return null
  return {
    status: ptyStatusFor(childSessionId),
    lastActivityAt: ptyManager.getActivitySample(childSessionId)?.lastByteAt ?? null,
    lastText: null,
    tokens: undefined,
  }
}

function handoffDispatchMessage(
  alias: string,
  repoLabel: string,
  provider: AgentProviderId | undefined,
): string {
  if (provider && provider !== 'claude') {
    return `Filha "${alias}" despachada para ${repoLabel}. Ela é ${provider}, sem canal cross-session e sem espelho da tela: acompanhe por handoff_result. Não há canal seguro para escrever nela (handoff_message é recusado — o Enter poderia aprovar um overlay de aprovação); se ela travar, avise o humano.`
  }
  return `Filha "${alias}" despachada para ${repoLabel}. Mande AGORA a primeira SendMessage({ to: "${alias}", ... }) — é ela que abre o canal de volta (a filha responde a quem escreveu primeiro).`
}

// Resolve label+role de um repo por id (pra descrever a ponta oposta de uma aresta).
// Recusa do dedup por repo-alvo, montada a partir do handoff que o create achou
// dentro da transação. Diz de quem é a filha (sem entregar o handle) e como forçar.
function duplicateMessage(
  existing: Handoff,
  targetLabel: string,
  mother: string | null,
): string {
  const alias = handoffStore.childAlias(existing.childSessionId)
  const who = alias ? `a filha "${alias}"` : 'uma filha (ainda sem alias)'
  const status = `(status: ${existing.status})`
  const tail =
    'Se este trabalho é seu e precisa substituir a atual, chame de novo com force: true e forceReason explicando o motivo (a atual vira interrupted); senão aguarde a atual concluir.'
  if (mother && existing.motherSessionId === mother) {
    return `Você JÁ despachou ${who} para ${targetLabel} ${status} — ela é sua. Fale com ela por SendMessage({ to: "${alias ?? ''}" }) ou acompanhe por handoff_result em vez de despachar outra. ${tail}`
  }
  if (mother) {
    return `${targetLabel} já tem ${who} ativa ${status} e ela NÃO é sua — foi despachada por outra sessão-mãe. Não assuma o controle de uma filha que você não despachou. ${tail}`
  }
  return `${targetLabel} já tem ${who} ativa ${status} — e ela pode NÃO ser sua: sem identidade da sessão-mãe, o dedup é por repo-alvo. Não assuma o controle de uma filha que você não despachou. ${tail}`
}

function repoBrief(id: string): {
  id: string
  label: string
  role: string | null
} {
  const row = getDb().prepare('SELECT id, label, role FROM repos WHERE id = ?').get(id) as
    { id: string; label: string; role: string | null } | undefined
  if (!row) return { id, label: id, role: null }
  return row
}

const repoConnectionsGetSchema = z.object({ repo: z.string().min(1) })

const handoffMode = z.enum(['plan', 'auto-edits', 'interactive'])

const sessionHandoffSchema = z.object({
  targetRepo: z.string().min(1),
  task: z.string().min(1),
  fromRepo: z.string().min(1).optional(),
  featureId: z.string().min(1).optional(),
  context: z.string().optional(),
  // Modo de permissão da filha. 'plan' (read-only) p/ investigação; 'auto-edits'
  // (edita, com denylist destrutivo) p/ implementação; 'interactive' = pergunta
  // tudo (legado). Default: 'plan' (seguro). O humano confirma no gate.
  mode: handoffMode.optional(),
  // Substitui o handoff ativo do mesmo repo-alvo (default: recusa com erro, sem
  // entregar o handle da filha que já está lá). Exige forceReason, gravado em
  // handoff_events: só existe UM handoff ativo por repo (índice da migration 054).
  force: z.boolean().optional(),
  forceReason: z.string().trim().min(1).max(500).optional(),
  // CLI da filha. Default 'claude'. 'codex' (experimental) só sobe em mode
  // 'plan': sem denylist destrutivo, auto-edits autônomo é recusado no spawn.
  provider: z.enum(['claude', 'codex']).optional(),
})

const handoffResultSchema = z.object({ handoffId: z.string().min(1) })

// Espelha HandoffStatus em shared/types/ipc.ts. needs_input é in-flight (vivo);
// interrupted é recuperável (filha morreu sem erro real, NÃO conta como ativo).
const handoffStatusEnum = z.enum([
  'pending',
  'approved',
  'running',
  'needs_input',
  'done',
  'rejected',
  'failed',
  'interrupted',
])

const handoffListSchema = z.object({
  status: z.union([handoffStatusEnum, z.array(handoffStatusEnum)]).optional(),
})

const handoffReportSchema = z.object({
  handoffId: z.string().min(1),
  summary: z.string().min(1),
})

const handoffProgressSchema = z.object({
  handoffId: z.string().min(1),
  step: z.string().min(1),
})

// Mensagem da MÃE → filha (resposta a um needs_input, ou orientação no meio do
// trabalho). text não-vazio, cap 4096 (uma colagem; prompts longos vão no kickoff).
const handoffMessageSchema = z.object({
  handoffId: z.string().min(1),
  text: z.string().min(1).max(4096),
})

// Pergunta levantada PELA FILHA → mãe (decisão/bloqueio). question não-vazio.
const handoffAskSchema = z.object({
  handoffId: z.string().min(1),
  question: z.string().min(1).max(4096),
})

// GUARD DE POSSE das tools de filha (report/progress/ask). O carimbo de sessão do
// MCP identifica QUEM chamou — para a filha, é o mesmo `sessions.id` que mora em
// handoffs.child_session_id.
//
// Por que existe: depois da passagem de bastão a ANTECESSORA continua viva
// (decisão de produto) e ainda tem o handoffId no contexto dela. Sem esta
// checagem, o handoff_report dela ao fim do próprio turno marcaria como `done` um
// trabalho que agora é da sucessora — o card fecharia no painel com a sucessora
// ainda trabalhando.
//
// RETROCOMPATIBILIDADE (o que NÃO pode quebrar): handoff sem filha atrelada, ou
// chamador sem carimbo (config MCP global/legada, sessão que subiu antes do
// carimbo por sessão), passa direto — não dá pra distinguir "legado" de
// "passou o bastão" quando não há identidade, e recusar aí quebraria handoffs em
// curso. O guard só morde quando as DUAS identidades existem e divergem.
function assertCurrentChild(
  handoff: { id: string; childSessionId: string | null },
  ctx: McpRequestContext,
  action: string,
): void {
  const caller = ctx.motherSessionId
  if (!caller || !handoff.childSessionId) return
  if (handoff.childSessionId === caller) return
  const nowAlias = handoffStore.childAlias(handoff.childSessionId)
  throw new Error(
    `${action} recusado: este handoff (${handoff.id}) já não é seu. Você passou o bastão — quem responde por ele agora é ${nowAlias ? `a sessão "${nowAlias}"` : 'a sessão sucessora'}, e fechar/atualizar o card daqui apagaria o trabalho dela. Se tem algo a dizer sobre esse trabalho, mande por SendMessage; encerre o SEU turno sem tocar no handoff.`,
  )
}

function handoffTools(notify: McpNotify, ctx: McpRequestContext): ToolDef[] {
  return [
    {
      name: 'repo_connections_get',
      title: 'Get repo connections',
      description:
        'Inspect a repo (by label or path) and its dependency-graph connections to other repos. Use before session_handoff to understand how the current repo relates to others.',
      inputSchema: repoConnectionsGetSchema,
      handler: (args) => {
        const { repo } = repoConnectionsGetSchema.parse(args)
        const r = resolveRepo(repo)
        const connections = repoDepStore.listByRepo(r.id).map((edge) => {
          const outgoing = edge.fromRepoId === r.id
          const otherId = outgoing ? edge.toRepoId : edge.fromRepoId
          return {
            id: edge.id,
            kind: edge.kind,
            label: edge.label,
            direction: (outgoing ? 'outgoing' : 'incoming') as 'outgoing' | 'incoming',
            otherRepo: repoBrief(otherId),
          }
        })
        return ok({
          repo: {
            id: r.id,
            label: r.label,
            path: r.path,
            role: r.role,
            project: r.projectName,
          },
          connections,
        })
      },
    },
    {
      name: 'session_handoff',
      title: 'Hand off work to another repo',
      description:
        'Delegate end-to-end work to a connected repo. Spawns the child session immediately — no human approval step. Pass fromRepo = the repo you are working in (orients the context). Choose mode: "plan" (child is read-only — for investigation), "auto-edits" (child edits files autonomously, destructive commands blocked — for implementation), or "interactive" (asks for everything). If the target repo already has an active handoff the call is REFUSED with an error — either because you already dispatched a child there, or because the child belongs to another mother session and you do not inherit it. A repo has at most ONE active handoff: force=true together with forceReason (required, recorded in the handoff trail) REPLACES the active one (it becomes interrupted; its child session is not killed). Returns { handoffId, alias, status }. `alias` is the child session name and the ADDRESS for cross-session messaging: send it the first SendMessage({ to: alias, message: ... }) right after this call — that message establishes the channel back to you (the child answers whoever wrote first). Durable state stays in handoff_list / handoff_result. Optional provider: "claude" (default) or "codex" (experimental, only with mode "plan" — Codex has no destructive-command denylist, so editing modes are refused).',
      inputSchema: sessionHandoffSchema,
      handler: (args) => {
        const input = sessionHandoffSchema.parse(args)
        const provider = input.provider ?? 'claude'
        // Recusa ANTES de criar o handoff: filha Codex que editaria sem trava
        // nunca vira linha no inbox. O spawnSession repete a checagem (autoridade).
        assertAutonomousSpawnGuarded(
          provider,
          resolvePermissionMode(permissionModeForHandoffMode(input.mode ?? 'plan')),
          true,
        )
        // O gate humano spawna pelo renderer, que não sabe o provider (o handoff
        // não o guarda): a filha subiria como claude em silêncio.
        if (provider !== 'claude' && getPref('handoffs.requireApproval', false)) {
          throw new Error(
            'provider "codex" não é suportado com a aprovação humana ligada (pref handoffs.requireApproval). Desligue a aprovação ou use provider "claude".',
          )
        }

        // Reconcilia órfãos ANTES do dedup: filha morta/crashada não pode barrar
        // um despacho novo pro mesmo repo-alvo como falso-ativo.
        handoffStore.reconcileStuck()

        const target = resolveRepo(input.targetRepo)
        const from = input.fromRepo ? resolveRepo(input.fromRepo) : null

        // force sem motivo é recusado antes de qualquer efeito: o motivo é o que
        // fica na trilha quando um handoff ativo é substituído.
        if (input.force && !input.forceReason) {
          return ok({
            error:
              'force: true exige forceReason (por que substituir o handoff ativo deste repo). Ele fica gravado na trilha do handoff.',
          })
        }

        // Arestas do target → shape do compose, orientadas pela MÃE (fromRepo).
        // Prioriza as que tocam o fromRepo; se não há fromRepo, ainda inclui as
        // do target com uma direção plausível.
        const allEdges = repoDepStore.listByRepo(target.id)
        const toCompose = (edge: RepoDependency): HandoffEdge => {
          const targetIsFrom = edge.fromRepoId === target.id
          return {
            kind: edge.kind,
            label: edge.label,
            // from-mother: mãe → target (aresta entra no target).
            // to-mother:   target → mãe (aresta sai do target).
            direction: targetIsFrom ? 'to-mother' : 'from-mother',
          }
        }
        const edges: HandoffEdge[] = from
          ? allEdges
              .filter((e) => e.fromRepoId === from.id || e.toRepoId === from.id)
              .map(toCompose)
          : allEdges.map(toCompose)

        // Sem featureId explícito a filha trabalha na frente da mãe — mesma regra
        // do prepareHandoff e do spawn-child. Resolvido aqui (e não só no spawn)
        // pra que o registro do handoff e o briefing falem da mesma feature.
        const motherFeatureId = ctx.motherSessionId
          ? ((
              getDb().prepare('SELECT feature_id FROM sessions WHERE id = ?').get(
                ctx.motherSessionId,
              ) as { feature_id: string | null } | undefined
            )?.feature_id ?? null)
          : null
        const featureId = inheritFeatureId(input.featureId, motherFeatureId)
        const featureTitle = featureId
          ? ((
              getDb().prepare('SELECT title FROM features WHERE id = ?').get(featureId) as
                { title: string } | undefined
            )?.title ?? null)
          : null

        const handoffId = randomUUID()
        const mode = input.mode ?? 'plan'
        // Alias = identidade endereçável da filha. Resolvido ANTES do compose
        // porque o briefing anuncia à filha o próprio apelido, e antes do spawn
        // porque é o `-n <name>` — o endereço do SendMessage.
        const alias = buildHandoffAlias({
          role: roleForHandoffMode(mode),
          task: input.task,
          taken: handoffStore.activeSessionNames(),
        })
        const composed = composeHandoffPrompt({
          targetRepoLabel: target.label,
          targetRepoPath: target.path,
          motherRepoLabel: from?.label,
          task: input.task,
          edges,
          featureTitle,
          context: input.context,
          handoffId,
          alias,
          mode,
          provider: input.provider,
        })

        // Dedup por alvo: a posse do repo é decidida DENTRO do create, numa
        // transação (o índice UNIQUE da 054 é a garantia por baixo). Nunca devolve
        // o handle do handoff encontrado: entregar { handoffId, alias, status }
        // fazia uma mãe adotar a filha de OUTRA e passar a conversar com ela.
        let handoff: Handoff
        try {
          handoff = handoffStore.create(
            {
              id: handoffId,
              // Carimbo do app (null quando a sessão veio da config global legada).
              motherSessionId: ctx.motherSessionId,
              targetRepoId: target.id,
              // Origem da delegação (a mãe), pra instrumentação cross-repo. Null se
              // a MCP não passou fromRepo.
              fromRepoId: from?.id ?? null,
              featureId,
              task: input.task,
              contextJson: input.context ?? null,
              composedPrompt: composed,
              mode,
            },
            input.force && input.forceReason ? { force: { reason: input.forceReason } } : {},
          )
        } catch (err) {
          if (!handoffStore.isHandoffDuplicateError(err)) throw err
          return ok({
            duplicate: true,
            error: duplicateMessage(err.existing, target.label, ctx.motherSessionId),
          })
        }

        // Kill-switch: com handoffs.requireApproval ligado o handoff nasce pending
        // e o gate humano da UI decide (e spawna pelo renderer). Default false —
        // delegar não pede aprovação.
        if (getPref('handoffs.requireApproval', false)) {
          notify.broadcast('handoff:updated', handoff)
          return ok({
            handoffId,
            alias: null,
            status: 'pending',
            message:
              'Aprovação humana está LIGADA (pref handoffs.requireApproval): o handoff aguarda o gate no app. Acompanhe com handoff_list/handoff_result — o alias aparece quando a filha subir.',
          })
        }

        // Spawn direto no MAIN (seam spawn-child), sem passar pelo renderer. O
        // broadcast abaixo é o que mantém a UI viva agora que ela não spawna mais.
        try {
          const kickoff = `Comece a tarefa do handoff descrita no seu contexto de sistema. Ao terminar, chame a MCP tool handoff_report com handoffId="${handoffId}".`
          const child = spawnHandoffChild({
            repoId: target.id,
            name: alias,
            featureId,
            motherSessionId: ctx.motherSessionId,
            initialPrompt: kickoff,
            systemPromptText: composed,
            permissionMode: permissionModeForHandoffMode(mode),
            provider: input.provider,
          })
          const running = handoffStore.markRunning(handoffId, child.id)
          notify.broadcast('handoff:updated', running)
          emitSessionLinkPulse({ fromSessionId: ctx.motherSessionId, toSessionId: child.id, kind: 'task' })
          return ok({
            handoffId,
            alias,
            status: running.status,
            message: handoffDispatchMessage(alias, target.label, input.provider),
          })
        } catch (err) {
          // Spawn falhou (repo sumiu do disco, PTY não subiu): o handoff não pode
          // ficar preso em pending — vira failed com o erro visível no inbox.
          const msg = err instanceof Error ? err.message : String(err)
          const failed = handoffStore.fail(handoffId, msg)
          notify.broadcast('handoff:updated', failed)
          return ok({
            handoffId,
            alias: null,
            status: failed.status,
            error: msg,
          })
        }
      },
    },
    {
      name: 'handoff_result',
      title: 'Poll handoff result',
      description:
        'Read the durable state and live TELEMETRY of one handoff — not the conversation channel (that is SendMessage to the child alias). Returns { status, currentStep, stepUpdatedAt, pendingQuestion, summary, error } plus { liveStatus, lastActivityAt, lastText, tokens }, which cross-session messaging does NOT give you: liveStatus (working|waiting|idle|ended) reflects the child PTY in real time, so it is how you tell genuine progress from a stall. status=needs_input means the child raised a blocker (pendingQuestion) — answer it over SendMessage, or with handoff_message as fallback. needs_input only clears when the answer goes through handoff_message or the app inbox; the child reporting progress does NOT clear it, so a needs_input whose currentStep keeps advancing means the child already got your answer off-band and resumed. Read this at supervision ticks; do not busy-poll in place of talking to the child.',
      inputSchema: handoffResultSchema,
      handler: (args) => {
        const { handoffId } = handoffResultSchema.parse(args)
        const handoff = handoffStore.get(handoffId)
        if (!handoff) throw new Error(`handoff não encontrado: ${handoffId}`)

        // A mãe está lendo o resultado: se já está done, marca como consumido
        // (proxy de "a mãe consumiu o resultado"). Idempotente no store.
        if (handoff.status === 'done') handoffStore.markConsumed(handoffId)

        // Enriquecimento ao vivo: resolve childSessionId (sessions.id) → cc_session_id
        // e cruza com a derivação do session-activity (índice de PIDs + tail do JSONL).
        // Null quando a filha ainda não foi atrelada ou já não está no índice.
        const activity = childActivity(handoff.childSessionId)

        return ok({
          status: handoff.status,
          currentStep: handoff.currentStep,
          stepUpdatedAt: handoff.stepUpdatedAt,
          pendingQuestion: handoff.pendingQuestion,
          summary: handoff.summary,
          error: handoff.error,
          liveStatus: activity?.status ?? null,
          lastActivityAt: activity?.lastActivityAt ?? null,
          lastText: activity?.lastText ?? null,
          tokens: activity?.tokens ?? null,
        })
      },
    },
    {
      name: 'handoff_message',
      title: 'Message the child session',
      description:
        'FALLBACK channel to the child. The primary way to talk to a running child is SendMessage({ to: <alias from handoff_list>, ... }) — real-time, no PTY involved. Use handoff_message only when that path is unavailable: the child never bound a cross-session socket, or your message came back held/undelivered. It pastes the text straight into the child’s REPL, so it requires the handoff in-flight (running or needs_input) AND the child PTY alive; after delivery the child resumes (status back to running). Read the pending blocker with handoff_result first.',
      inputSchema: handoffMessageSchema,
      handler: (args) => {
        const { handoffId, text } = handoffMessageSchema.parse(args)
        const handoff = handoffStore.get(handoffId)
        if (!handoff) throw new Error(`handoff não encontrado: ${handoffId}`)
        if (handoff.status !== 'running' && handoff.status !== 'needs_input') {
          throw new Error(
            `handoff ${handoffId} não está em andamento (status: ${handoff.status}); só dá pra mandar mensagem a uma filha viva (running/needs_input).`,
          )
        }
        if (!handoff.childSessionId) {
          throw new Error(`handoff ${handoffId} ainda não tem sessão-filha atrelada.`)
        }
        if (!ptyManager.isRunning(handoff.childSessionId)) {
          throw new Error(
            `a sessão-filha do handoff ${handoffId} não está mais viva (PTY encerrada) — não dá pra entregar a mensagem.`,
          )
        }
        // A mãe não vê a tela da filha: o Enter do paste não pode cair num menu.
        const childId = handoff.childSessionId
        return injectIntoChildGuarded(childId, text).then(() => {
          // A mãe respondeu: a filha retoma (needs_input → running, limpa a pergunta).
          const updated = handoffStore.resume(handoffId)
          notify.broadcast('handoff:updated', updated)
          emitSessionLinkPulse({
            fromSessionId: ctx.motherSessionId ?? handoff.motherSessionId,
            toSessionId: childId,
            kind: handoff.status === 'needs_input' ? 'answer' : 'message',
          })
          return ok({ status: updated.status, delivered: true })
        })
      },
    },
    {
      name: 'handoff_ask',
      title: 'Ask the mother a question',
      description:
        'Called by the CHILD session when it hits a blocker it must NOT decide alone (out-of-scope work, material ambiguity, architectural trade-off, missing credential). Records the question and moves the handoff to needs_input — the durable half of the blocker. Asking again before the mother answers STACKS the new question onto the pending one (nothing is dropped). Send the same blocker to your orchestrator over SendMessage too (real-time half), then STOP and wait. Do NOT use for routine progress (handoff_progress) or completion (handoff_report).',
      inputSchema: handoffAskSchema,
      handler: (args) => {
        const { handoffId, question } = handoffAskSchema.parse(args)
        const existing = handoffStore.get(handoffId)
        if (!existing) throw new Error(`handoff não encontrado: ${handoffId}`)
        assertCurrentChild(existing, ctx, 'handoff_ask')
        const updated = handoffStore.ask(handoffId, question)
        notify.broadcast('handoff:updated', updated)
        emitSessionLinkPulse({
          fromSessionId: existing.childSessionId ?? ctx.motherSessionId,
          toSessionId: updated.motherSessionId,
          kind: 'question',
        })
        return ok({
          status: updated.status,
          pendingQuestion: updated.pendingQuestion,
        })
      },
    },
    {
      name: 'handoff_list',
      title: 'List handoffs',
      description:
        'List handoffs (optionally filtered by status), most recent first. Returns { handoffId, alias, targetRepo, status, mode, currentStep, task }. `alias` is the child session name (e.g. "mauricio-auth-refactor") — it is the ADDRESS for SendMessage({ to: alias }), so use it to talk to a running child in real time. null when the child has not spawned (or already died). This is the source of truth for the roster: prefer it over ListAgents, which also lists sessions that are not yours.',
      inputSchema: handoffListSchema,
      handler: (args) => {
        const { status } = handoffListSchema.parse(args)
        const items = handoffStore.list(status ? { status } : undefined).map((h) => ({
          handoffId: h.id,
          alias: handoffStore.childAlias(h.childSessionId),
          targetRepo: h.targetRepoLabel,
          status: h.status,
          mode: h.mode,
          currentStep: h.currentStep,
          task: h.task,
        }))
        return ok({ items })
      },
    },
    {
      name: 'handoff_progress',
      title: 'Report handoff progress',
      description:
        'Called by the CHILD session to report a NON-TERMINAL progress step (does NOT mark done). Use this throughout the work so the mother’s polls are informative. It does NOT close a blocker you raised with handoff_ask: the handoff stays needs_input until the mother answers. Only handoff_report marks the work done.',
      inputSchema: handoffProgressSchema,
      handler: (args) => {
        const { handoffId, step } = handoffProgressSchema.parse(args)
        const existing = handoffStore.get(handoffId)
        if (!existing) throw new Error(`handoff não encontrado: ${handoffId}`)
        assertCurrentChild(existing, ctx, 'handoff_progress')
        const updated = handoffStore.progress(handoffId, step)
        notify.broadcast('handoff:updated', updated)
        // Só passo novo: repetir o mesmo passo não é notícia para a mãe.
        if (existing.currentStep !== updated.currentStep)
          emitSessionLinkPulse({
            fromSessionId: existing.childSessionId ?? ctx.motherSessionId,
            toSessionId: updated.motherSessionId,
            kind: 'progress',
          })
        // Progresso não responde pergunta aberta: se a filha segue bloqueada,
        // devolve o bloqueio junto (antes o progresso apagava a pergunta e a mãe
        // nunca chegava a vê-la).
        if (updated.status === 'needs_input') {
          return ok({
            status: updated.status,
            currentStep: updated.currentStep,
            pendingQuestion: updated.pendingQuestion,
            note: 'Progresso registrado, mas sua pergunta continua ABERTA — o handoff segue needs_input até a mãe responder. Não trate isto como resposta.',
          })
        }
        return ok({ status: updated.status, currentStep: updated.currentStep })
      },
    },
    {
      name: 'handoff_report',
      title: 'Report handoff result',
      description:
        'Called by the CHILD session ONLY when the handed-off work is fully complete AND verified (tests/typecheck pass). Records the summary and marks the handoff done. Do NOT call this before the work is actually finished — use handoff_progress for interim updates.',
      inputSchema: handoffReportSchema,
      handler: (args) => {
        const { handoffId, summary } = handoffReportSchema.parse(args)
        const existing = handoffStore.get(handoffId)
        if (!existing) throw new Error(`handoff não encontrado: ${handoffId}`)
        assertCurrentChild(existing, ctx, 'handoff_report')
        const updated = handoffStore.report(handoffId, summary)
        notify.broadcast('handoff:updated', updated)
        emitSessionLinkPulse({
          fromSessionId: existing.childSessionId ?? ctx.motherSessionId,
          toSessionId: updated.motherSessionId,
          kind: 'report',
        })
        // Segundo report no mesmo handoff: o store preserva o summary original e
        // guarda este na trilha. Avisa em vez de responder um 'done' que finge
        // sucesso — antes o resultado duplicado sumia silenciosamente.
        if (existing.status === 'done') {
          return ok({
            status: updated.status,
            duplicate: true,
            warning: `handoff ${handoffId} já havia sido reportado — o summary original foi MANTIDO e este segundo ficou só na trilha de eventos. Se o resultado mudou de verdade, avise a mãe por SendMessage.`,
          })
        }
        return ok({ status: updated.status })
      },
    },
  ]
}

// Espelha ListPullRunsFilter (repo-pull-store).
const repoPullRunListSchema = z.object({
  limit: z.number().int().positive().optional(),
})

// Histórico do auto-pull de repos (repo_pull_runs, migration 033) —
// visibilidade direta de "está funcionando?".
function repoPullTools(): ToolDef[] {
  return [
    {
      name: 'repo_pull_run_list',
      title: 'List repo auto-pull runs',
      description:
        'List the run history of the repo auto-pull/pull-all job (trigger auto|manual, timing, counts per status, per-repo results with branch breakdown), most recent first. Optional filter: limit (default 20).',
      inputSchema: repoPullRunListSchema,
      handler: (args) => {
        const filter = repoPullRunListSchema.parse(args)
        return ok({ items: repoPullStore.listPullRuns(filter) })
      },
    },
  ]
}

// ---- diagrams ----
//
// O caminho de escrita PREFERIDO do agente é o skeleton (shared/diagram-skeleton):
// nós/setas semânticos sem x/y, auto-layout no conversor. diagram_patch opera em
// cima da cena vigente (preserva o refino manual do humano); diagram_update
// substitui a cena inteira e só deve ser usado quando o redesenho é intencional.
// Delete é a exceção documentada no topo: two-step archive → delete + confirm.

const diagramKind = z.enum(['architecture', 'flow', 'sequence', 'er', 'mindmap', 'other'])

// Espelha DiagramParentType (shared/types/ipc.ts).
const diagramParentType = z.enum([
  'project',
  'repo',
  'feature',
  'task',
  'objective',
  'key_result',
  'session',
  'handoff',
])

// Espelha DiagramSkeletonElement (shared/diagram-skeleton.ts).
const skeletonElementType = z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line'])

const skeletonElementSchema = z.object({
  id: z.string().min(1),
  type: skeletonElementType,
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  label: z.object({ text: z.string() }).optional(),
  text: z.string().optional(),
  start: z.object({ id: z.string().min(1) }).optional(),
  end: z.object({ id: z.string().min(1) }).optional(),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
})

// Cena Excalidraw crua (shape do Excalidraw, não nosso — elementos ficam unknown).
const diagramSceneSchema = z.object({
  elements: z.array(z.unknown()),
  appState: z.record(z.string(), z.unknown()).optional(),
})

const diagramLinkInputSchema = z.object({
  parentType: diagramParentType,
  parentId: z.string().min(1),
})

// Exatamente UM de elements|scene: skeleton e cena crua são caminhos exclusivos.
const exactlyOneSceneInput = (v: { elements?: unknown; scene?: unknown }) =>
  (v.elements !== undefined) !== (v.scene !== undefined)
const EXACTLY_ONE_MSG = 'provide exactly one of elements (skeleton) or scene (raw Excalidraw scene)'

const diagramCreateSchema = z
  .object({
    title: z.string().trim().min(1),
    kind: diagramKind.optional(),
    summary: z.string().min(1),
    elements: z.array(skeletonElementSchema).optional(),
    scene: diagramSceneSchema.optional(),
    links: z.array(diagramLinkInputSchema).optional(),
  })
  .refine(exactlyOneSceneInput, { message: EXACTLY_ONE_MSG })

const diagramGetSchema = z.object({
  id: z.string().min(1),
  format: z.enum(['skeleton', 'full']).default('skeleton'),
})

const diagramListSchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  kind: diagramKind.optional(),
  parentType: diagramParentType.optional(),
  parentId: z.string().optional(),
  search: z.string().optional(),
})

// Espelha DiagramPatchOp: update = id + campos parciais do skeleton.
const diagramPatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), element: skeletonElementSchema }),
  z.object({
    op: z.literal('update'),
    id: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    label: z.object({ text: z.string() }).optional(),
    text: z.string().optional(),
    start: z.object({ id: z.string().min(1) }).optional(),
    end: z.object({ id: z.string().min(1) }).optional(),
    strokeColor: z.string().optional(),
    backgroundColor: z.string().optional(),
  }),
  z.object({ op: z.literal('delete'), id: z.string().min(1) }),
])

const diagramPatchSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  ops: z.array(diagramPatchOpSchema).min(1),
})

const diagramUpdateSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string().min(1),
    elements: z.array(skeletonElementSchema).optional(),
    scene: diagramSceneSchema.optional(),
  })
  .refine(exactlyOneSceneInput, { message: EXACTLY_ONE_MSG })

const diagramDeleteSchema = z.object({
  id: z.string().min(1),
  confirm: z.literal(true),
})

const diagramLinkSchema = z.object({
  id: z.string().min(1),
  parentType: diagramParentType,
  parentId: z.string().min(1),
})

// Meta + links, sem a cena: o retorno padrão das tools de diagrama (a cena crua
// tem centenas de KB; o agente trabalha no skeleton).
function diagramToMeta(diagram: Diagram): Record<string, unknown> {
  const { scene: _scene, ...meta } = diagram
  return meta
}

function diagramTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'diagram_create',
      title: 'Create diagram',
      description:
        'Create a diagram on the Excalidraw canvas. Preferred input: elements = a SKELETON (semantic nodes/arrows; omit x/y for auto-layout; arrows reference node ids via start/end and support label). Alternatively pass scene = a raw Excalidraw scene. Exactly one of elements|scene. Optional links attach it to parents (feature, task, objective, ...). Returns the diagram meta plus the skeleton derived from the stored scene.',
      inputSchema: diagramCreateSchema,
      handler: (args) => {
        const input = diagramCreateSchema.parse(args)
        const fromSkeleton = input.elements !== undefined
        const scene: DiagramScene = fromSkeleton
          ? { elements: skeletonToElements(input.elements!) }
          : (input.scene as DiagramScene)
        const diagram = diagramStore.create({
          title: input.title,
          kind: input.kind,
          scene,
          sourceFormat: fromSkeleton ? 'skeleton' : 'scene',
          source: fromSkeleton ? JSON.stringify(input.elements) : null,
          author: 'claude',
          summary: input.summary,
          links: input.links,
        })
        notify.broadcast('diagram:updated', diagram)
        return ok({
          diagram: diagramToMeta(diagram),
          skeleton: elementsToSkeleton(diagram.scene.elements),
        })
      },
    },
    {
      name: 'diagram_get',
      title: 'Get diagram',
      description:
        'Get one diagram by id. format "skeleton" (default) returns the meta, the semantic skeleton derived from the current scene, and the version history (metas); format "full" returns the raw Excalidraw scene. Returns { diagram: null } when not found.',
      inputSchema: diagramGetSchema,
      handler: (args) => {
        const { id, format } = diagramGetSchema.parse(args)
        const diagram = diagramStore.get(id)
        if (!diagram) return ok({ diagram: null })
        if (format === 'full') return ok({ diagram })
        return ok({
          diagram: diagramToMeta(diagram),
          skeleton: elementsToSkeleton(diagram.scene.elements),
          versions: diagramStore.listVersions(id),
        })
      },
    },
    {
      name: 'diagram_list',
      title: 'List diagrams',
      description:
        'List diagrams (metas only, no scene). Optional filters: status (active default | archived | all), kind, parent (parentType + parentId), free-text search on title.',
      inputSchema: diagramListSchema,
      handler: (args) => {
        const filter = diagramListSchema.parse(args)
        // Sem thumbnail: é um data-url de imagem, payload inútil pro agente.
        const items = diagramStore.list(filter).map(({ thumbnail: _thumb, ...meta }) => meta)
        return ok({ items })
      },
    },
    {
      name: 'diagram_patch',
      title: 'Patch diagram (preferred edit)',
      description:
        'PREFERRED way to edit a diagram: applies incremental ops (add | update | delete, addressing elements by skeleton id) on top of the CURRENT scene, so human refinements to layout/styling survive. Records a version snapshot (summary is the changelog line). Use diagram_update only for an intentional full redraw.',
      inputSchema: diagramPatchSchema,
      handler: (args) => {
        const { id, summary, ops } = diagramPatchSchema.parse(args)
        const existing = diagramStore.get(id)
        if (!existing) throw new Error(`diagram não encontrado: ${id}`)
        const elements = applyPatch(existing.scene.elements, ops)
        const diagram = diagramStore.updateScene({
          id,
          scene: { ...existing.scene, elements },
          snapshot: true,
          summary,
          author: 'claude',
        })
        notify.broadcast('diagram:updated', diagram)
        return ok({
          diagram: diagramToMeta(diagram),
          skeleton: elementsToSkeleton(diagram.scene.elements),
        })
      },
    },
    {
      name: 'diagram_update',
      title: 'Replace diagram scene',
      description:
        'FULL replacement of the scene (exactly one of elements = skeleton | scene = raw Excalidraw). This DISCARDS any human layout/styling refinement of the current scene — prefer diagram_patch for edits; use this only when redrawing from scratch is intentional. Records a version snapshot (summary is the changelog line).',
      inputSchema: diagramUpdateSchema,
      handler: (args) => {
        const input = diagramUpdateSchema.parse(args)
        const fromSkeleton = input.elements !== undefined
        const scene: DiagramScene = fromSkeleton
          ? { elements: skeletonToElements(input.elements!) }
          : (input.scene as DiagramScene)
        const diagram = diagramStore.updateScene({
          id: input.id,
          scene,
          snapshot: true,
          summary: input.summary,
          author: 'claude',
        })
        notify.broadcast('diagram:updated', diagram)
        return ok({
          diagram: diagramToMeta(diagram),
          skeleton: elementsToSkeleton(diagram.scene.elements),
        })
      },
    },
    {
      name: 'diagram_archive',
      title: 'Archive diagram',
      description:
        'Archive a diagram (reversible; it leaves active listings). Also the mandatory first step before diagram_delete.',
      inputSchema: idSchema,
      handler: (args) => {
        const { id } = idSchema.parse(args)
        const diagram = diagramStore.archive(id)
        notify.broadcast('diagram:updated', diagram)
        return ok({ id, status: diagram.status })
      },
    },
    {
      name: 'diagram_unarchive',
      title: 'Unarchive diagram',
      description: 'Restore an archived diagram to active.',
      inputSchema: idSchema,
      handler: (args) => {
        const { id } = idSchema.parse(args)
        const diagram = diagramStore.unarchive(id)
        notify.broadcast('diagram:updated', diagram)
        return ok({ id, status: diagram.status })
      },
    },
    {
      name: 'diagram_delete',
      title: 'Delete diagram (two-step)',
      description:
        'PERMANENTLY delete a diagram, its version history and links. Two-step guard: only an ARCHIVED diagram can be deleted, and confirm must be true. If the diagram is still active the call fails — archive first (diagram_archive), then delete.',
      inputSchema: diagramDeleteSchema,
      handler: (args) => {
        const { id } = diagramDeleteSchema.parse(args)
        try {
          // Sem force: o store recusa delete de diagrama não-arquivado.
          diagramStore.remove(id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('not archived')) {
            throw new Error(
              `diagram ${id} is still active — deletion is two-step: archive first (diagram_archive), then delete.`,
            )
          }
          throw err
        }
        notify.broadcast('diagram:deleted', { id })
        return ok({ id, deleted: true })
      },
    },
    {
      name: 'diagram_link',
      title: 'Link diagram to a parent',
      description:
        'Attach a diagram to a parent entity (project | repo | feature | task | objective | key_result | session | handoff) so it shows up in that context. Idempotent. Returns the full link set.',
      inputSchema: diagramLinkSchema,
      handler: (args) => {
        const { id, parentType, parentId } = diagramLinkSchema.parse(args)
        const links = diagramStore.link({
          diagramId: id,
          parentType,
          parentId,
        })
        notify.broadcast('diagramLinks:updated', { diagramId: id, links })
        return ok({ links })
      },
    },
    {
      name: 'diagram_unlink',
      title: 'Unlink diagram from a parent',
      description:
        'Remove one parent link from a diagram (the diagram itself is untouched). Returns the remaining link set.',
      inputSchema: diagramLinkSchema,
      handler: (args) => {
        const { id, parentType, parentId } = diagramLinkSchema.parse(args)
        const links = diagramStore.unlink({
          diagramId: id,
          parentType,
          parentId,
        })
        notify.broadcast('diagramLinks:updated', { diagramId: id, links })
        return ok({ links })
      },
    },
  ]
}

// ---- diagram library (.excalidrawlib) ----
//
// Biblioteca de shapes GLOBAL (compartilhada por todos os diagramas). Install
// aceita URL (fetch no main, mesmo caminho do IPC) ou o JSON já parseado;
// merge por id — reinstalar atualiza, nunca duplica. Retornos sem `elements`:
// payload de shape não serve pro agente.

const diagramLibraryInstallSchema = z
  .object({
    url: z.url().optional(),
    library_json: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => (v.url !== undefined) !== (v.library_json !== undefined), {
    message: 'provide exactly one of url or library_json',
  })

function libraryItemMeta(item: DiagramLibraryItem): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    status: item.status,
    elementCount: item.elements.length,
  }
}

function diagramLibraryTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'diagram_library_list',
      title: 'List shape library items',
      description:
        'List the items installed in the global Excalidraw shape library (shared by every diagram canvas). Returns id, name, status and elementCount per item — element payloads stay out.',
      inputSchema: z.object({}),
      handler: () => {
        return ok({
          items: diagramLibraryStore.getItems().map(libraryItemMeta),
        })
      },
    },
    {
      name: 'diagram_library_install',
      title: 'Install shape library',
      description:
        'Install an Excalidraw shape library (.excalidrawlib) into the global library. Exactly one of: url = direct link to a .excalidrawlib file (the public catalog at https://libraries.excalidraw.com hosts many — pass the library file URL), or library_json = the .excalidrawlib content as a JSON object. Items merge by id: re-installing the same library updates items instead of duplicating them. Returns how many items the file brought (added) plus the full library.',
      inputSchema: diagramLibraryInstallSchema,
      handler: async (args) => {
        const input = diagramLibraryInstallSchema.parse(args)
        const result =
          input.url !== undefined
            ? await installLibraryFromUrl(input.url)
            : installLibraryJson(input.library_json)
        notify.broadcast('diagramLibrary:updated', { items: result.items })
        return ok({
          added: result.added,
          items: result.items.map(libraryItemMeta),
        })
      },
    },
    {
      name: 'diagram_library_remove',
      title: 'Remove shape library item',
      description:
        'Remove one item from the global shape library by id (see diagram_library_list). Returns the remaining item metas.',
      inputSchema: idSchema,
      handler: (args) => {
        const { id } = idSchema.parse(args)
        const items = diagramLibraryStore.removeItem(id)
        notify.broadcast('diagramLibrary:updated', { items })
        return ok({ id, removed: true, items: items.map(libraryItemMeta) })
      },
    },
  ]
}

export function buildTools(
  notify: McpNotify,
  ctx: McpRequestContext = ANONYMOUS_CONTEXT,
): ToolDef[] {
  return [
    ...overviewTools(),
    ...objectiveTools(notify),
    ...taskTools(notify),
    ...featureTools(notify),
    ...loopTools(notify),
    ...handoffTools(notify, ctx),
    ...repoPullTools(),
    ...diagramTools(notify),
    ...diagramLibraryTools(notify),
    ...designTools(notify, ctx),
    ...videoTools(notify),
    ...meetingTools(notify),
    ...canvasTools(notify, ctx),
    ...agentTools(ctx),
    ...serviceTools(ctx),
  ]
}

export function registerTools(
  server: McpServer,
  notify: McpNotify,
  ctx: McpRequestContext = ANONYMOUS_CONTEXT,
): void {
  for (const tool of buildTools(notify, ctx)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      (args: unknown) => tool.handler(args),
    )
  }
}
