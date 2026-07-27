import { create } from 'zustand'
import { repoApi } from '@/lib/ipc'
import type { RepoPullStatus } from '../../shared/types/ipc'

// Estado do último pull por repo (indexado por repoId), lido da run persistida
// no main. Store separado da lista de repos porque quem dispara o refresh é a
// sidebar (Sync / poll) mas quem lê é cada RepoRow lá embaixo.
interface RepoPullState {
  statusByRepo: Record<string, RepoPullStatus>
  refresh: () => Promise<void>
}

export const useRepoPullStore = create<RepoPullState>((set) => ({
  statusByRepo: {},

  refresh: async () => {
    try {
      const run = await repoApi.lastPullRun()
      const statusByRepo: Record<string, RepoPullStatus> = {}
      for (const r of run?.repos ?? []) statusByRepo[r.repoId] = r
      set({ statusByRepo })
    } catch (err) {
      console.error('[repoPullStore] falha ao ler última run de pull:', err)
    }
  },
}))
