import { create } from 'zustand'

// Quem é o dono do xterm de uma PTY quando há mais de um lugar querendo mostrá-la.
// Dois xterms na MESMA PTY brigam pelo sessionsApi.resize (o último a medir
// manda) e a TUI reflui. Enquanto a modal do mapa (ou a coluna da mãe fixada)
// segura a lease, a aba da mesma sessão desmonta o xterm e mostra "Aberto no
// mapa"; ao soltar, a aba remonta e o replay do backlog reconstrói a tela.
// 'dock' = a coluna "Fixar mãe" do mapa (MotherDock).
// A aba (Terminal sem leaseHost) é dona implícita: não tem lease própria.
export type TerminalLeaseHost = 'modal' | 'dock'

interface TerminalLeaseState {
  // O dono atual (o topo da pilha) de cada PTY: o que os Terminals leem.
  leases: Readonly<Record<string, TerminalLeaseHost>>
  // Pilha por PTY: a modal aberta sobre a coluna fixada fica por cima e, ao
  // fechar, a PTY volta à coluna — não à aba (que remontaria um xterm à toa).
  stacks: Readonly<Record<string, readonly TerminalLeaseHost[]>>
  acquire: (sessionId: string, host: TerminalLeaseHost) => void
  release: (sessionId: string, host: TerminalLeaseHost) => void
}

function withStack(
  s: Pick<TerminalLeaseState, 'leases' | 'stacks'>,
  sessionId: string,
  stack: readonly TerminalLeaseHost[],
): Pick<TerminalLeaseState, 'leases' | 'stacks'> {
  const { [sessionId]: _s, ...stacks } = s.stacks
  const { [sessionId]: _l, ...leases } = s.leases
  if (stack.length === 0) return { stacks, leases }
  return {
    stacks: { ...stacks, [sessionId]: stack },
    leases: { ...leases, [sessionId]: stack[stack.length - 1] },
  }
}

// Ordem fixa da pilha, de baixo para cima: a modal é o que o usuário acabou de
// abrir na frente de tudo, então fica por cima mesmo que a coluna adquira depois
// (o bastão move a coluna para a sessão que já está aberta na modal).
const HOST_ORDER: readonly TerminalLeaseHost[] = ['dock', 'modal']

export const useTerminalLease = create<TerminalLeaseState>((set, get) => ({
  leases: {},
  stacks: {},
  acquire: (sessionId, host) => {
    const stack = get().stacks[sessionId] ?? []
    if (stack.includes(host)) return
    const next = HOST_ORDER.filter((h) => h === host || stack.includes(h))
    set((s) => withStack(s, sessionId, next))
  },
  release: (sessionId, host) => {
    const stack = get().stacks[sessionId] ?? []
    if (!stack.includes(host)) return
    set((s) =>
      withStack(
        s,
        sessionId,
        stack.filter((h) => h !== host),
      ),
    )
  },
}))

// O Terminal montado em `self` (undefined = a aba) deve ceder a PTY?
export function leaseBlocks(
  owner: TerminalLeaseHost | undefined,
  self: TerminalLeaseHost | undefined,
): boolean {
  return owner !== undefined && owner !== self
}

// A MODAL do mapa está segurando alguma PTY? (a coluna fixada não conta: ela é
// permanente, e focar uma aba com ela fixada deve sair do mapa normalmente.)
export function hasActiveLease(): boolean {
  return Object.values(useTerminalLease.getState().stacks).some((s) => s.includes('modal'))
}
