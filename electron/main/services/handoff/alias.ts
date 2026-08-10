// Identidade endereçável da sessão-filha de handoff. O alias vira o `-n <name>`
// do spawn, e esse nome é literalmente o ENDEREÇO do cross-session messaging
// (`SendMessage({ to: "<alias>" })`) — quando dois peers colidem no nome, a CLI
// desambigua com um hex ilegível (`[2946b9]`). Daí o formato `<nome>-<escopo>`:
// nome humano estável por papel + escopo derivado da task, único entre as sessões
// vivas.
//
// Módulo PURO (sem I/O, sem electron) — o conjunto de nomes já ocupados chega por
// argumento. Testável direto.

import type { HandoffMode } from '../../../../shared/types/ipc'

// Papéis alcançáveis hoje: derivam 1:1 do modo do handoff. Não há papel sem
// origem no modelo (nada de papel especulativo só pra ter pool maior).
export type HandoffRole = 'investigator' | 'implementer' | 'operator'

// Pool de nomes humanos por papel. ESTÁVEL: um handoff de implementação começa
// sempre em "mauricio"; os seguintes do pool só entram quando o primeiro já está
// ocupado no mesmo escopo (desambiguação legível antes de cair no número).
const ROLE_NAMES: Record<HandoffRole, readonly string[]> = {
  investigator: ['otavio', 'marina', 'caio'],
  implementer: ['mauricio', 'rafael', 'gustavo'],
  operator: ['renata', 'joaquim', 'lia'],
}

export function roleForHandoffMode(mode: HandoffMode | null | undefined): HandoffRole {
  switch (mode) {
    case 'auto-edits':
      return 'implementer'
    case 'interactive':
      return 'operator'
    case 'plan':
    default:
      return 'investigator'
  }
}

// Kebab ESTRITO: o `to` do SendMessage é string crua, então nada de espaço,
// acento, parêntese ou maiúscula sobrevive. NFD + remoção de diacríticos resolve
// "refatoração" → "refatoracao" (e não "refatorao").
export function kebab(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Palavras vazias que só gastam caracteres do escopo sem informar (PT-BR + EN).
const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'o', 'a', 'os', 'as', 'um', 'uma', 'e', 'em',
  'no', 'na', 'nos', 'nas', 'ao', 'aos', 'para', 'pra', 'por', 'com', 'que',
  'the', 'of', 'to', 'for', 'and', 'in', 'on', 'an',
])

const SCOPE_MAX_WORDS = 3
const SCOPE_MAX_CHARS = 28

// Escopo legível derivado da task: até 3 palavras úteis, ≤28 chars. Vazio (task
// só com pontuação/stopwords) cai em 'task' — nunca devolve string vazia, que
// produziria um alias terminado em '-'.
export function scopeSlug(task: string): string {
  const words = kebab(task).split('-').filter(Boolean)
  if (words.length === 0) return 'task'
  const useful = words.filter((w) => !STOPWORDS.has(w))
  const picked: string[] = []
  for (const word of (useful.length > 0 ? useful : words).slice(0, SCOPE_MAX_WORDS)) {
    const next = [...picked, word].join('-')
    if (picked.length > 0 && next.length > SCOPE_MAX_CHARS) break
    picked.push(word)
  }
  return picked.join('-').slice(0, SCOPE_MAX_CHARS).replace(/-+$/, '') || 'task'
}

export interface BuildAliasInput {
  role: HandoffRole
  task: string
  // Nomes já ocupados (sessões vivas). Comparação case-insensitive.
  taken?: Iterable<string> | null
}

// Monta `<nome>-<escopo>` único contra `taken`. Desambigua primeiro percorrendo o
// pool do papel (mauricio-auth → rafael-auth); só quando o pool inteiro está
// ocupado no mesmo escopo é que entra o sufixo numérico.
export function buildHandoffAlias(input: BuildAliasInput): string {
  const scope = scopeSlug(input.task)
  const taken = new Set(
    Array.from(input.taken ?? [])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean),
  )
  const names = ROLE_NAMES[input.role] ?? ROLE_NAMES.investigator

  for (const name of names) {
    const candidate = `${name}-${scope}`
    if (!taken.has(candidate)) return candidate
  }

  const base = `${names[0]}-${scope}`
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  // 99 colisões no mesmo papel+escopo é cenário impossível na prática (o cap de
  // handoffs ativos é 5); o timestamp fecha o contrato "sempre devolve único".
  return `${base}-${Date.now()}`
}
