// Título de EXIBIÇÃO de uma sessão não-filha (sessions.auto_title, migration 068).
// Nunca é o endereço: o `-n` (peer messaging) e sessions.title seguem intactos.
// 'llm' = gerado do 1º prompt pelo Pitwall; 'self' = a própria sessão via MCP
// (session_title_set), que vence o 'llm'.
export type AutoTitleSource = 'llm' | 'self'

export const AUTO_TITLE_MAX_CHARS = 48

const QUOTES_RE = /^["'`“”‘’«»]+|["'`“”‘’«»]+$/g
const TRAILING_PUNCT_RE = /[\s.!?;:,…]+$/
const LABEL_PREFIX_RE = /^(t[íi]tulo|title)\s*:\s*/i

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const space = head.lastIndexOf(' ')
  // Palavra gigante: corta seco em vez de devolver quase nada.
  return (space >= max / 2 ? head.slice(0, space) : head).trim()
}

// Saída do modelo (ou da tool) → título de uma linha, ou null se não sobrar nada.
export function normalizeAutoTitle(raw: string): string | null {
  const firstLine = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return null
  let text = firstLine.replace(LABEL_PREFIX_RE, '')
  for (let i = 0; i < 3; i++) {
    text = text.replace(TRAILING_PUNCT_RE, '').replace(QUOTES_RE, '').trim()
  }
  text = cut(text.replace(/\s+/g, ' '), AUTO_TITLE_MAX_CHARS).replace(TRAILING_PUNCT_RE, '')
  return text.length > 0 ? text : null
}

// "É filha" para o auto-título, sobre os campos do nó do grafo: a régua por
// conversa (hierarchyMotherId, readHierarchyLinks) ou o vínculo vivo do handoff.
export function isChildSessionNode(n: {
  sessionId: string
  hierarchyMotherId?: string | null
  childOfHandoffId?: string | null
}): boolean {
  return !!n.childOfHandoffId || (!!n.hierarchyMotherId && n.hierarchyMotherId !== n.sessionId)
}

// Regra ÚNICA de nome próprio de exibição: rename manual > auto-título (só
// não-filha) > null. null = o chamador mantém o fallback que já tinha (nome do
// CLI, título salvo, repo, 'Avulsa'). Filha segue com o apelido de sempre.
export function preferredSessionTitle(args: {
  manualTitle: string | null | undefined
  autoTitle: string | null | undefined
  isChild?: boolean
}): string | null {
  const manual = args.manualTitle?.trim()
  if (manual) return manual
  if (args.isChild) return null
  return args.autoTitle?.trim() || null
}
