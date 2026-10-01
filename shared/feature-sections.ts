// Seções do corpo (Markdown) do doc de uma feature. Puro: usado pelo main
// (feature-store, síntese, system prompt) e pelo renderer (painel da feature).
//
// "Regras de negócio" e "Notas fixadas" são do USUÁRIO: a síntese holística
// nunca as reescreve — elas ficam fora do prompt e voltam do disco por splice
// determinístico na hora de gravar (spliceUserSections).

export const BUSINESS_RULES_SECTION = 'Regras de negócio'
export const FIXED_NOTES_SECTION = 'Notas fixadas'

export const FEATURE_SECTIONS = [
  'Visão geral',
  BUSINESS_RULES_SECTION,
  FIXED_NOTES_SECTION,
  'Estado atual',
  'Decisões',
  'Pontos em aberto',
  'Linha do tempo',
] as const

export type FeatureSection = (typeof FEATURE_SECTIONS)[number]

export const USER_OWNED_SECTIONS: readonly FeatureSection[] = [
  BUSINESS_RULES_SECTION,
  FIXED_NOTES_SECTION,
]

// Separador entre notas fixadas: uma linha só com `---` (renderiza como régua).
const NOTE_SEPARATOR = /^[ \t]*---[ \t]*$/m

interface Parsed {
  preamble: string
  chunks: { heading: string; text: string }[]
}

const FENCE = /^[ \t]*(```|~~~)/
const SECTION_HEADING = /^## /

// Comparação tolerante a caixa, acento e espaços: o LLM (ou uma edição à mão
// no .md) pode trazer "## Regras de Negócio" e isso ainda é a seção do usuário.
function sameHeading(a: string, b: string): boolean {
  const norm = (h: string) =>
    h.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
  return norm(a) === norm(b)
}

function canonicalName(heading: string): FeatureSection | undefined {
  return FEATURE_SECTIONS.find((s) => sameHeading(s, heading))
}

// Offset de cada linha `## ` fora de bloco de código cercado. Um heading
// canônico encerra uma cerca deixada aberta: sem isso, um ``` sem fechar numa
// seção engoliria o resto do doc e o próximo save apagaria as seções seguintes.
function headingStarts(body: string): number[] {
  const starts: number[] = []
  let inFence = false
  let at = 0
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence
    else if (SECTION_HEADING.test(line) && (!inFence || canonicalName(line.slice(3)))) {
      inFence = false
      starts.push(at)
    }
    at += line.length + 1
  }
  return starts
}

// Autosave no meio da digitação grava cercas abertas; fecha antes de gravar.
function closeOpenFence(markdown: string): string {
  const fences = markdown.split('\n').filter((l) => FENCE.test(l)).length
  return fences % 2 === 0 ? markdown : `${markdown.trimEnd()}\n\`\`\``
}

// Um `## ` digitado nas notas/regras viraria seção nova no parse e escaparia da
// proteção (iria pro prompt da síntese). Rebaixa para `### ` fora de código.
function demoteSectionHeadings(markdown: string): string {
  let inFence = false
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) inFence = !inFence
      return !inFence && SECTION_HEADING.test(line) ? `#${line}` : line
    })
    .join('\n')
}

// Corta o corpo em preâmbulo + blocos que começam numa linha `## ` (fora de
// bloco de código). Juntar preamble + chunks[].text reproduz o corpo byte a byte.
function parse(body: string): Parsed {
  const starts = headingStarts(body)
  const preamble = body.slice(0, starts[0] ?? body.length)
  const chunks = starts.map((start, i) => {
    const text = body.slice(start, starts[i + 1] ?? body.length)
    const nl = text.indexOf('\n')
    const heading = (nl === -1 ? text : text.slice(0, nl)).slice(3).trim()
    return { heading, text }
  })
  return { preamble, chunks }
}

function join(p: Parsed): string {
  return p.preamble + p.chunks.map((c) => c.text).join('')
}

function contentOf(chunkText: string): string {
  const nl = chunkText.indexOf('\n')
  return nl === -1 ? '' : chunkText.slice(nl + 1).trim()
}

function canonicalChunk(heading: string, markdown: string): string {
  const md = markdown.trim()
  return md ? `## ${heading}\n\n${md}\n\n` : `## ${heading}\n\n`
}

function orderOf(heading: string): number {
  const canonical = canonicalName(heading)
  const i = canonical ? FEATURE_SECTIONS.indexOf(canonical) : -1
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

// Garante a linha em branco entre um bloco e o heading seguinte.
function padded(text: string): string {
  if (text.endsWith('\n\n')) return text
  return text.endsWith('\n') ? `${text}\n` : `${text}\n\n`
}

// Insere o bloco antes do primeiro bloco que vem depois dele na ordem canônica.
function insertCanonical(p: Parsed, heading: string, text: string): Parsed {
  const target = orderOf(heading)
  const idx = p.chunks.findIndex((c) => orderOf(c.heading) > target)
  const chunks = [...p.chunks]
  if (idx === -1) {
    const last = chunks.length - 1
    if (last >= 0) chunks[last] = { ...chunks[last], text: padded(chunks[last].text) }
    const preamble = last >= 0 || !p.preamble.trim() ? p.preamble : padded(p.preamble)
    return { preamble, chunks: [...chunks, { heading, text }] }
  }
  chunks.splice(idx, 0, { heading, text: padded(text) })
  if (idx > 0) chunks[idx - 1] = { ...chunks[idx - 1], text: padded(chunks[idx - 1].text) }
  return { preamble: p.preamble, chunks }
}

// Troca a linha do heading pela forma canônica, sem tocar no conteúdo.
function withHeading(chunkText: string, heading: string): string {
  const nl = chunkText.indexOf('\n')
  return nl === -1 ? `## ${heading}` : `## ${heading}${chunkText.slice(nl)}`
}

export function getSection(body: string, heading: string): string {
  const chunk = parse(body).chunks.find((c) => sameHeading(c.heading, heading))
  return chunk ? contentOf(chunk.text) : ''
}

/** Substitui só o conteúdo da seção alvo; ausente, entra na posição canônica. */
export function replaceSection(body: string, heading: string, rawMarkdown: string): string {
  const owned = (USER_OWNED_SECTIONS as readonly string[]).includes(heading)
  const markdown = owned ? closeOpenFence(demoteSectionHeadings(rawMarkdown)) : rawMarkdown
  const p = parse(body)
  const idx = p.chunks.findIndex((c) => sameHeading(c.heading, heading))
  if (idx === -1) return join(insertCanonical(p, heading, canonicalChunk(heading, markdown)))

  const old = p.chunks[idx].text
  const md = markdown.trim()
  const oldContent = contentOf(old)
  let text: string
  if (md && oldContent) {
    // Preserva o espaçamento em volta do conteúdo: o resto do doc não se mexe.
    const at = old.indexOf(oldContent, old.indexOf('\n'))
    text = withHeading(old.slice(0, at) + md + old.slice(at + oldContent.length), heading)
  } else {
    text = canonicalChunk(heading, md)
  }
  const chunks = [...p.chunks]
  chunks[idx] = { heading, text }
  return join({ preamble: p.preamble, chunks })
}

/** Corpo sem as seções do usuário — é o que a síntese pode ver. */
export function stripUserSections(body: string): string {
  const p = parse(body)
  const isOwned = (h: string) => USER_OWNED_SECTIONS.some((o) => sameHeading(o, h))
  return join({ preamble: p.preamble, chunks: p.chunks.filter((c) => !isOwned(c.heading)) })
}

/**
 * Resultado da síntese com as seções do usuário trocadas pelas do disco, byte a
 * byte, independentemente do que o modelo devolveu nelas (ou se omitiu). Doc
 * antigo sem as seções ganha as duas vazias.
 */
export function spliceUserSections(llmBody: string, diskBody: string): string {
  const disk = parse(diskBody)
  let out = parse(stripUserSections(llmBody))
  for (const heading of USER_OWNED_SECTIONS) {
    const fromDisk = disk.chunks.find((c) => sameHeading(c.heading, heading))
    out = insertCanonical(
      out,
      heading,
      fromDisk ? withHeading(fromDisk.text, heading) : canonicalChunk(heading, ''),
    )
  }
  return join(out)
}

export function splitFixedNotes(markdown: string): string[] {
  return markdown
    .split(NOTE_SEPARATOR)
    .map((n) => n.trim())
    .filter(Boolean)
}

export function appendFixedNote(markdown: string, note: string): string {
  const current = markdown.trim()
  const next = note.trim()
  if (!next) return current
  return current ? `${current}\n\n---\n\n${next}` : next
}

/**
 * Merge de duplicata: as regras e as notas fixadas da origem passam para o
 * destino (a síntese nunca as reescreve, então sem isto elas sumiriam junto com
 * a origem arquivada). Trecho que o destino já tem não se repete.
 */
export function absorbUserSections(targetBody: string, sourceBody: string): string {
  let out = targetBody
  const rules = getSection(targetBody, BUSINESS_RULES_SECTION)
  const extraRules = getSection(sourceBody, BUSINESS_RULES_SECTION)
  if (extraRules && !rules.includes(extraRules)) {
    out = replaceSection(out, BUSINESS_RULES_SECTION, rules ? `${rules}\n\n${extraRules}` : extraRules)
  }
  const notes = getSection(targetBody, FIXED_NOTES_SECTION)
  const have = new Set(splitFixedNotes(notes))
  const extraNotes = splitFixedNotes(getSection(sourceBody, FIXED_NOTES_SECTION)).filter(
    (n) => !have.has(n),
  )
  if (extraNotes.length > 0) {
    out = replaceSection(out, FIXED_NOTES_SECTION, extraNotes.reduce(appendFixedNote, notes))
  }
  return out
}

/**
 * Seções do doc que entram INTEIRAS no system prompt das sessões da feature.
 * Só as regras de negócio: curtas, escritas pelo usuário e válidas para
 * qualquer trabalho na frente. O resto o bloco aponta (ver feature-context.ts).
 */
export function extractKeySections(body: string): string {
  const rules = getSection(body, BUSINESS_RULES_SECTION)
  return rules ? `## ${BUSINESS_RULES_SECTION}\n\n${rules}` : ''
}
