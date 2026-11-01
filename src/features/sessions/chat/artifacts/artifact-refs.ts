import type { ChatMessage } from '@shared/types/chat'

// Liga cada tool_use mcp__pitwall__diagram_* / design_* do transcript ao
// artefato que ele tocou, para o chat mostrar um card do artefato em vez do
// JSON cru. O id sai do input (patch/update, writes por docId), do tool_result
// casado por forId (create) ou de um artboard criado antes na mesma conversa.

export type ArtifactKind = 'diagram' | 'design'

export interface ArtifactRef {
  kind: ArtifactKind
  id: string
}

export interface ArtifactCardPlan {
  ref: ArtifactRef
  title: string | null
  // Quantas chamadas do turno foram fundidas neste card (>= 1).
  calls: number
  lastTool: string
}

export interface ArtifactPlan {
  // índice da mensagem → card a renderizar no lugar do tool_use
  cards: Map<number, ArtifactCardPlan>
  // tool_use fundidos num card posterior e tool_result já representados pelo card
  hidden: Set<number>
}

const PREFIX = 'mcp__pitwall__'

export function artifactKindOf(toolName: string): ArtifactKind | null {
  if (!toolName.startsWith(PREFIX)) return null
  const tool = toolName.slice(PREFIX.length)
  // Pastas e biblioteca não são um artefato: seguem no card genérico.
  if (/^(diagram|design)_folder_/.test(tool) || tool.startsWith('diagram_library_')) return null
  if (tool.startsWith('diagram_')) return 'diagram'
  if (tool.startsWith('design_')) return 'design'
  return null
}

export function artifactRefKey(ref: ArtifactRef): string {
  return `${ref.kind}:${ref.id}`
}

type Json = Record<string, unknown>

function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function parseResult(content: string): Json | null {
  try {
    return asObject(JSON.parse(content))
  } catch {
    return null
  }
}

interface Resolved {
  id: string | null
  title: string | null
}

function resolveDiagram(input: Json | null, result: Json | null): Resolved {
  const diagram = asObject(result?.diagram)
  return {
    id: str(input?.id) ?? str(input?.diagramId) ?? str(diagram?.id) ?? str(result?.id) ?? null,
    title: str(diagram?.title) ?? str(input?.title),
  }
}

function resolveDesign(
  input: Json | null,
  result: Json | null,
  docOfArtboard: Map<string, string>,
): Resolved {
  const document = asObject(result?.document)
  const artboardId = str(input?.artboardId) ?? str(result?.artboardId)
  return {
    id:
      str(input?.docId) ??
      str(input?.documentId) ??
      str(document?.id) ??
      str(result?.docId) ??
      (artboardId ? (docOfArtboard.get(artboardId) ?? null) : null),
    title: str(document?.title) ?? (str(input?.docId) ? null : str(input?.title)),
  }
}

// Artboards criados (ou citados com o doc) nesta conversa: os writes que só
// mandam artboardId resolvem o documento por aqui.
function learnArtboards(
  input: Json | null,
  result: Json | null,
  docOfArtboard: Map<string, string>,
): void {
  const artboard = asObject(result?.artboard)
  const doc = str(input?.docId) ?? str(result?.docId)
  const artboardId = str(artboard?.id) ?? str(result?.artboardId) ?? str(input?.artboardId)
  if (doc && artboardId) docOfArtboard.set(artboardId, doc)
}

export function planArtifacts(messages: readonly ChatMessage[]): ArtifactPlan {
  const results = new Map<string, { idx: number; content: string; isError: boolean }>()
  messages.forEach((m, idx) => {
    if (m.kind === 'tool_result' && m.forId) {
      results.set(m.forId, { idx, content: m.content, isError: m.isError })
    }
  })

  const cards = new Map<number, ArtifactCardPlan>()
  const hidden = new Set<number>()
  const docOfArtboard = new Map<string, string>()
  const titles = new Map<string, string>()
  // Card vivo de cada artefato no turno atual (índice do tool_use que o exibe).
  let turn = new Map<string, number>()

  messages.forEach((m, idx) => {
    if (m.kind === 'user') {
      turn = new Map()
      return
    }
    if (m.kind !== 'tool_use') return
    const kind = artifactKindOf(m.name)
    if (!kind) return
    const input = asObject(m.input)
    const res = m.id ? results.get(m.id) : undefined
    const result = res && !res.isError ? parseResult(res.content) : null
    if (kind === 'design') learnArtboards(input, result, docOfArtboard)
    const resolved =
      kind === 'diagram'
        ? resolveDiagram(input, result)
        : resolveDesign(input, result, docOfArtboard)
    if (!resolved.id) return

    const ref: ArtifactRef = { kind, id: resolved.id }
    const key = artifactRefKey(ref)
    if (resolved.title) titles.set(key, resolved.title)
    const previous = turn.get(key)
    const calls = previous !== undefined ? (cards.get(previous)?.calls ?? 0) + 1 : 1
    if (previous !== undefined) {
      cards.delete(previous)
      hidden.add(previous)
    }
    cards.set(idx, {
      ref,
      title: titles.get(key) ?? null,
      calls,
      lastTool: m.name.slice(PREFIX.length),
    })
    turn.set(key, idx)
    // Erro continua visível: é a única pista do que falhou.
    if (res && !res.isError) hidden.add(res.idx)
  })

  // Um título aprendido depois (ex.: create no fim do turno) vale para os cards anteriores.
  for (const card of cards.values()) {
    card.title = titles.get(artifactRefKey(card.ref)) ?? card.title
  }
  return { cards, hidden }
}
