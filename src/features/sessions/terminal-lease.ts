import { create } from 'zustand'

// Quem é o dono do xterm de uma PTY quando há mais de um lugar querendo mostrá-la.
// Dois xterms na MESMA PTY brigam pelo sessionsApi.resize (o último a medir
// manda) e a TUI reflui. Enquanto a modal do mapa segura a lease, a aba da mesma
// sessão desmonta o xterm e mostra "Aberto no mapa"; ao soltar, a aba remonta e
// o replay do backlog reconstrói a tela (e refaz o fit).
export type TerminalLeaseHost = 'modal'

interface TerminalLeaseState {
  leases: Readonly<Record<string, TerminalLeaseHost>>
  acquire: (sessionId: string, host: TerminalLeaseHost) => void
  release: (sessionId: string, host: TerminalLeaseHost) => void
}

export const useTerminalLease = create<TerminalLeaseState>((set, get) => ({
  leases: {},
  acquire: (sessionId, host) => {
    if (get().leases[sessionId] === host) return
    set((s) => ({ leases: { ...s.leases, [sessionId]: host } }))
  },
  release: (sessionId, host) => {
    if (get().leases[sessionId] !== host) return
    set((s) => {
      const { [sessionId]: _released, ...rest } = s.leases
      return { leases: rest }
    })
  },
}))

// O Terminal montado em `self` (undefined = a aba) deve ceder a PTY?
export function leaseBlocks(
  owner: TerminalLeaseHost | undefined,
  self: TerminalLeaseHost | undefined,
): boolean {
  return owner !== undefined && owner !== self
}

export function hasActiveLease(): boolean {
  return Object.keys(useTerminalLease.getState().leases).length > 0
}
