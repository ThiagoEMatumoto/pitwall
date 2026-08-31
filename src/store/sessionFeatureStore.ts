import { create } from 'zustand'
import { featuresApi, sessionsApi } from '@/lib/ipc'

// Índice REVERSO sessão → feature. O main só sabe responder o caminho de ida
// (`sessions:list-by-feature`), então o renderer monta o inverso uma vez, sob
// demanda, e memoriza os vínculos novos no spawn. Some no dia em que a linha de
// `sessions` carregar `feature_id` (ou existir um `sessions:get-feature`).
interface SessionFeatureState {
  bySessionId: Record<string, string>
  featureTitles: Record<string, string>
  hydrated: boolean
  /** Vínculo recém-criado (spawn): entra no índice sem esperar hydrate. */
  note: (sessionId: string, featureId: string) => void
  hydrate: () => Promise<void>
}

let hydrating: Promise<void> | null = null

export const useSessionFeatureStore = create<SessionFeatureState>((set, get) => ({
  bySessionId: {},
  featureTitles: {},
  hydrated: false,

  note: (sessionId, featureId) => {
    set((s) => ({ bySessionId: { ...s.bySessionId, [sessionId]: featureId } }))
    if (get().featureTitles[featureId]) return
    void featuresApi.get(featureId).then((f) => {
      if (!f) return
      set((s) => ({ featureTitles: { ...s.featureTitles, [f.id]: f.title } }))
    })
  },

  hydrate: async () => {
    if (get().hydrated) return
    // Single-flight: N panes montando ao mesmo tempo pedem UM índice só.
    hydrating ??= (async () => {
      // Só features que têm sessão: o resto não tem o que indexar.
      const feats = (await featuresApi.listWithStats({ includeArchived: true })).filter(
        (f) => f.sessionCount > 0,
      )
      const lists = await Promise.all(feats.map((f) => sessionsApi.listByFeature(f.id)))
      const bySessionId: Record<string, string> = {}
      const featureTitles: Record<string, string> = {}
      feats.forEach((f, i) => {
        featureTitles[f.id] = f.title
        for (const s of lists[i]) bySessionId[s.id] = f.id
      })
      set((s) => ({
        // O que veio do spawn é mais fresco que o índice: fica por cima.
        bySessionId: { ...bySessionId, ...s.bySessionId },
        featureTitles: { ...featureTitles, ...s.featureTitles },
        hydrated: true,
      }))
    })().finally(() => {
      hydrating = null
    })
    await hydrating
  },
}))
