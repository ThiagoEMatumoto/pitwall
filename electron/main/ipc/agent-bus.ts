import { ipcMain } from 'electron'
import { getDb } from '../services/db'
import { broadcast, onBroadcast } from '../services/notify'
import { AgentBus, peersFromGraph, setAgentBus } from '../services/agent-bus'
import { createSecretRedactor } from '../services/custom-env'
import { loadSessionGraph } from './session-graph'
import { promptQueue } from './send-prompt'
import type { AgentBusSnapshot } from '../../../shared/types/agent-bus'
import type { PromptQueueSnapshot } from '../../../shared/types/send-prompt'

// Liga o bus agente↔agente às peças vivas: sessões do grafo do mapa, a fila
// on-idle da P3 e o redator de segredos do env hub. As tools MCP pegam o bus por
// getAgentBus(); a aba Conversas e o mapa leem o snapshot por IPC.

// TTL sem ninguém olhando: o sweep também roda a cada ask/reply/check.
const SWEEP_MS = 30_000

let registered = false

export function registerAgentBusIpc(): void {
  if (registered) return
  registered = true
  const bus = new AgentBus({
    db: getDb(),
    peers: () => peersFromGraph(loadSessionGraph()),
    send: (input) => promptQueue.send(input),
    cancel: (id) => void promptQueue.cancel(id),
    emit: (snapshot: AgentBusSnapshot) => broadcast('agent-bus:updated', snapshot),
    warn: (event) => console.warn(JSON.stringify(event)),
    // Snapshot por chamada: um segredo cadastrado agora já sai redigido.
    redact: (text) => createSecretRedactor()(text),
  })
  setAgentBus(bus)
  onBroadcast('prompt-queue:updated', (_channel, payload) =>
    bus.onQueueEvent((payload as PromptQueueSnapshot).lastEvent),
  )
  setInterval(() => bus.sweep(), SWEEP_MS).unref()
  ipcMain.handle('agent-bus:list', (): AgentBusSnapshot => bus.snapshot())
}
