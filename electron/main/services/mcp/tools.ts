// Tools MCP — handlers finos: validação zod → store → notify → retorno.
// Sem lógica de negócio própria; os broadcasts espelham 1:1 o que a camada IPC
// emite (mesmos canais/payloads), então a UI atualiza ao vivo pra writes MCP.
// Sem deletes destrutivos: archive (reversível) é o máximo de remoção exposto.
import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import * as objectiveStore from '../objective-store'
import * as overviewStore from '../overview-store'
import * as taskStore from '../task-store'
import * as featureStore from '../feature-store'
import * as repoDepStore from '../repo-dependency-store'
import * as handoffStore from '../handoff-store'
import * as jobStore from '../scheduled-job-store'
import * as repoPullStore from '../repo-pull-store'
// Seam leaf (sem electron): dispara o run imediato sem importar a cadeia
// job-scheduler → job-runner → ipc/sessions (que criaria ciclo com mcp/server).
import { runJobNow } from '../job-run-now'
import { composeHandoffPrompt, type HandoffEdge } from '../handoff/compose-prompt'
// Seam de injeção mãe→filha (importa SÓ de inject.ts, não de ipc/sessions.ts —
// evita arrastar electron/ipcMain pros handlers e permite mockar nos testes).
import { injectIntoChild } from '../handoff/inject'
// Seam de spawn da filha (impl real em ipc/sessions.ts) — mesma motivação do
// injectIntoChild acima: nada de electron/ipcMain nos handlers.
import { spawnHandoffChild } from '../handoff/spawn-child'
import { buildHandoffAlias, roleForHandoffMode } from '../handoff/alias'
import { getActivityFor } from '../session-activity'
import { ptyManager } from '../pty-manager'
import { getDb } from '../db'
import { getPref } from '../prefs-store'
import { OBSERVE_ONLY_PERMISSION_MODES, permissionModeForHandoffMode } from '../spawn-flags'
import { randomUUID } from 'node:crypto'
import type {
  FeatureObjectiveLink,
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
  handler: (args: unknown) => ToolResult
}

// structuredContent precisa ser objeto JSON (spec); listas vão como { items }.
function ok(structured: Record<string, unknown>): ToolResult {
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
const objectiveUpdateSchema = objectiveCreateSchema
  .partial()
  .extend({ id: z.string().min(1) })

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
  businessRules: z.string().optional(),
  approach: z.string().optional(),
})

// Espelha UpdateFeatureInput.
const featureUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  status: featureStatus.optional(),
  objective: z.string().nullish(),
  synthMode: featureSynthMode.optional(),
  model: z.string().nullish(),
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
        'Create a feature in a project (writes its markdown doc). Optional seed sections: overview, businessRules, approach.',
      inputSchema: featureCreateSchema,
      handler: (args) => {
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
        'Update index fields of an existing feature by id (title, status, objective, synthMode, model).',
      inputSchema: featureUpdateSchema,
      handler: (args) => {
        const input = featureUpdateSchema.parse(args)
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
        'Aggregated dashboard snapshot: objective tree with progress, pending tasks (sorted), counts, and active features with session activity.',
      inputSchema: emptySchema,
      handler: (args) => {
        emptySchema.parse(args ?? {})
        return ok({ overview: overviewStore.getOverview() })
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
// tail do JSONL). Null se não há filha atrelada, se ela não tem cc_session_id
// ainda, ou se não está mais no índice. Reusa getActivityFor (mesma derivação do
// watcher) — sem duplicar a lógica de status/enrichment.
function childActivity(childSessionId: string | null): ReturnType<typeof getActivityFor> {
  if (!childSessionId) return null
  const row = getDb()
    .prepare('SELECT cc_session_id FROM sessions WHERE id = ?')
    .get(childSessionId) as { cc_session_id: string | null } | undefined
  if (!row?.cc_session_id) return null
  return getActivityFor(row.cc_session_id)
}

// Resolve label+role de um repo por id (pra descrever a ponta oposta de uma aresta).
function repoBrief(id: string): { id: string; label: string; role: string | null } {
  const row = getDb()
    .prepare('SELECT id, label, role FROM repos WHERE id = ?')
    .get(id) as { id: string; label: string; role: string | null } | undefined
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
  // Despacha mesmo havendo um handoff ativo pro mesmo repo-alvo (default: recusa
  // com erro, sem entregar o handle da filha que já está lá).
  force: z.boolean().optional(),
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
          repo: { id: r.id, label: r.label, path: r.path, role: r.role, project: r.projectName },
          connections,
        })
      },
    },
    {
      name: 'session_handoff',
      title: 'Hand off work to another repo',
      description:
        'Delegate end-to-end work to a connected repo. Spawns the child session immediately — no human approval step. Pass fromRepo = the repo you are working in (orients the context). Choose mode: "plan" (child is read-only — for investigation), "auto-edits" (child edits files autonomously, destructive commands blocked — for implementation), or "interactive" (asks for everything). If the target repo already has an active handoff the call is REFUSED with an error — either because you already dispatched a child there, or because the child belongs to another mother session and you do not inherit it; pass force=true to dispatch a second one anyway. Returns { handoffId, alias, status }. `alias` is the child session name and the ADDRESS for cross-session messaging: send it the first SendMessage({ to: alias, message: ... }) right after this call — that message establishes the channel back to you (the child answers whoever wrote first). Durable state stays in handoff_list / handoff_result.',
      inputSchema: sessionHandoffSchema,
      handler: (args) => {
        const input = sessionHandoffSchema.parse(args)

        // Reconcilia órfãos ANTES do dedup: filha morta/crashada não pode barrar
        // um despacho novo pro mesmo repo-alvo como falso-ativo.
        handoffStore.reconcileStuck()

        const target = resolveRepo(input.targetRepo)
        const from = input.fromRepo ? resolveRepo(input.fromRepo) : null

        // Dedup por alvo em TRÊS níveis (evita dois agentes mutando o mesmo repo
        // em paralelo, causa-raiz de quase-acidente). Nunca devolve o handle do
        // handoff encontrado: entregar { handoffId, alias, status } fazia uma mãe
        // adotar a filha de OUTRA e passar a conversar com ela. Sempre recusa com
        // erro informativo; force=true segue despachando uma segunda.
        if (!input.force) {
          const mother = ctx.motherSessionId
          // Nível 1: handoff ativo despachado por MIM neste repo. Só existe
          // quando o app carimbou a identidade (mcp-config por sessão).
          const mine = mother ? handoffStore.findActiveByTarget(target.id, mother) : null
          // Níveis 2 e 3: qualquer handoff ativo no repo-alvo. Escopar SÓ pela
          // mãe reabriria duas mães mutando o mesmo repo — o acidente que este
          // dedup existe pra evitar. Sem identidade (nível 3) este é o único
          // predicado, e é o mais estrito: mantém o comportamento legado.
          const anyActive = mine ?? handoffStore.findActiveByTarget(target.id)
          if (anyActive) {
            const alias = handoffStore.childAlias(anyActive.childSessionId)
            const who = alias ? `a filha "${alias}"` : 'uma filha (ainda sem alias)'
            const status = `(status: ${anyActive.status})`
            const tail =
              'Se este trabalho é seu e precisa rodar mesmo assim, chame de novo com force: true; senão aguarde a atual concluir.'
            const error = mine
              ? `Você JÁ despachou ${who} para ${target.label} ${status} — ela é sua. Fale com ela por SendMessage({ to: "${alias ?? ''}" }) ou acompanhe por handoff_result em vez de despachar outra. ${tail}`
              : mother
                ? `${target.label} já tem ${who} ativa ${status} e ela NÃO é sua — foi despachada por outra sessão-mãe. Não assuma o controle de uma filha que você não despachou. ${tail}`
                : `${target.label} já tem ${who} ativa ${status} — e ela pode NÃO ser sua: sem identidade da sessão-mãe, o dedup é por repo-alvo. Não assuma o controle de uma filha que você não despachou. ${tail}`
            return ok({ duplicate: true, error })
          }
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
              .filter(
                (e) => e.fromRepoId === from.id || e.toRepoId === from.id,
              )
              .map(toCompose)
          : allEdges.map(toCompose)

        const featureTitle = input.featureId
          ? (
              getDb()
                .prepare('SELECT title FROM features WHERE id = ?')
                .get(input.featureId) as { title: string } | undefined
            )?.title ?? null
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
          handoffId,
          alias,
          mode,
        })

        const handoff = handoffStore.create({
          id: handoffId,
          // Carimbo do app (null quando a sessão veio da config global legada).
          motherSessionId: ctx.motherSessionId,
          targetRepoId: target.id,
          // Origem da delegação (a mãe), pra instrumentação cross-repo. Null se a
          // MCP não passou fromRepo.
          fromRepoId: from?.id ?? null,
          featureId: input.featureId ?? null,
          task: input.task,
          contextJson: input.context ?? null,
          composedPrompt: composed,
          mode,
        })

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
            featureId: input.featureId ?? null,
            initialPrompt: kickoff,
            systemPromptText: composed,
            permissionMode: permissionModeForHandoffMode(mode),
          })
          const running = handoffStore.markRunning(handoffId, child.id)
          notify.broadcast('handoff:updated', running)
          return ok({
            handoffId,
            alias,
            status: running.status,
            message: `Filha "${alias}" despachada para ${target.label}. Mande AGORA a primeira SendMessage({ to: "${alias}", ... }) — é ela que abre o canal de volta (a filha responde a quem escreveu primeiro).`,
          })
        } catch (err) {
          // Spawn falhou (repo sumiu do disco, PTY não subiu): o handoff não pode
          // ficar preso em pending — vira failed com o erro visível no inbox.
          const msg = err instanceof Error ? err.message : String(err)
          const failed = handoffStore.fail(handoffId, msg)
          notify.broadcast('handoff:updated', failed)
          return ok({ handoffId, alias: null, status: failed.status, error: msg })
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
        injectIntoChild(handoff.childSessionId, text)
        // A mãe respondeu: a filha retoma (needs_input → running, limpa a pergunta).
        const updated = handoffStore.resume(handoffId)
        notify.broadcast('handoff:updated', updated)
        return ok({ status: updated.status, delivered: true })
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
        const updated = handoffStore.ask(handoffId, question)
        notify.broadcast('handoff:updated', updated)
        return ok({ status: updated.status, pendingQuestion: updated.pendingQuestion })
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
        const updated = handoffStore.progress(handoffId, step)
        notify.broadcast('handoff:updated', updated)
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
        const updated = handoffStore.report(handoffId, summary)
        notify.broadcast('handoff:updated', updated)
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

// ---- scheduled jobs ----

// Gate observe-only: jobs via MCP só aceitam plan/default. Os modos autônomos
// ficam bloqueados na fronteira (fecha a self-elevation por prompt injection —
// um job em plan critica repo untrusted, injection tenta escalar via create/update
// com bypassPermissions/dontAsk). Enum restrito ao allowlist = rejeição na validação.
const jobPermissionMode = z.enum(OBSERVE_ONLY_PERMISSION_MODES, {
  error: 'permissionMode autônomo indisponível via MCP no MVP — use a UI (apenas plan/default)',
})
const jobEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
const jobAdvisorModel = z.enum(['opus', 'sonnet', 'fable'])
// Discriminador do tipo de job (espelha JobKind). 'web-audit' dirige um browser
// contra targetUrl; 'critique' é o default retrocompatível.
const jobKind = z.enum(['critique', 'web-audit'])
const jobRunStatus = z.enum(['scheduled', 'running', 'success', 'failed', 'interrupted', 'missed'])

// Espelha JobSchedule (discriminated union em shared/types/ipc.ts). next_run_at é
// derivado disto num único helper (computeNextRunAt) — não é dado do input.
const jobSchedule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('interval'), hours: z.number().int().positive() }),
  z.object({
    type: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    type: z.literal('weekly'),
    dayOfWeek: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
])

// Espelha CreateScheduledJobInput.
const scheduledJobCreateSchema = z.object({
  name: z.string().min(1),
  // Default 'critique' quando omitido (o store aplica o default). web-audit dirige
  // um browser contra targetUrl — o kind é o que libera as browser tools no runner.
  kind: jobKind.optional(),
  repoId: z.string().nullish(),
  prompt: z.string().min(1),
  systemPrompt: z.string().nullish(),
  targetUrl: z.string().nullish(),
  schedule: jobSchedule,
  enabled: z.boolean().optional(),
  catchUp: z.boolean().optional(),
  model: z.string().nullish(),
  effort: jobEffort.nullish(),
  permissionMode: jobPermissionMode.nullish(),
  advisorModel: jobAdvisorModel.nullish(),
  disallowedTools: z.array(z.string()).nullish(),
})

// Espelha UpdateScheduledJobInput (id obrigatório, resto parcial).
const scheduledJobUpdateSchema = scheduledJobCreateSchema.partial().extend({ id: z.string().min(1) })

// Espelha ScheduledJobListFilter.
const scheduledJobListSchema = z.object({
  enabled: z.boolean().optional(),
  repoId: z.string().optional(),
})

const scheduledJobRunNowSchema = z.object({ jobId: z.string().min(1) })

// Espelha JobRunListFilter.
const jobRunListSchema = z.object({
  jobId: z.string().optional(),
  status: jobRunStatus.optional(),
  limit: z.number().int().positive().optional(),
})

// Push OPCIONAL da própria sessão do job (molde handoff_report): grava report_text
// + status success na run identificada pelo runId (embutido no kickoff do job).
const jobReportSchema = z.object({
  runId: z.string().min(1),
  report: z.string().min(1),
})

// Espelha ListPullRunsFilter (repo-pull-store).
const repoPullRunListSchema = z.object({
  limit: z.number().int().positive().optional(),
})

function scheduledJobTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'scheduled_job_create',
      title: 'Create scheduled job',
      description:
        'Create a scheduled job that periodically runs a Claude Code session in a target repo and captures a critique report. schedule is interval (every N hours), daily (HH:MM local time), or weekly (dayOfWeek 0=Sun..6=Sat + HH:MM). permissionMode defaults to default (observe-only, read-only lockdown — no writes). The prompt should impose the report template (findings + suggestions in markdown).',
      inputSchema: scheduledJobCreateSchema,
      handler: (args) => {
        const input = scheduledJobCreateSchema.parse(args)
        const job = jobStore.create(input)
        notify.broadcast('scheduledJob:updated', job)
        return ok({ job })
      },
    },
    {
      name: 'scheduled_job_list',
      title: 'List scheduled jobs',
      description:
        'List scheduled jobs (enabled, nextRunAt, lastRunAt, schedule, repo). Optional filters: enabled, repoId.',
      inputSchema: scheduledJobListSchema,
      handler: (args) => {
        const filter = scheduledJobListSchema.parse(args)
        return ok({ items: jobStore.list(filter) })
      },
    },
    {
      name: 'scheduled_job_update',
      title: 'Update scheduled job',
      description:
        'Update a scheduled job by id — edit prompt/schedule/spawn params, or pause/resume via enabled. Changing schedule re-anchors nextRunAt to now.',
      inputSchema: scheduledJobUpdateSchema,
      handler: (args) => {
        const input = scheduledJobUpdateSchema.parse(args)
        const job = jobStore.update(input)
        notify.broadcast('scheduledJob:updated', job)
        return ok({ job })
      },
    },
    {
      name: 'scheduled_job_run_now',
      title: 'Run a scheduled job now',
      description:
        'Trigger an ad-hoc run of a scheduled job immediately, outside its schedule. Does NOT change nextRunAt — the regular schedule keeps ticking. Spawns the session via the same path as the scheduler (delta-via-prompt + report capture apply).',
      inputSchema: scheduledJobRunNowSchema,
      handler: (args) => {
        const { jobId } = scheduledJobRunNowSchema.parse(args)
        const run = runJobNow(jobId)
        notify.broadcast('jobRun:updated', run)
        return ok({ run })
      },
    },
    {
      name: 'job_run_list',
      title: 'List job runs',
      description:
        'List the run history of scheduled jobs (status, reportText, tokens, captureQuality, timing), most recent first. Optional filters: jobId, status, limit.',
      inputSchema: jobRunListSchema,
      handler: (args) => {
        const filter = jobRunListSchema.parse(args)
        return ok({ items: jobStore.listRuns(filter) })
      },
    },
    {
      name: 'job_report',
      title: 'Report a job run result',
      description:
        'Called by the JOB session itself to push its final critique report. Pass runId (given in the job kickoff) and the markdown report; records report_text and marks the run success. Optional — the pull capture on session exit is the floor; this is a structured complement.',
      inputSchema: jobReportSchema,
      handler: (args) => {
        const { runId, report } = jobReportSchema.parse(args)
        const existing = jobStore.getRun(runId)
        if (!existing) throw new Error(`job run não encontrado: ${runId}`)
        const run = jobStore.updateRun({
          id: runId,
          status: 'success',
          reportText: report,
          captureQuality: 'full',
          finishedAt: Date.now(),
        })
        notify.broadcast('jobRun:updated', run)
        return ok({ run })
      },
    },
  ]
}

// Espelha job_run_list (mesmo formato), mas pro histórico do auto-pull de repos
// (repo_pull_runs, migration 033) — visibilidade direta de "está funcionando?".
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

export function buildTools(
  notify: McpNotify,
  ctx: McpRequestContext = ANONYMOUS_CONTEXT,
): ToolDef[] {
  return [
    ...overviewTools(),
    ...objectiveTools(notify),
    ...taskTools(notify),
    ...featureTools(notify),
    ...handoffTools(notify, ctx),
    ...scheduledJobTools(notify),
    ...repoPullTools(),
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
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      (args: unknown) => tool.handler(args),
    )
  }
}
