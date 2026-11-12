import type { BacklogReply } from '../../shared/types/ipc'

interface BacklogIpc {
  on(channel: string, listener: (event: unknown, reply: BacklogReply) => void): unknown
  send(channel: string, requestId: string, sessionId: string): void
}

// Pedido e resposta por evento, não por invoke: a resposta de um invoke
// ultrapassava os pty:data já enfileirados quando o renderer estava atrasado, e o
// replay do Terminal escrevia esses bytes duas vezes. Por evento ela chega na
// mesma fila ordenada dos pty:data.
export function createBacklogRequests(ipc: BacklogIpc) {
  const pending = new Map<
    string,
    { resolve: (backlog: string) => void; reject: (err: Error) => void }
  >()
  // O main responde ao webContents, não à página: uma resposta de antes de um
  // reload chega no preload novo. Um contador sozinho recomeça em 1 a cada carga
  // e casaria com um pedido pendente da página nova.
  const loadId = crypto.randomUUID()
  let nextId = 1

  ipc.on('sessions:backlog', (_e, reply) => {
    const waiter = pending.get(reply.requestId)
    if (!waiter) return
    pending.delete(reply.requestId)
    if ('error' in reply) waiter.reject(new Error(reply.error))
    else waiter.resolve(reply.backlog)
  })

  return {
    get(sessionId: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const requestId = `${loadId}:${nextId++}`
        pending.set(requestId, { resolve, reject })
        ipc.send('sessions:get-backlog', requestId, sessionId)
      })
    },
    pendingCount: (): number => pending.size,
  }
}
