// A resposta do backlog chega na mesma fila ordenada dos pty:data, e o main
// esvazia o coalescer antes de tirar o snapshot (sessions:get-backlog): todo
// pty:data anterior à resposta já está dentro dela. Reaproveitar a cauda pelo
// comprimento (live.slice(backlog.length)) repetia bytes quando o backlog vinha
// cortado pelo BACKLOG_CAP: cortado, o tamanho dele não diz quanto do live cobre.
export type ReplayState =
  { readonly replied: false; readonly held: string } | { readonly replied: true }

export type ReplayEvent =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'backlog'; readonly backlog: string }
  | { readonly kind: 'backlog-failed' }

export interface ReplayStep {
  readonly state: ReplayState
  readonly write: string
}

export const REPLAY_PENDING: ReplayState = { replied: false, held: '' }

// `write` é o que vai para o xterm por causa deste evento; vazio = nada.
export function replayStep(state: ReplayState, event: ReplayEvent): ReplayStep {
  if (event.kind === 'data') {
    if (state.replied) return { state, write: event.data }
    return { state: { replied: false, held: state.held + event.data }, write: '' }
  }
  if (event.kind === 'backlog') return { state: { replied: true }, write: event.backlog }
  // Sem backlog não há o que cubra o live segurado: ele é tudo que resta da tela.
  return { state: { replied: true }, write: state.replied ? '' : state.held }
}
