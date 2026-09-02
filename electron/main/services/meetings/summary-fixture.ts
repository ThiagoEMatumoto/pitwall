// Gate de fixture pro e2e: com CM_MEETING_SUMMARY_FIXTURE apontando pra um
// JSON, resumo e extração usam o conteúdo dele em vez de chamar o claude. O
// resto do pipeline (prefs, store, eventos, grounding) roda igual.
import { readFileSync } from 'node:fs'

export interface SummaryFixtureItem {
  title: string
  quote: string | null
  owner: string | null
  atMs: number | null
}

export interface SummaryFixture {
  summaryMd: string
  actionItems: SummaryFixtureItem[]
}

export const SUMMARY_FIXTURE_ENV = 'CM_MEETING_SUMMARY_FIXTURE'

function parseAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{1,3}):(\d{2})$/)
  return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null
}

export function loadSummaryFixture(env: NodeJS.ProcessEnv = process.env): SummaryFixture | null {
  const path = env[SUMMARY_FIXTURE_ENV]
  if (!path) return null
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { summaryMd?: unknown; actionItems?: unknown }
  if (typeof raw.summaryMd !== 'string') {
    throw new Error(`${SUMMARY_FIXTURE_ENV}: campo "summaryMd" (string) obrigatório`)
  }
  const items = Array.isArray(raw.actionItems) ? (raw.actionItems as Array<Record<string, unknown>>) : []
  return {
    summaryMd: raw.summaryMd,
    actionItems: items
      .filter((item): item is Record<string, unknown> & { title: string } => typeof item?.title === 'string')
      .map((item) => ({
        title: item.title,
        quote: typeof item.quote === 'string' ? item.quote : null,
        owner: typeof item.owner === 'string' && item.owner.trim() ? item.owner.trim() : null,
        atMs: parseAt(item.at),
      })),
  }
}
