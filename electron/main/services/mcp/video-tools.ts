// Tools MCP do Video Lab. Mesmo contrato das diagram_*: handler fino (validação
// zod → store → notify → retorno), sem lógica de negócio própria, e os
// broadcasts espelham 1:1 os canais que a camada IPC emite, pra a UI atualizar
// ao vivo quando quem escreveu foi o agente.
//
// Duas coisas são específicas desta área e estão codificadas aqui:
//
// 1. REUSO. Peça não nasce do zero: nasce de um template (blueprint de cenas +
//    brand kit + elenco). Por isso video_project_create aceita templateId e
//    video_template_create aceita fromProject — o caminho de ida e o de volta.
// 2. TETO DE CUSTO. video_asset_generate fala com API paga (ElevenLabs/Gemini).
//    A tool NUNCA gera sem maxCostCents explícito, é dry-run por default e o
//    plano (quanto custaria, o que seria reusado) vem ANTES de gastar. O plano é
//    calculado pelo serviço (que conhece preço e idempotência por hash) — a tool
//    só compara com o teto e recusa.
//
// Sem tools destrutivas: nada aqui apaga peça, personagem, brand kit ou asset.
// Arquivar/atualizar é o teto — agente não recebe diálogo de confirmação.
import * as z from 'zod/v4'
import * as brandKitStore from '../video/brand-kit-store'
import * as characterStore from '../video/character-store'
import * as templateStore from '../video/template-store'
import * as projectStore from '../video/project-store'
import * as scriptStore from '../video/script-store'
import * as renderStore from '../video/render-store'
import { videoGenerator } from '../video/generation-seam'
import { ok, type McpNotify, type ToolDef } from './tools'
import type {
  GenerateVideoAudioInput,
  GenerateVideoImageInput,
  VideoProject,
} from '../../../../shared/types/ipc'

// O log do Remotion cresce sem teto; o agente que investiga um render quebrado
// precisa do FIM dele, não do arquivo inteiro no contexto.
const MAX_RENDER_LOG_TAIL = 4_000

// Mensagens de erro em inglês, como as descrições: quem lê é o agente, e o que
// ele precisa não é "deu erro" e sim o próximo passo concreto.

// ---- enums espelhando shared/types/ipc.ts ----

const videoProjectStatus = z.enum(['draft', 'scripting', 'assets', 'rendering', 'done'])
const videoScriptLineKind = z.enum(['narration', 'on_screen'])
const videoRenderStatus = z.enum(['queued', 'running', 'done', 'failed'])
const videoGeneratedImageKind = z.enum(['keyvisual', 'texture', 'character'])

// ---- schemas compartilhados ----

const videoVisualSpecSchema = z.object({
  canonical: z
    .string()
    .describe(
      'Canonical description injected VERBATIM into every image prompt for this character. This is what keeps the character recognizable across scenes generated in separate calls.',
    ),
  invariants: z
    .array(z.string())
    .default([])
    .describe('Trait-by-trait checklist (hair, outfit, apparent age) used when reviewing a render.'),
  negative: z.array(z.string()).default([]).describe('What must never show up (negative prompt).'),
})

const videoCastSlotSchema = z.object({
  characterId: z.string().min(1),
  roleInPiece: z.string().default(''),
})

const videoSceneBlueprintSchema = z.object({
  sceneId: z
    .string()
    .min(1)
    .describe("Textual scene id ('cold-open', 'logo') — the same id the Remotion engine consumes."),
  role: z.string().default(''),
  targetSec: z.number().nonnegative().default(0),
  visualHint: z.string().optional(),
})

const videoBrandTokensSchema = z.object({
  palette: z.record(z.string(), z.string()).default({}),
  typography: z
    .object({ display: z.string().optional(), mono: z.string().optional(), body: z.string().optional() })
    .default({}),
})

const videoBrandDoDontSchema = z.object({
  do: z.array(z.string()).default([]),
  dont: z.array(z.string()).default([]),
})

// ---- resolução de referências ----
//
// Toda tool aceita a peça por id OU por slug: o agente que acabou de criar
// "pitwall-promo" pensa no slug, não no uuid. Erro de resolução diz como listar.

function resolveProject(ref: string): VideoProject {
  const byId = projectStore.get(ref)
  if (byId) return byId
  const bySlug = projectStore
    .list({ includeArchived: true, search: ref })
    .find((meta) => meta.slug === ref)
  const project = bySlug ? projectStore.get(bySlug.id) : null
  if (!project) {
    throw new Error(
      `video project not found: "${ref}" — pass the project id or its slug (video_project_list shows both).`,
    )
  }
  return project
}

function assertKnownScenes(project: VideoProject, sceneIds: string[]): void {
  const known = new Set(project.scenes.map((scene) => scene.sceneId))
  const unknown = sceneIds.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new Error(
      `unknown sceneId(s) in project "${project.slug}": ${unknown.join(', ')}. The project has: ${
        [...known].join(', ') || '(no scenes yet — create the project from a template, or add scenes first)'
      }`,
    )
  }
}

function assertKnownLocale(project: VideoProject, locale: string): void {
  if (!project.locales.includes(locale)) {
    throw new Error(
      `locale "${locale}" is not declared on project "${project.slug}" (locales: ${
        project.locales.join(', ') || 'none'
      }) — add it with video_project_update before writing script or rendering.`,
    )
  }
}

// ---- brand kits ----

const videoBrandKitListSchema = z.object({})

const videoBrandKitUpsertSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    tokens: videoBrandTokensSchema.optional(),
    toneOfVoice: z.string().optional(),
    doDont: videoBrandDoDontSchema.optional(),
    logoAssetId: z.string().nullish(),
    ttsVoices: z.record(z.string(), z.string()).optional(),
  })
  .refine((v) => Boolean(v.id ?? v.name), { message: 'provide id (to update) or name' })

function brandKitTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'video_brand_kit_list',
      title: 'List brand kits',
      description:
        'List the brand kits of the Video Lab. A BRAND KIT is the reusable identity of a brand — palette and typography tokens, tone of voice, do/dont rules and the preferred TTS voice per locale. It belongs to no single piece: templates and projects point at it, which is how the second video already sounds and looks like the first. Read it before writing script or art direction.',
      inputSchema: videoBrandKitListSchema,
      handler: () => ok({ items: brandKitStore.list() }),
    },
    {
      name: 'video_brand_kit_upsert',
      title: 'Create or update a brand kit',
      description:
        'Create a brand kit or update an existing one. Pass id to update a specific kit; otherwise name is matched against the existing kits (exact, case-insensitive) and a new kit is created when nothing matches. Fields you omit are left untouched — this is a patch, not a replace. ttsVoices maps locale to the ElevenLabs voice id used for that language, and is the default voice video_asset_generate uses in audio mode.',
      inputSchema: videoBrandKitUpsertSchema,
      handler: (args) => {
        const input = videoBrandKitUpsertSchema.parse(args)
        const existing = input.id
          ? brandKitStore.get(input.id)
          : (brandKitStore
              .list()
              .find((kit) => kit.name.trim().toLowerCase() === input.name!.trim().toLowerCase()) ??
            null)
        if (input.id && !existing) {
          throw new Error(
            `video brand kit not found: ${input.id} — omit id to create a new kit, or check video_brand_kit_list.`,
          )
        }

        const kit = existing
          ? brandKitStore.update({ ...input, id: existing.id })
          : brandKitStore.create({ ...input, name: input.name! })
        notify.broadcast('videoBrandKit:updated', kit)
        return ok({ brandKit: kit, created: !existing })
      },
    },
  ]
}

// ---- personagens ----

const videoCharacterListSchema = z.object({
  includeArchived: z.boolean().optional(),
  search: z.string().optional(),
})

const videoCharacterUpsertSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    canonicalDescription: z.string().optional(),
    visualSpec: videoVisualSpecSchema.optional(),
    voiceId: z.string().nullish(),
  })
  .refine((v) => Boolean(v.id ?? v.name), { message: 'provide id (to update) or name' })

function characterTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'video_character_list',
      title: 'List characters',
      description:
        'List the reusable CHARACTERS of the Video Lab (metas only — reference images are omitted; video_project_get shows who is cast in a piece). A character belongs to no single piece: the same character is cast across videos, which is exactly why its look must not drift.',
      inputSchema: videoCharacterListSchema,
      handler: (args) => {
        const filter = videoCharacterListSchema.parse(args)
        return ok({ items: characterStore.list(filter) })
      },
    },
    {
      name: 'video_character_upsert',
      title: 'Create or update a character',
      description:
        'Create a character or update an existing one (pass id, or a name matched exactly and case-insensitively against existing characters). The field that matters is visualSpec: the hard problem of this area is CONSISTENCY, not generation — the same character must look identical in eight scenes generated by eight separate API calls. visualSpec.canonical is injected VERBATIM into every image prompt for this character, invariants is the trait checklist to review against, negative is what must never appear. Approved reference images are attached elsewhere (the app UI) and are passed to the image model together with this spec. Fields you omit are left untouched.',
      inputSchema: videoCharacterUpsertSchema,
      handler: (args) => {
        const input = videoCharacterUpsertSchema.parse(args)
        const existing = input.id
          ? characterStore.get(input.id)
          : (characterStore
              .list({ includeArchived: true, search: input.name })
              .find((c) => c.name.trim().toLowerCase() === input.name!.trim().toLowerCase()) ?? null)
        if (input.id && !existing) {
          throw new Error(
            `video character not found: ${input.id} — omit id to create a new character, or check video_character_list.`,
          )
        }

        const character = existing
          ? characterStore.update({ ...input, id: existing.id })
          : characterStore.create({ ...input, name: input.name! })
        notify.broadcast('videoCharacter:updated', character)
        return ok({ character, created: !existing })
      },
    },
  ]
}

// ---- templates ----

const videoTemplateListSchema = z.object({
  kind: z.string().optional(),
  search: z.string().optional(),
})

const videoTemplateCreateSchema = z.object({
  kind: z
    .string()
    .min(1)
    .optional()
    .describe("Open category: 'promo', 'character-story', whatever fits. Not a fixed enum."),
  name: z.string().min(1),
  description: z.string().optional(),
  sceneBlueprint: z.array(videoSceneBlueprintSchema).optional(),
  brandKitId: z.string().nullish(),
  defaultCast: z.array(videoCastSlotSchema).optional(),
  fromProject: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Promote an existing piece (id or slug) into a reusable template: its scenes become the blueprint and its brand kit and cast become the defaults. When set, sceneBlueprint/brandKitId/defaultCast are derived from the piece and ignored here; kind falls back to the kind of the piece.',
    ),
})

function templateTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'video_template_list',
      title: 'List video templates',
      description:
        'List the TEMPLATES of the Video Lab. A template is a category of piece made reusable: a scene blueprint (which scenes exist, their role and target duration — but no script), a brand kit and a default cast. Creating a piece means instantiating a template, so read this before video_project_create: starting from a template is the normal path and starting empty is the exception.',
      inputSchema: videoTemplateListSchema,
      handler: (args) => {
        const filter = videoTemplateListSchema.parse(args)
        return ok({ items: templateStore.list(filter) })
      },
    },
    {
      name: 'video_template_create',
      title: 'Create a video template',
      description:
        'Create a reusable template, either from scratch (kind + name + sceneBlueprint) or from an existing piece via fromProject — the way a one-off video that worked becomes the mold for the next ones. The blueprint carries structure only (sceneId, role, targetSec, visual hint); script lines stay on the piece, which is what lets one blueprint produce many different videos.',
      inputSchema: videoTemplateCreateSchema,
      handler: (args) => {
        const input = videoTemplateCreateSchema.parse(args)

        // Caminho "salvar peça como template": a promoção é do store (uma
        // transação, uma definição), não uma remontagem feita aqui.
        if (input.fromProject) {
          const source = resolveProject(input.fromProject)
          const template = templateStore.saveFromProject({
            projectId: source.id,
            name: input.name,
            kind: input.kind,
            description: input.description,
          })
          notify.broadcast('videoTemplate:updated', template)
          return ok({ template, derivedFromProject: source.slug })
        }

        if (!input.kind) {
          throw new Error(
            'kind is required when the template is not derived from a piece (fromProject) — it is the open category of the piece, e.g. "promo" or "character-story".',
          )
        }

        const template = templateStore.create({
          kind: input.kind,
          name: input.name,
          description: input.description,
          sceneBlueprint: input.sceneBlueprint,
          brandKitId: input.brandKitId,
          defaultCast: input.defaultCast,
        })
        notify.broadcast('videoTemplate:updated', template)
        return ok({ template, derivedFromProject: null })
      },
    },
  ]
}

// ---- peças (projetos) ----

const videoProjectListSchema = z.object({
  includeArchived: z.boolean().optional(),
  status: videoProjectStatus.optional(),
  kind: z.string().optional(),
  templateId: z.string().optional(),
  brandKitId: z.string().optional(),
  search: z.string().optional(),
})

const videoProjectGetSchema = z.object({
  project: z.string().min(1).describe('Project id or slug.'),
  locale: z
    .string()
    .min(1)
    .optional()
    .describe('When given, the script of that locale comes along (it is per-locale and unbounded, so it is opt-in).'),
})

const videoProjectCreateSchema = z.object({
  slug: z.string().min(1).describe('Stable handle of the piece, unique across the lab.'),
  title: z.string().min(1),
  description: z.string().optional(),
  kind: z.string().optional(),
  templateId: z
    .string()
    .min(1)
    .optional()
    .describe('The template to instantiate. Omitting it creates an EMPTY piece — the exception, not the normal path.'),
  brandKitId: z.string().nullish(),
  locales: z.array(z.string().min(1)).min(1),
  themePreset: z.string().nullish(),
})

const videoProjectUpdateSchema = z.object({
  project: z.string().min(1).describe('Project id or slug.'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  kind: z.string().min(1).optional(),
  brandKitId: z.string().nullish(),
  locales: z.array(z.string().min(1)).min(1).optional(),
  themePreset: z.string().nullish(),
  status: videoProjectStatus.optional(),
})

function projectTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'video_project_list',
      title: 'List video pieces',
      description:
        'List the pieces (projects) of the Video Lab — headers only, without scenes, cast or script. status is the position on the conveyor (draft → scripting → assets → rendering → done); archiving is separate from status, and archived pieces are hidden unless includeArchived is true.',
      inputSchema: videoProjectListSchema,
      handler: (args) => {
        const filter = videoProjectListSchema.parse(args)
        return ok({ items: projectStore.list(filter) })
      },
    },
    {
      name: 'video_project_get',
      title: 'Get one video piece',
      description:
        'Get one piece by id or slug: header, cast (which character plays which role) and scenes (the shot list with role, target duration and art direction). The script is NOT included by default because it is per-locale and grows without bound — pass locale to get it. Returns { project: null } when nothing matches.',
      inputSchema: videoProjectGetSchema,
      handler: (args) => {
        const { project: ref, locale } = videoProjectGetSchema.parse(args)
        const project = projectStore.get(ref) ?? resolveProject(ref)
        if (!locale) return ok({ project })
        assertKnownLocale(project, locale)
        return ok({ project, locale, script: scriptStore.list(project.id, locale) })
      },
    },
    {
      name: 'video_project_create',
      title: 'Create a video piece',
      description:
        'Create a piece. The normal path is to pass templateId: the piece is INSTANTIATED from the template in one transaction — the scene blueprint becomes its scenes, the brand kit and the default cast come along. That inheritance is the point of the area: a piece never starts from zero, so brand and cast stay consistent across videos. Without templateId the piece is born empty. locales declares which languages it will be scripted and rendered in; brandKitId overrides the one inherited from the template.',
      inputSchema: videoProjectCreateSchema,
      handler: (args) => {
        const input = videoProjectCreateSchema.parse(args)
        if (input.templateId && !templateStore.get(input.templateId)) {
          throw new Error(
            `video template not found: ${input.templateId} — see video_template_list, or omit templateId to create an empty piece.`,
          )
        }
        if (!input.templateId && !input.kind) {
          throw new Error(
            'a piece needs a category: pass templateId (the normal path — kind comes from the template along with the scenes and the cast) or an explicit kind.',
          )
        }
        const project = projectStore.create(input)
        notify.broadcast('videoProject:updated', project)
        return ok({
          project,
          // A prova de que a herança pegou: sem isto o agente não sabe se a peça
          // nasceu com as cenas do template ou vazia.
          inherited: {
            templateId: project.templateId,
            scenes: project.scenes.length,
            cast: project.cast.length,
            brandKitId: project.brandKitId,
          },
        })
      },
    },
    {
      name: 'video_project_update',
      title: 'Update a video piece',
      description:
        'Update the header of a piece (id or slug). Fields you omit are left untouched. status moves it along the conveyor (draft → scripting → assets → rendering → done) and is independent from archiving. Changing locales does not delete script already written for a removed locale.',
      inputSchema: videoProjectUpdateSchema,
      handler: (args) => {
        const { project: ref, ...patch } = videoProjectUpdateSchema.parse(args)
        const existing = resolveProject(ref)
        const project = projectStore.update({ ...patch, id: existing.id })
        notify.broadcast('videoProject:updated', project)
        return ok({ project })
      },
    },
  ]
}

// ---- roteiro ----

const videoScriptUpsertSchema = z.object({
  project: z.string().min(1).describe('Project id or slug.'),
  locale: z.string().min(1),
  lines: z
    .array(
      z.object({
        sceneId: z.string().min(1),
        kind: videoScriptLineKind,
        text: z.string(),
        ord: z.number().int().nonnegative().optional(),
      }),
    )
    .describe('The COMPLETE script of this locale — the previous one is replaced, not merged.'),
})

function scriptTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'video_script_upsert',
      title: 'Write the script of one locale',
      description:
        'Write the script of ONE locale of a piece, scene by scene. kind "narration" is what gets spoken (it becomes TTS audio); kind "on_screen" is text that appears on screen. This REPLACES every line of that locale — send the whole script, not a delta. Read video_project_get first: every sceneId must already exist in the piece, and the target duration of each scene is what tells you how long the narration may be. The store hashes each line, and that hash is what lets video_asset_generate reuse audio you already paid for instead of synthesizing it again.',
      inputSchema: videoScriptUpsertSchema,
      handler: (args) => {
        const input = videoScriptUpsertSchema.parse(args)
        const project = resolveProject(input.project)
        assertKnownLocale(project, input.locale)
        assertKnownScenes(
          project,
          input.lines.map((line) => line.sceneId),
        )

        const lines = scriptStore.set({
          projectId: project.id,
          locale: input.locale,
          lines: input.lines,
        })
        notify.broadcast('videoScript:updated', { projectId: project.id, locale: input.locale })
        return ok({ projectId: project.id, locale: input.locale, lineCount: lines.length, lines })
      },
    },
  ]
}

// ---- geração de assets (API paga) ----
//
// A única tool da área que gasta dinheiro. Contrato, nesta ordem:
//   maxCostCents obrigatório → plano (não paga) → teto → dryRun default true.
// dryRun=false sem ter visto o plano é permitido, mas o teto vale igual: acima
// dele a chamada é recusada ANTES de qualquer chamada de API.

const videoAssetGenerateSchema = z
  .object({
    project: z.string().min(1).describe('Project id or slug.'),
    mode: z
      .enum(['audio', 'image'])
      .describe('"audio" = TTS of the narration lines of a locale. "image" = one image via the image model.'),
    maxCostCents: z
      .number()
      .int()
      .positive()
      .describe(
        'MANDATORY spend ceiling for this call, in cents. The call is refused before touching any paid API when the estimate exceeds it. There is no default: the ceiling is always a deliberate decision.',
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe('Default true: return the plan and the estimated cost WITHOUT generating anything.'),
    locale: z.string().min(1).optional().describe('audio mode: which locale to synthesize.'),
    sceneIds: z
      .array(z.string().min(1))
      .optional()
      .describe('audio mode: restrict to these scenes. Omitted = every scene of the piece.'),
    voiceId: z.string().min(1).optional().describe('audio mode: overrides the brand kit voice for the locale.'),
    sceneId: z.string().min(1).optional().describe('image mode: the scene this image belongs to.'),
    kind: videoGeneratedImageKind.optional().describe('image mode: what is being generated.'),
    prompt: z.string().min(1).optional().describe('image mode: the prompt. It is stored with the asset — that is what makes the piece reproducible.'),
    characterId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'image mode: generate WITH a character. This injects that character visual spec into the prompt and passes its approved reference images to the model — the consistency path. Use it whenever the character appears.',
      ),
    refAssetIds: z.array(z.string().min(1)).optional().describe('image mode: extra reference assets.'),
    force: z
      .boolean()
      .optional()
      .describe('Regenerate even when an identical asset already exists (re-pays the API). Off by default.'),
  })
  .refine((v) => v.mode !== 'audio' || Boolean(v.locale), {
    message: 'mode "audio" requires locale',
  })
  .refine((v) => v.mode !== 'image' || (Boolean(v.prompt) && Boolean(v.kind)), {
    message: 'mode "image" requires prompt and kind',
  })

function assetTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'video_asset_generate',
      title: 'Generate video assets (paid, budgeted)',
      description:
        'Generate the assets of a piece through paid APIs: mode "audio" synthesizes the narration of a locale (text-to-speech), mode "image" generates one image. TWO GUARDS, always on. (1) maxCostCents is mandatory — the ceiling in cents for this single call. (2) dryRun defaults to TRUE: the call returns the plan (what would be generated, what would be REUSED because an identical asset already exists, and the estimated cost) and spends nothing. Read the plan, then repeat the call with dryRun: false to actually generate. If the estimate exceeds maxCostCents the call fails before any API request — narrow the batch with sceneIds or raise the ceiling deliberately. Reuse is the default and force: true is what disables it, so re-running this tool after a script edit only pays for the lines that actually changed.',
      inputSchema: videoAssetGenerateSchema,
      handler: async (args) => {
        const input = videoAssetGenerateSchema.parse(args)
        const project = resolveProject(input.project)
        const generator = videoGenerator()

        const audioInput: GenerateVideoAudioInput = {
          projectId: project.id,
          locale: input.locale ?? '',
          sceneIds: input.sceneIds,
          voiceId: input.voiceId,
          force: input.force,
        }
        const imageInput: GenerateVideoImageInput = {
          projectId: project.id,
          sceneId: input.sceneId,
          kind: input.kind ?? 'keyvisual',
          prompt: input.prompt ?? '',
          characterId: input.characterId,
          refAssetIds: input.refAssetIds,
          force: input.force,
        }

        if (input.mode === 'audio') {
          assertKnownLocale(project, input.locale!)
          if (input.sceneIds) assertKnownScenes(project, input.sceneIds)
        } else if (input.sceneId) {
          assertKnownScenes(project, [input.sceneId])
        }

        const plan =
          input.mode === 'audio' ? generator.planAudio(audioInput) : generator.planImage(imageInput)

        if (plan.estimatedCostCents > input.maxCostCents) {
          throw new Error(
            `refused: estimated cost ${plan.estimatedCostCents} cents exceeds maxCostCents ${input.maxCostCents} (${plan.toGenerate} item(s) via ${plan.provider}/${plan.model}, ${plan.reused} already generated and free to reuse). Nothing was generated. Narrow the batch with sceneIds, drop force so existing assets are reused, or raise maxCostCents deliberately.`,
          )
        }

        if (input.dryRun) {
          return ok({
            dryRun: true,
            plan,
            budget: { maxCostCents: input.maxCostCents, estimatedCostCents: plan.estimatedCostCents },
            spentCents: 0,
            next: 'nothing was generated — repeat this call with dryRun: false to spend up to maxCostCents.',
          })
        }

        const result =
          input.mode === 'audio'
            ? await generator.generateAudio(audioInput)
            : await generator.generateImage(imageInput)

        // Espelha o que o handler IPC de generateAudio/generateImage emite: sem
        // isto a UI só veria os assets novos no próximo reload.
        for (const asset of result.assets) notify.broadcast('videoAsset:updated', asset)

        return ok({
          dryRun: false,
          plan,
          budget: { maxCostCents: input.maxCostCents, estimatedCostCents: plan.estimatedCostCents },
          spentCents: result.costCents,
          result,
        })
      },
    },
  ]
}

// ---- render ----

const videoRenderSchema = z.object({
  project: z.string().min(1).describe('Project id or slug.'),
  locale: z.string().min(1),
})

const videoRenderListSchema = z.object({
  id: z.string().min(1).optional().describe('One render by id — this is the only form that returns the log tail.'),
  project: z.string().min(1).optional().describe('Project id or slug.'),
  locale: z.string().optional(),
  status: videoRenderStatus.optional(),
})

function renderTools(notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'video_render',
      title: 'Render one locale of a piece',
      description:
        'Queue the render (Remotion) of one locale of a piece and return the render row immediately — the job runs in the background for minutes and its progress shows up in the app. This does not call any paid API, it burns local CPU. Generate the assets first (video_asset_generate): rendering a locale whose narration was never synthesized produces a silent video. Follow it with video_render_list, which is also where the log of a failed render lives.',
      inputSchema: videoRenderSchema,
      handler: (args) => {
        const { project: ref, locale } = videoRenderSchema.parse(args)
        const project = resolveProject(ref)
        assertKnownLocale(project, locale)
        const render = videoGenerator().startRender({ projectId: project.id, locale })
        notify.broadcast('videoRender:updated', render)
        return ok({ render })
      },
    },
    {
      name: 'video_render_list',
      title: 'List renders',
      description:
        'List the renders (status, output path, size, duration, timings), most recent first — without the log, which is huge. Filter by project (id or slug), locale or status. Pass id to get a single render WITH the tail of its log: that is how you find out why a render failed. A failed render is a recorded result, not an error.',
      inputSchema: videoRenderListSchema,
      handler: (args) => {
        const input = videoRenderListSchema.parse(args)
        if (input.id) {
          const render = renderStore.get(input.id)
          if (!render) return ok({ render: null })
          const { log, ...meta } = render
          return ok({
            render: {
              ...meta,
              logTail: log ? log.slice(-MAX_RENDER_LOG_TAIL) : null,
              logTruncated: Boolean(log && log.length > MAX_RENDER_LOG_TAIL),
            },
          })
        }
        const projectId = input.project ? resolveProject(input.project).id : undefined
        return ok({
          items: renderStore.list({ projectId, locale: input.locale, status: input.status }),
        })
      },
    },
  ]
}

export function videoTools(notify: McpNotify): ToolDef[] {
  return [
    ...brandKitTools(notify),
    ...characterTools(notify),
    ...templateTools(notify),
    ...projectTools(notify),
    ...scriptTools(notify),
    ...assetTools(notify),
    ...renderTools(notify),
  ]
}
