import { PlanCard } from './PlanCard'
import { usePlanFile } from './useChatTranscript'

// Placeholder do card de plano pendente quando o conteúdo não pôde ser resolvido
// (CLI antiga sem plan file, leitura falhou) — fail-safe, comportamento anterior.
export const PLAN_PLACEHOLDER = '_O plano está na conversa acima — revise antes de decidir._'

// PlanCard de transcript (pós-fato) com fallback de robustez: se o input do
// ExitPlanMode veio com plan vazio mas com planFilePath, busca o arquivo.
// Componente próprio porque usePlanFile é um hook (não pode viver no map).
export function TranscriptPlanCard({
  plan,
  planFilePath,
  decision,
}: {
  plan: string
  planFilePath: string | null
  decision?: boolean
}) {
  const fetched = usePlanFile(plan ? null : planFilePath)
  return <PlanCard plan={plan || fetched || PLAN_PLACEHOLDER} decision={decision} />
}
