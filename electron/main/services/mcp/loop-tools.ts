import * as z from 'zod/v4'
import * as loopStore from '../loop-store'
import { loopSnapshot } from '../loop-snapshot'
import { exportLoopDoc } from '../loop-export'
import { ok, type McpNotify, type ToolDef } from './tools'

// Tools MCP do loop da feature. Arquivo próprio (precedente: video-tools.ts) e
// mesmo contrato das demais: handler fino (zod → store → notify → retorno), sem
// regra de negócio, e o broadcast espelha 1:1 o canal que ipc/loop.ts emite
// ('loop:updated'), pra a UI atualizar ao vivo quando quem escreveu foi a sessão.
//
// A razão de existir destas tools: o loop só se fecha se quem MEXEU na feature
// registrar o que mudou. Pedir isso ao humano depois não funciona (foi o que
// deixou as frentes largadas); a sessão que acabou de fazer o trabalho é quem
// tem o contexto na mão.
//
// Por isso as descrições abaixo dizem QUANDO chamar, não só o que a tool faz —
// quem as lê é um modelo decidindo se aquele é o momento. `feature_health_get` é
// deliberadamente o começo do fluxo: uma leitura barata que situa a sessão antes
// de ela escrever qualquer coisa.
//
// Nada aqui deleta: pulso é append-only e ledger arquiva por corpo vazio (norma
// do projeto — ver cabeçalho de tools.ts).

// Mensagens e descrições em inglês, como no resto das tools: quem lê é o agente.

const progressDirection = z.enum(['increase', 'decrease', 'maintain'])

const featureIdSchema = z.object({
  featureId: z.string().min(1).describe('Feature id (feature_list shows them).'),
})

const pulseSetSchema = z.object({
  featureId: z.string().min(1),
  body: z
    .string()
    .min(1)
    .describe(
      'ONE sentence in the present tense saying what is alive right now (max 200 chars). Not a changelog — what someone resuming tomorrow needs to know first.',
    ),
})

const pulseHistorySchema = z.object({
  featureId: z.string().min(1),
  limit: z.number().int().positive().max(200).optional(),
})

const ledgerAppendSchema = z.object({
  featureId: z.string().min(1),
  entryId: z
    .string()
    .min(1)
    .describe(
      'Stable textual id you choose (^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$), e.g. "export-doc". Reusing it UPDATES that entry instead of adding a second one — pick the id you would pick again next week.',
    ),
  title: z.string().optional().describe('Short label. Defaults to the entryId.'),
  kind: z.string().nullish().describe('Free tag: decision | shipped | learning | risk.'),
  body: z
    .string()
    .nullish()
    .describe(
      'The entry itself. Empty/omitted ARCHIVES the entry (reversible: send a body again to bring it back). Nothing here is ever deleted.',
    ),
})

const ledgerListSchema = z.object({
  featureId: z.string().min(1),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
})

const metricDeclareSchema = z.object({
  featureId: z.string().min(1),
  columnKey: z.string().min(1).describe('Stable key of the series, e.g. "p95_ms". Re-declaring updates the config.'),
  label: z.string().nullish(),
  unit: z.string().nullish().describe('ms, %, R$, req/s.'),
  target: z.number().nullish().describe('Where the number should land. Within 15% of it reads as "ok".'),
  floor: z.number().nullish().describe('Below this the number reads as "fail", whatever the target says.'),
  baseline: z.number().nullish().describe('Where it started, so the delta is readable.'),
  direction: progressDirection.nullish(),
  isHeadline: z
    .boolean()
    .optional()
    .describe('Headline columns are the ones feature_health_get returns. Keep it to one or two.'),
  alarm: z
    .boolean()
    .optional()
    .describe('Set for columns where OVERSHOOTING the target is bad (cost, latency, error rate).'),
})

const metricRecordSchema = z.object({
  featureId: z.string().min(1),
  columnKey: z.string().min(1).describe('Must already be declared (feature_metric_declare).'),
  value: z.number().nullable().describe('The measurement. null records "measured, no value".'),
  at: z
    .number()
    .int()
    .optional()
    .describe('Epoch ms of the MEASUREMENT (defaults to now). Re-recording the same instant corrects it.'),
  note: z.string().nullish().describe('Where the number came from — the command, the dashboard, the query.'),
})

const loopExportSchema = z.object({
  featureId: z.string().min(1),
  dryRun: z.boolean().optional().describe('Resolve the target paths without touching disk.'),
})

export function loopTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'feature_health_get',
      title: 'Get feature loop health',
      description:
        'START HERE when you pick up work on a feature: one cheap read that says whether the frontier is alive, quiet, broken, paused or done, what the current pulse claims, what is inconsistent about the loop (issues), and where the headline metrics stand. Liveness and issues are DERIVED on read, never stored — a feature is "quiet" because nobody touched it within its cadence, not because someone typed that. Use it before writing anything, and again before claiming the feature is done.',
      inputSchema: featureIdSchema,
      handler: (args) => {
        const { featureId } = featureIdSchema.parse(args)
        const snapshot = loopSnapshot(featureId)
        return ok({
          featureId,
          liveness: snapshot.liveness,
          lastActivityAt: snapshot.lastActivityAt,
          issues: snapshot.issues,
          pulse: snapshot.pulse,
          // Só as headline: a leitura é pra situar, não pra despejar toda a série.
          metrics: snapshot.metrics
            .filter((series) => series.column.isHeadline)
            .map((series) => ({
              columnKey: series.column.columnKey,
              label: series.column.label,
              unit: series.column.unit,
              target: series.column.target,
              floor: series.column.floor,
              baseline: series.column.baseline,
              direction: series.column.direction,
              latest: series.latest,
              tone: series.tone,
            })),
        })
      },
    },
    {
      name: 'feature_pulse_set',
      title: 'Set feature pulse',
      description:
        'Record what is alive on this feature RIGHT NOW, in one sentence (max 200 chars). Call it when you finish a chunk of work or when the state of the frontier changed — it is the first thing the next session reads. Append-only: this never overwrites the previous pulse, the history of "how it was going" stays queryable via feature_pulse_history.',
      inputSchema: pulseSetSchema,
      handler: (args) => {
        const input = pulseSetSchema.parse(args)
        const pulse = loopStore.setPulse(input.featureId, input.body, 'mcp')
        notify.broadcast('loop:updated', { featureId: input.featureId })
        return ok({ pulse })
      },
    },
    {
      name: 'feature_pulse_history',
      title: 'List feature pulses',
      description:
        'The pulses of a feature, most recent first. Use it when you need the TRAJECTORY (how the frontier has been going over time) rather than just its current state — feature_health_get already gives you the current one.',
      inputSchema: pulseHistorySchema,
      handler: (args) => {
        const { featureId, limit } = pulseHistorySchema.parse(args)
        return ok({ items: loopStore.pulseHistory(featureId, limit) })
      },
    },
    {
      name: 'feature_ledger_append',
      title: 'Append or update a ledger entry',
      description:
        'Record something that CHANGED and will still matter later: a decision and its reason, something shipped, a learning, a risk taken. Not a task list and not a diff — the ledger is what someone reading the feature in a month needs. Upsert by entryId: reusing the id revises that entry instead of duplicating it, so correcting yourself is the normal path. Sending an empty body archives the entry (reversible); nothing is ever deleted.',
      inputSchema: ledgerAppendSchema,
      handler: (args) => {
        const input = ledgerAppendSchema.parse(args)
        const entry = loopStore.appendLedger(input.featureId, input)
        notify.broadcast('loop:updated', { featureId: input.featureId })
        return ok({ entry })
      },
    },
    {
      name: 'feature_ledger_list',
      title: 'List ledger entries',
      description:
        'Ledger entries of a feature, most recent first (archived ones excluded unless includeArchived). Read it before appending, to revise an existing entry instead of writing a near-duplicate with a new id.',
      inputSchema: ledgerListSchema,
      handler: (args) => {
        const { featureId, includeArchived, limit } = ledgerListSchema.parse(args)
        return ok({ items: loopStore.listLedger(featureId, { includeArchived, limit }) })
      },
    },
    {
      name: 'feature_metric_declare',
      title: 'Declare a metric column',
      description:
        'Declare WHAT this feature is supposed to move, before measuring it: the key of the series, its unit, and the references that make a number readable (target, floor, baseline, direction). Call it when the feature has a number attached to its purpose — a frontier with no metric can only be evaluated by opinion. Idempotent: re-declaring the same columnKey updates the config. Required before feature_metric_record.',
      inputSchema: metricDeclareSchema,
      handler: (args) => {
        const input = metricDeclareSchema.parse(args)
        const column = loopStore.declareMetric(input.featureId, input)
        notify.broadcast('loop:updated', { featureId: input.featureId })
        return ok({ column })
      },
    },
    {
      name: 'feature_metric_record',
      title: 'Record a metric point',
      description:
        'Record ONE measurement of a declared column. Call it whenever you actually measured something (ran the benchmark, read the dashboard, counted the errors) — a target with no points is a wish. The tone (ok / fail / neutral) is derived from the column config, you do not send it. Upsert by (column, instant): re-recording the same instant corrects the value instead of adding a second point.',
      inputSchema: metricRecordSchema,
      handler: (args) => {
        const input = metricRecordSchema.parse(args)
        const point = loopStore.recordMetricPoint(
          input.featureId,
          input.columnKey,
          input.at ?? Date.now(),
          input.value,
          input.note,
        )
        notify.broadcast('loop:updated', { featureId: input.featureId })
        return ok({ point })
      },
    },
    {
      name: 'feature_loop_export',
      title: 'Export the loop doc into the repos',
      description:
        'Write `.pitwall/loop-<slug>.md` (pulse, recent ledger, metrics, issues) into every repo linked to the feature, so the state is readable from the repo without the app. This also runs automatically when a session ends — call it explicitly when you want the file refreshed NOW, e.g. right before handing the repo to someone else. Content is deterministic: same state, same bytes, no generation timestamp, so an unchanged loop leaves no diff. Returns which paths were written and which repos were skipped (missing directory, export disabled).',
      inputSchema: loopExportSchema,
      handler: async (args) => {
        const { featureId, dryRun } = loopExportSchema.parse(args)
        const result = await exportLoopDoc(featureId, { dryRun })
        return ok({ ...result, dryRun: dryRun === true })
      },
    },
  ]
}
