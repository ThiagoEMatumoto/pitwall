import { ipcMain } from 'electron'
import * as contentStore from '../services/content-contract-store'
import { runAndRecordGate } from '../services/content-gate-run'
import { broadcast } from '../services/notify'
import type {
  ContentContract,
  ContentContractListFilter,
  ContentContractVersion,
  ContentGateRun,
  ContentGateRunListFilter,
  RunContentGateInput,
  UpsertContentContractInput,
} from '../../../shared/types/ipc'

// IPC do Content Contract (Fase 3). Molde de ipc/scheduled-jobs: handlers finos
// (a regra mora no store e no seam de gate) e broadcast em cada mutação pro
// renderer recarregar. Os canais 'contentContract:*' e 'contentGateRun:*' não são
// entidades sincronizadas cross-machine — seguem o precedente de dossiers/jobs.
//
// A UI desta feature é READ-ONLY por decisão: edição do contrato acontece pelo
// MCP, onde está quem produz o conteúdo. `upsert` existe aqui pela simetria da
// bridge, não porque a UI vá usá-lo agora.
export function registerContentContractsIpc(): void {
  ipcMain.handle(
    'contentContracts:list',
    (_e, filter?: ContentContractListFilter): ContentContract[] => {
      return contentStore.list(filter)
    },
  )

  ipcMain.handle('contentContracts:get', (_e, id: string): ContentContract | null => {
    return contentStore.get(id)
  })

  ipcMain.handle(
    'contentContracts:upsert',
    (_e, input: UpsertContentContractInput): ContentContract => {
      const existing = contentStore.getBySlug(input.slug)
      const contract = existing
        ? contentStore.update({ ...input, id: existing.id })
        : contentStore.create({
            ...input,
            // Contrato novo sem os dois obrigatórios é erro de quem chama; o
            // CHECK do banco rejeita rótulo vazio de qualquer forma.
            title: input.title ?? '',
            outputLabel: input.outputLabel ?? '',
          })
      broadcast('contentContract:updated', contract)
      return contract
    },
  )

  // O changelog só muda junto com um bump, e o bump já broadcasta
  // 'contentContract:updated' — emitir sinal aqui duplicaria a recarga. Leitura
  // pura, portanto.
  ipcMain.handle(
    'contentContracts:list-versions',
    (_e, contractId: string): ContentContractVersion[] => {
      return contentStore.listVersions(contractId)
    },
  )

  ipcMain.handle(
    'contentContracts:list-gate-runs',
    (_e, filter?: ContentGateRunListFilter): ContentGateRun[] => {
      return contentStore.listGateRuns(filter)
    },
  )

  // Reprovar NÃO lança: o run gravado com status 'failed' é o resultado, e é ele
  // que a UI mostra com a evidência literal. Só sobe exceção quando não há
  // contrato contra o que rodar — aí não existe run pra gravar.
  ipcMain.handle('contentContracts:run-gate', (_e, input: RunContentGateInput): ContentGateRun => {
    const { run } = runAndRecordGate(input)
    broadcast('contentGateRun:updated', run)
    return run
  })
}
