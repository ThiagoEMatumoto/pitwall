// Broadcast de mutações pro renderer — fonte única usada pela camada IPC e
// pelo MCP server. Antes vivia triplicado em ipc/{objectives,tasks,features}.ts;
// centralizar aqui garante que writes externos (MCP) atualizem a UI ao vivo
// pelos MESMOS canais que o IPC usa.
import { BrowserWindow } from 'electron'
import * as taskStore from './task-store'
import type { FeatureObjectiveLink, TaskLink } from '../../../shared/types/ipc'

export type Broadcast = (channel: string, payload: unknown) => void

// Ping de mutação para o coordinator de sync (auto-sync on-idle). Injetável via
// setSyncMutationHook para evitar dependência circular (ipc/sync importa este
// módulo? não — mas o coordinator vive no main e é wired no boot). Default no-op
// até o boot registrar o hook real (notifySyncMutation do ipc/sync).
let syncMutationHook: () => void = () => {}

export function setSyncMutationHook(fn: () => void): void {
  syncMutationHook = fn
}

// Ping direto para handlers que NÃO passam por broadcast (ex: projects/repos,
// que não broadcastam mutação). Mesmo destino que o ping embutido em broadcast().
export function pingSyncMutation(): void {
  syncMutationHook()
}

// Canais cujos payloads correspondem a entidades SINCRONIZADAS (objectives,
// tasks, features). Só esses pingam o coordinator — broadcasts de session/
// metrics/window etc. não devem disparar push.
function isSyncedChannel(channel: string): boolean {
  return (
    channel.startsWith('objective:') ||
    channel.startsWith('task:') ||
    channel.startsWith('feature:')
  )
}

// O main não tem event bus: quem precisa reagir a uma mutação dentro do próprio
// main (ex.: o grafo de sessões) escuta aqui os MESMOS canais que o renderer
// recebe, sem que cada produtor tenha que saber quem depende dele.
type BroadcastListener = (channel: string, payload: unknown) => void
const listeners = new Set<{ prefix: string; fn: BroadcastListener }>()

export function onBroadcast(channelPrefix: string, fn: BroadcastListener): () => void {
  const entry = { prefix: channelPrefix, fn }
  listeners.add(entry)
  return () => {
    listeners.delete(entry)
  }
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
  if (isSyncedChannel(channel)) syncMutationHook()
  for (const { prefix, fn } of listeners) {
    if (!channel.startsWith(prefix)) continue
    // Um ouvinte com defeito não pode fazer a mutação que já aconteceu parecer
    // ter falhado pra quem chamou broadcast.
    try {
      fn(channel, payload)
    } catch (err) {
      console.error(`[notify] ouvinte de ${prefix} falhou:`, err)
    }
  }
}

// Mutações de tarefa que tocam parents objective/key_result mudam o progresso
// calculado desses objetivos → além de 'task:updated', emite 'objective:updated'
// com { id } por objetivo afetado (mesmo canal que o IPC de objectives usa,
// então a UI de objetivos recarrega sem listener novo).
export function broadcastAffectedObjectives(links: TaskLink[], send: Broadcast = broadcast): void {
  for (const id of taskStore.affectedObjectiveIds(links)) {
    send('objective:updated', { id })
  }
}

// Mudar os vínculos feature→objetivo/KR muda o progresso calculado dos
// objetivos envolvidos → emite 'objective:updated' com { id } por objetivo
// afetado (mesmo canal/contrato do IPC de tasks). FeatureObjectiveLink tem o
// mesmo shape semântico de TaskLink (target ∈ objective|key_result), então a
// resolução KR→objetivo é reusada de task-store.affectedObjectiveIds.
export function broadcastAffectedObjectivesForFeatureLinks(
  links: FeatureObjectiveLink[],
  send: Broadcast = broadcast,
): void {
  const asTaskLinks = links.map((l) => ({ parentType: l.targetType, parentId: l.targetId }))
  broadcastAffectedObjectives(asTaskLinks, send)
}
