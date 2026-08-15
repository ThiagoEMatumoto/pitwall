import { create } from 'zustand'
import { contentContractsApi } from '@/lib/ipc'
import type {
  ContentContract,
  ContentContractVersion,
  ContentGateRun,
} from '../../shared/types/ipc'

// Donos únicos das assinaturas (StrictMode-safe): contratos e gate runs são
// canais IPC distintos, cada um com seu unsubscribe. `watchStarted` guarda
// contra o duplo-mount do effect no StrictMode (a 2ª chamada é no-op).
let offUpdated: (() => void) | null = null
let offGateRunUpdated: (() => void) | null = null
let watchStarted = false

interface ContentContractsState {
  contracts: ContentContract[]
  selectedContractId: string | null
  // Histórico de gate runs do contrato selecionado (recarregado a cada
  // seleção/broadcast).
  gateRuns: ContentGateRun[]
  // Changelog do contrato selecionado: o que mudou e por quê em cada emenda.
  versions: ContentContractVersion[]
  loading: boolean
  runsLoading: boolean
  versionsLoading: boolean
  error: string | null

  load: () => Promise<void>
  loadGateRuns: (contractId: string) => Promise<void>
  loadVersions: (contractId: string) => Promise<void>
  selectContract: (id: string | null) => Promise<void>
  startWatch: () => void
  stopWatch: () => void
}

// Read-only por decisão de escopo: a edição do contrato acontece via MCP
// (content_contract_upsert), que é quem exige changelog a cada bump. Por isso
// não há create/update/delete aqui.
export const useContentContractsStore = create<ContentContractsState>((set, get) => ({
  contracts: [],
  selectedContractId: null,
  gateRuns: [],
  versions: [],
  loading: false,
  runsLoading: false,
  versionsLoading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const contracts = await contentContractsApi.list()
      set({ contracts, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  loadGateRuns: async (contractId) => {
    set({ runsLoading: true })
    try {
      const gateRuns = await contentContractsApi.listGateRuns({ contractId })
      // Ignora resultado obsoleto se o usuário já trocou de contrato.
      if (get().selectedContractId !== contractId) return
      set({ gateRuns, runsLoading: false })
    } catch {
      if (get().selectedContractId !== contractId) return
      set({ gateRuns: [], runsLoading: false })
    }
  },

  loadVersions: async (contractId) => {
    set({ versionsLoading: true })
    try {
      const versions = await contentContractsApi.listVersions(contractId)
      if (get().selectedContractId !== contractId) return
      set({ versions, versionsLoading: false })
    } catch {
      if (get().selectedContractId !== contractId) return
      set({ versions: [], versionsLoading: false })
    }
  },

  selectContract: async (id) => {
    if (!id) {
      set({ selectedContractId: null, gateRuns: [], versions: [] })
      return
    }
    set({ selectedContractId: id, gateRuns: [], versions: [] })
    // Evidência e changelog são as duas leituras da mesma seleção; em paralelo
    // porque uma não depende da outra.
    await Promise.all([get().loadGateRuns(id), get().loadVersions(id)])
  },

  startWatch: () => {
    // StrictMode monta o effect 2x; só uma assinatura real por canal.
    if (watchStarted) return
    watchStarted = true
    offUpdated = contentContractsApi.onUpdated(() => {
      void get().load()
      // Todo broadcast de contrato vem de um upsert, e upsert com diff real
      // grava uma linha nova de changelog — recarregar mantém o histórico
      // aberto em dia sem esperar nova seleção.
      const id = get().selectedContractId
      if (id) void get().loadVersions(id)
    })
    offGateRunUpdated = contentContractsApi.onGateRunUpdated(() => {
      // Um run novo pode ser de qualquer contrato; recarrega só o histórico do
      // que está aberto (a lista de contratos não muda por causa de um run).
      const id = get().selectedContractId
      if (id) void get().loadGateRuns(id)
    })
  },

  stopWatch: () => {
    if (offUpdated) {
      offUpdated()
      offUpdated = null
    }
    if (offGateRunUpdated) {
      offGateRunUpdated()
      offGateRunUpdated = null
    }
    watchStarted = false
  },
}))
