// Heurísticas puras do auto-registro de features — SEM deps de electron/db, para
// serem testáveis isoladamente (mesmo padrão de metrics-totals.ts).
import type { FeatureSynthMode } from '../../../shared/types/ipc'

const PROTECTED_BRANCHES = new Set(['main', 'master', 'staging', 'develop'])
const BRANCH_PREFIX_RE = /^(?:feat|fix|chore|refactor|feature)\//i
// Piso do sinal aproveitável de semelhança: abaixo disso o par não tem nada a
// ver. Entre este piso e FUZZY_LINK_THRESHOLD a semelhança é SUSPEITA (cria e
// marca); daqui pra cima, antes, linkava direto — era o que fabricava vínculo
// errado e feature duplicada.
export const FUZZY_THRESHOLD = 0.5

// Confiança suficiente pra vincular a sessão a uma feature existente SEM
// perguntar. 0.75 no fuzzyScore (tokens do título casados / total de tokens do
// título) significa: no máximo um token faltando num título de 4 palavras, e
// título de 2 palavras só casa inteiro. O 0.5 antigo aceitava "metade do
// título" — em título de 2 tokens, UM token casado bastava pra colar a sessão
// na feature errada.
export const FUZZY_LINK_THRESHOLD = 0.75

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch.trim().toLowerCase())
}

// Branch "real" (não-vazia, não detached). Retorna null caso contrário.
export function normalizeBranch(branch: string | null | undefined): string | null {
  const b = branch?.trim()
  if (!b || b === 'HEAD' || b === '(detached)') return null
  return b
}

// "feat/penalty-clause-s4" -> "Penalty clause s4"
export function humanizeBranch(branch: string): string {
  const stripped = branch.replace(BRANCH_PREFIX_RE, '')
  const words = stripped.replace(/[-_/]+/g, ' ').trim()
  if (!words) return branch
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// Branch de TRABALHO da sessão: a última não-protegida vista (o usuário roda na
// main e cria feat/* dentro da sessão), senão a última vista, senão null. Pegar a
// primeira branch (main) era a causa de 0 features auto-registradas.
export function pickWorkBranch(branches: string[]): string | null {
  const seen = branches.map((b) => b?.trim()).filter((b): b is string => !!b)
  if (seen.length === 0) return null
  for (let i = seen.length - 1; i >= 0; i--) {
    if (!isProtectedBranch(seen[i])) return seen[i]
  }
  return seen[seen.length - 1]
}

// Título de feature derivado do 1º prompt (trabalho na main, sem branch feat/*).
export function deriveTitle(prompt: string | null): string | null {
  if (!prompt) return null
  const firstLine = prompt.split('\n').map((s) => s.trim()).find(Boolean) ?? ''
  const clean = firstLine.replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!clean) return null
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

// Score simples sem lib: substring forte + overlap de tokens normalizado.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1)
}

export function fuzzyScore(prompt: string, title: string): number {
  const p = prompt.toLowerCase().trim()
  const t = title.toLowerCase().trim()
  if (!p || !t) return 0
  if (p.includes(t) || t.includes(p)) return 1
  const pt = new Set(tokenize(prompt))
  const tt = tokenize(title)
  if (pt.size === 0 || tt.length === 0) return 0
  const matched = tt.filter((tok) => pt.has(tok)).length
  // normaliza pelo número de tokens do título (o alvo mais curto).
  return matched / tt.length
}

// ---- Decisão de registro (lógica pura, sem efeitos) ----

export interface RegistrationInputs {
  synthMode: FeatureSynthMode
  userTurns: number
  editCount: number
  // Branch de trabalho (não-protegida) ou null se a sessão ficou só na main.
  workBranch: string | null
  firstPrompt: string | null
  // Feature já existente casando (repo, workBranch), se houver.
  byBranchFeatureId: string | null
  // Melhor candidato por fuzzy de objetivo, se houver.
  fuzzyMatch: { featureId: string; score: number } | null
}

export type RegistrationDecision =
  | { action: 'skip' }
  | { action: 'link'; featureId: string }
  | { action: 'create'; title: string }
  // Semelhança na faixa do meio: CRIA o rascunho (o trabalho da sessão nunca se
  // perde por causa de um palpite) e ainda entrega o candidato, pra quem
  // persiste marcar a suspeita e a UI oferecer "mesclar". `title` vem junto
  // porque o caminho é o mesmo de 'create' — quem consome não recalcula.
  | { action: 'suspect'; title: string; candidateId: string; score: number }

// Decide o que fazer com uma sessão encerrada. Núcleo do auto-registro — antes
// embutido em resolveFeature, extraído para ser testável. O bug original: nunca
// chegava a 'create' porque exigia branch não-protegida (todas eram main).
export function decideRegistration(inp: RegistrationInputs): RegistrationDecision {
  // Guarda de atividade (modo 'threshold'; 'auto' pula). Filtra sessões triviais.
  if (inp.synthMode !== 'auto' && (inp.userTurns < 2 || inp.editCount === 0)) {
    return { action: 'skip' }
  }
  // Link por branch de trabalho (feat/* já registrada).
  if (inp.workBranch && inp.byBranchFeatureId) {
    return { action: 'link', featureId: inp.byBranchFeatureId }
  }
  // Link por objetivo (fuzzy) — agrupa sessões parecidas, inclusive na main.
  // Só com confiança ALTA: o threshold baixo colava sessões em features alheias.
  if (inp.fuzzyMatch && inp.fuzzyMatch.score >= FUZZY_LINK_THRESHOLD) {
    return { action: 'link', featureId: inp.fuzzyMatch.featureId }
  }
  // Criar: título pela branch de trabalho, ou pelo objetivo (trabalho na main).
  const title = inp.workBranch ? humanizeBranch(inp.workBranch) : deriveTitle(inp.firstPrompt)
  // Faixa do meio: parece, mas não o bastante pra decidir sozinho.
  if (inp.fuzzyMatch && inp.fuzzyMatch.score >= FUZZY_THRESHOLD) {
    // Sem título não há rascunho a criar; o candidato é a melhor casa disponível
    // e vale mais que descartar a sessão.
    if (!title) return { action: 'link', featureId: inp.fuzzyMatch.featureId }
    return {
      action: 'suspect',
      title,
      candidateId: inp.fuzzyMatch.featureId,
      score: inp.fuzzyMatch.score,
    }
  }
  if (!title) return { action: 'skip' }
  return { action: 'create', title }
}

// ---- Auto-sugestão de vínculo a objetivo (Onda 2 — fecha a sub-linkagem) ----

// Score alto: confiança suficiente pra gravar o link automaticamente. Score
// médio: sinaliza "precisa revisão humana" (nunca grava link silenciosamente
// abaixo do threshold alto). Abaixo do médio: ignora — sem sinal aproveitável.
export const OBJECTIVE_LINK_THRESHOLD_HIGH = 0.6
export const OBJECTIVE_LINK_THRESHOLD_MEDIUM = 0.35

export type ObjectiveLinkDecision = 'link' | 'needs-review' | 'skip'

export function decideObjectiveLink(score: number): ObjectiveLinkDecision {
  if (score >= OBJECTIVE_LINK_THRESHOLD_HIGH) return 'link'
  if (score >= OBJECTIVE_LINK_THRESHOLD_MEDIUM) return 'needs-review'
  return 'skip'
}
