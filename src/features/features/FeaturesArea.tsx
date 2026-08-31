import { useEffect, useMemo, useState } from 'react'
import { LayoutList, Columns3 } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { objectivesApi, projectsApi, featuresApi } from '@/lib/ipc'
import { useFeaturesStore } from '@/store/featuresStore'
import { isDraftFeature } from '../../../shared/feature-visibility'
import type {
  CreateFeatureInput,
  Feature,
  FeatureWithStats,
  ObjectiveDetail as ObjectiveDetailType,
  ObjectiveWithProgress,
  Project,
  Repo,
} from '../../../shared/types/ipc'
import { FeatureBoard } from './FeatureBoard'
import { FeatureDoc } from './FeatureDoc'
import { FeatureList } from './FeatureList'
import { FeaturesSidebar, type StatusFilter } from './FeaturesSidebar'
import { NewFeatureDialog } from './NewFeatureDialog'
import { useFeatures } from './useFeatures'

type ViewMode = 'list' | 'board'

export function FeaturesArea() {
  useFeatures()
  const features = useFeaturesStore((s) => s.features)
  const byProject = useFeaturesStore((s) => s.byProject)
  const withStats = useFeaturesStore((s) => s.withStats)
  const sessionCounts = useFeaturesStore((s) => s.sessionCounts)
  const selectedId = useFeaturesStore((s) => s.selectedId)
  const selectedDoc = useFeaturesStore((s) => s.selectedDoc)
  const loading = useFeaturesStore((s) => s.loading)
  const docLoading = useFeaturesStore((s) => s.docLoading)
  const select = useFeaturesStore((s) => s.select)
  const refresh = useFeaturesStore((s) => s.refresh)

  const [projects, setProjects] = useState<Project[]>([])
  const [repos, setRepos] = useState<Repo[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [creating, setCreating] = useState(false)
  const [backfilling, setBackfilling] = useState(false)
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('list')
  // Filtro por objetivo (Onda 2 — fecha a sub-linkagem): '' = todos, 'none' =
  // sem objetivo (objectiveLinkCount === 0, Onda 0), senão um objectiveId.
  const [objectives, setObjectives] = useState<ObjectiveWithProgress[]>([])
  const [objectiveFilter, setObjectiveFilter] = useState('')
  const [objectiveFilterDetail, setObjectiveFilterDetail] = useState<ObjectiveDetailType | null>(
    null,
  )

  useEffect(() => {
    void projectsApi.list().then(setProjects)
    void objectivesApi.list().then(setObjectives)
  }, [])

  // Detalhe do objetivo escolhido no filtro: dá as features vinculadas a ele
  // direto + via cada KR (mesmo dado que ObjectiveDetail já usa pra render).
  useEffect(() => {
    if (objectiveFilter === '' || objectiveFilter === 'none') {
      setObjectiveFilterDetail(null)
      return
    }
    let alive = true
    void objectivesApi.get(objectiveFilter).then((detail) => {
      if (alive) setObjectiveFilterDetail(detail)
    })
    return () => {
      alive = false
    }
  }, [objectiveFilter])

  const objectiveFilterFeatureIds = useMemo(() => {
    if (!objectiveFilterDetail) return null
    const ids = new Set<string>()
    for (const f of objectiveFilterDetail.linkedFeatures) ids.add(f.id)
    for (const kr of objectiveFilterDetail.keyResults) {
      for (const f of kr.linkedFeatures) ids.add(f.id)
    }
    return ids
  }, [objectiveFilterDetail])

  const matchesObjectiveFilter = useMemo(() => {
    if (objectiveFilter === '') return () => true
    if (objectiveFilter === 'none') return (f: Feature) => f.objectiveLinkCount === 0
    return (f: Feature) => objectiveFilterFeatureIds?.has(f.id) ?? false
  }, [objectiveFilter, objectiveFilterFeatureIds])

  // Junta os repos de todos os projetos pra resolver labels nos chips/cards.
  useEffect(() => {
    let alive = true
    void Promise.all(projects.map((p) => projectsApi.listRepos(p.id))).then((lists) => {
      if (alive) setRepos(lists.flat())
    })
    return () => {
      alive = false
    }
  }, [projects])

  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos])
  // O dossiê precisa do projeto (nome/ícone/cor) pra abrir a sessão no repo certo.
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  // Stats por feature (recordCount/lastRecordAt) — alimenta badges e ordenação.
  const statsById = useMemo(
    () => new Map<string, FeatureWithStats>(withStats.map((f) => [f.id, f])),
    [withStats],
  )

  // Rascunhos ocultos (auto-criados, 0 registros, não arquivados): só aparecem
  // no filtro "Rascunhos" — withStats vem com includeDrafts:true do store.
  const drafts = useMemo(
    () => withStats.filter((f) => !f.archivedAt && isDraftFeature(f.origin, f.recordCount)),
    [withStats],
  )

  // App-dev (Onda 3 — separação app-dev): dev do próprio claude-manager, fora
  // de qualquer outro filtro por default — só aparece no filtro "App dev".
  const appDevFeatures = useMemo(() => withStats.filter((f) => f.isAppDev), [withStats])

  const q = query.trim().toLowerCase()
  const listed = useMemo(() => {
    const source: Feature[] = filter === 'drafts' ? drafts : filter === 'app-dev' ? appDevFeatures : features
    const filtered = source.filter((f) => {
      if (
        filter !== 'all' &&
        filter !== 'drafts' &&
        filter !== 'app-dev' &&
        f.status !== filter
      ) {
        return false
      }
      if (filter !== 'app-dev' && f.isAppDev) return false
      if (q && !f.title.toLowerCase().includes(q)) return false
      if (!matchesObjectiveFilter(f)) return false
      return true
    })
    // Ordena por atividade REAL: último session record quando existe, senão
    // o updated_at do índice (mexer em metadado não "sobe" a feature).
    const activity = (f: Feature) => statsById.get(f.id)?.lastRecordAt ?? f.updatedAt
    return [...filtered].sort((a, b) => activity(b) - activity(a))
  }, [features, drafts, appDevFeatures, statsById, filter, q, matchesObjectiveFilter])

  // Sidebar agrupada por projeto: no filtro "Rascunhos"/"App dev" troca a
  // fonte pelo conjunto correspondente; nos demais filtros, app-dev fica fora.
  const sidebarByProject = useMemo(() => {
    let base = byProject
    if (filter === 'drafts') {
      const by: Record<string, Feature[]> = {}
      for (const f of drafts) (by[f.projectId] ??= []).push(f)
      base = by
    } else if (filter === 'app-dev') {
      const by: Record<string, Feature[]> = {}
      for (const f of appDevFeatures) (by[f.projectId] ??= []).push(f)
      base = by
    } else {
      const by: Record<string, Feature[]> = {}
      for (const [projectId, feats] of Object.entries(base)) {
        by[projectId] = feats.filter((f) => !f.isAppDev)
      }
      base = by
    }
    if (objectiveFilter === '') return base
    const filtered: Record<string, Feature[]> = {}
    for (const [projectId, feats] of Object.entries(base)) {
      const kept = feats.filter(matchesObjectiveFilter)
      if (kept.length > 0) filtered[projectId] = kept
    }
    return filtered
  }, [filter, byProject, drafts, appDevFeatures, objectiveFilter, matchesObjectiveFilter])

  // Board: usa a lista com stats (inclui arquivadas, mas NUNCA rascunhos nem
  // app-dev — mesmo default-oculto das outras views).
  const boardFeatures = useMemo(() => {
    const visible = withStats.filter((f) => !isDraftFeature(f.origin, f.recordCount) && !f.isAppDev)
    const filtered = q ? visible.filter((f) => f.title.toLowerCase().includes(q)) : visible
    return filtered.filter(matchesObjectiveFilter)
  }, [withStats, q, matchesObjectiveFilter])

  async function handleCreate(input: CreateFeatureInput) {
    const created = await featuresApi.create(input)
    await refresh()
    void select(created.id)
  }

  // Archive manual a partir do card (sem auto-archive: badge informa, humano decide).
  async function handleArchive(id: string) {
    await featuresApi.archive(id)
    if (selectedId === id) void select(null)
    await refresh()
  }

  async function handleBackfill() {
    setBackfilling(true)
    setBackfillMsg(null)
    try {
      const res = await featuresApi.backfill()
      await refresh()
      setBackfillMsg(
        `Backfill: ${res.created} criada(s), ${res.linked} vinculada(s), ${res.skipped} ignorada(s).`,
      )
    } catch {
      setBackfillMsg('Falha ao importar features de sessões anteriores.')
    } finally {
      setBackfilling(false)
    }
  }

  return (
    <>
      <FeaturesSidebar
        projects={projects}
        byProject={sidebarByProject}
        selectedId={selectedId}
        loading={loading}
        query={query}
        filter={filter}
        objectives={objectives}
        objectiveFilter={objectiveFilter}
        onQuery={setQuery}
        onFilter={setFilter}
        onObjectiveFilter={setObjectiveFilter}
        onSelect={(id) => void select(id)}
        onReload={() => void refresh()}
        onNew={() => setCreating(true)}
        onBackfill={() => void handleBackfill()}
        backfilling={backfilling}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        {backfillMsg && (
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs text-[var(--color-text)]">
            <span>{backfillMsg}</span>
            <button
              type="button"
              onClick={() => setBackfillMsg(null)}
              className="rounded px-1 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
        {selectedId ? (
          <FeatureDoc
            feature={selectedDoc}
            loading={docLoading}
            reposById={reposById}
            projectsById={projectsById}
          />
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-end gap-1 border-b border-[var(--color-border)] px-4 py-2">
              <ViewToggle value={view} onChange={setView} />
            </div>
            {view === 'board' ? (
              <div className="flex-1 overflow-hidden p-5">
                <FeatureBoard
                  features={boardFeatures}
                  reposById={reposById}
                  sessionCounts={sessionCounts}
                  selectedId={selectedId}
                  onSelect={(id) => void select(id)}
                />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-5">
                <FeatureList
                  features={listed}
                  reposById={reposById}
                  sessionCounts={sessionCounts}
                  statsById={statsById}
                  selectedId={selectedId}
                  onSelect={(id) => void select(id)}
                  onArchive={(id) => void handleArchive(id)}
                />
              </div>
            )}
          </div>
        )}
        </div>
      </main>

      <NewFeatureDialog
        open={creating}
        onClose={() => setCreating(false)}
        projects={projects}
        onCreate={handleCreate}
      />
    </>
  )
}

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex rounded-md border border-[var(--color-border)] p-0.5">
      <button
        type="button"
        onClick={() => onChange('list')}
        title="Lista"
        className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition ${
          value === 'list'
            ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
            : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
        }`}
      >
        <Icon as={LayoutList} size={13} />
        Lista
      </button>
      <button
        type="button"
        onClick={() => onChange('board')}
        title="Board"
        className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition ${
          value === 'board'
            ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
            : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
        }`}
      >
        <Icon as={Columns3} size={13} />
        Board
      </button>
    </div>
  )
}
