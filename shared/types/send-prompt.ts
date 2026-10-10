// Mandar um prompt para qualquer sessão viva sem abri-la. 'now' escreve já (o
// claude enfileira se estiver trabalhando); 'on-idle' espera o fim do turno e só
// entrega com a tela sem menu — um \r com menu aberto aprovaria uma permissão.

export type SendPromptWhen = 'now' | 'on-idle'

export interface SendPromptInput {
  // sessions.id (a PTY), o mesmo de LiveSessionInfo.id.
  sessionId: string
  text: string
  when: SendPromptWhen
  // Sessão de onde a mensagem saiu (o @alias digitado no composer de outra aba).
  // Só serve para a bolinha no fio do mapa, que sai quando a entrega acontece.
  fromSessionId?: string
  // Só o main process liga (answer-delivery): a resposta a um pedido é o que a
  // filha em needs_input espera, então passa pelo gate 'attention'. O IPC do
  // renderer não aceita o campo (o schema zod o descarta).
  bypassAttention?: boolean
}

export type SendPromptError =
  | 'not-running'
  // Menu (permissão/pergunta/trust) na tela: o \r do envio responderia ele.
  | 'menu-open'
  // Sem espelho da tela desta PTY: não dá pra provar que não há menu, então
  // 'quando terminar' não é oferecido. Em 'now', também quando a sessão espera você
  // ou quando o status é só o da PTY (Codex), que nunca diz 'waiting'.
  | 'no-screen'
  // Filha de handoff com pergunta pendente: responde pelo canal do handoff.
  | 'attention'
  // Tela sem menu reconhecido e sem a caixa de input ociosa: pode ser um menu que
  // o parser não conhece, e o \r responderia ele.
  | 'unparsed'
  // A caixa de input do destino tem texto que o usuário digitou e não enviou: o
  // \r mandaria o rascunho dele junto (ou no lugar) da mensagem.
  | 'input-dirty'
  // Cancelada da fila enquanto o próprio envio ainda relia a tela.
  | 'cancelled'
  // O destino dormia (lazy restore) e não acordou; detail diz por quê.
  | 'wake-failed'

export type SendPromptResult =
  | { ok: true; delivered: true }
  | { ok: true; delivered: false; queued: QueuedPrompt }
  | { ok: false; error: SendPromptError; detail?: string }

export interface QueuedPrompt {
  id: string
  sessionId: string
  text: string
  createdAt: number
  expiresAt: number
  // Quantas vezes a entrega foi segurada porque havia menu na tela.
  heldByMenu: number
  // Por que a entrega está segurada agora (null = só esperando o fim do turno).
  heldReason: 'menu-open' | 'unparsed' | 'input-dirty' | null
}

export type PromptQueueEventKind = 'delivered' | 'expired' | 'session-gone' | 'cancelled'

export interface PromptQueueEvent {
  kind: PromptQueueEventKind
  id: string
  sessionId: string
  text: string
  at: number
}

export interface PromptQueueCounters {
  delivered: number
  // TTL estourado ainda na fila.
  expired: number
  // A sessão morreu com a mensagem na fila.
  sessionGone: number
  // Entregas recusadas/seguradas por menu aberto (inclui 'now' recusado).
  refusedMenuOpen: number
  // Entregas recusadas/seguradas por tela não reconhecida (sem input ocioso).
  refusedUnparsed: number
  // Entregas recusadas/seguradas por texto não enviado na caixa de input do destino.
  refusedInputDirty: number
  // Envios para uma sessão dormindo cujo wake falhou (nada foi escrito).
  wakeFailed: number
}

export interface PromptQueueSnapshot {
  items: QueuedPrompt[]
  counters: PromptQueueCounters
  // Último evento terminal (entregue/expirado/morta/cancelada) — o renderer avisa.
  lastEvent: PromptQueueEvent | null
}

export interface ScreenPreview {
  // Últimas linhas não vazias da tela espelhada, sem ANSI.
  lines: string[]
  hasMenu: boolean
  // Rascunho do usuário na caixa de input do destino (não o placeholder).
  inputDirty: boolean
}

// Saída ao vivo do cartão aberto no mapa: fim da tela espelhada, com cor.
// fg: número = índice da paleta ANSI (0-255); string = '#rrggbb'; ausente = padrão.
export interface ScreenTailSegment {
  t: string
  fg?: number | string
  b?: true
  d?: true
}

export type ScreenTailLine = ScreenTailSegment[]

export interface ScreenTailUpdate {
  sessionId: string
  lines: ScreenTailLine[]
  hasMenu: boolean
  inputDirty: boolean
}

export interface RepoFilesResult {
  files: string[]
  truncated: boolean
  source: 'git' | 'readdir' | 'none'
}
