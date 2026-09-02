// Gate de fixture pro e2e: com CM_MEETING_SUMMARY_FIXTURE apontando pra um
// JSON, resumo e extração usam o conteúdo dele em vez de chamar o claude. O
// resto do pipeline (prefs, store, eventos, grounding) roda igual.
import { readFileSync } from 'node:fs'

export interface SummaryFixture {
  summaryMd: string
  actionItems: Array<{ title: string; quote: string | null }>
}

export const SUMMARY_FIXTURE_ENV = 'CM_MEETING_SUMMARY_FIXTURE'

export function loadSummaryFixture(env: NodeJS.ProcessEnv = process.env): SummaryFixture | null {
  const path = env[SUMMARY_FIXTURE_ENV]
  if (!path) return null
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SummaryFixture>
  if (typeof raw.summaryMd !== 'string') {
    throw new Error(`${SUMMARY_FIXTURE_ENV}: campo "summaryMd" (string) obrigatório`)
  }
  const items = Array.isArray(raw.actionItems) ? raw.actionItems : []
  return {
    summaryMd: raw.summaryMd,
    actionItems: items
      .filter((item): item is { title: string; quote: string | null } => typeof item?.title === 'string')
      .map((item) => ({ title: item.title, quote: typeof item.quote === 'string' ? item.quote : null })),
  }
}
