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
  // durable: false = o app.db recusou a gravação: o item está só em memória (um kill
  // o perde) e só é entregue depois que gravar (persistFailed conta).
  | { ok: true; delivered: false; queued: QueuedPrompt; durable?: false }
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
  // Só em item que sobreviveu a um kill/reboot do app:
  // 'awaiting-session' = espera a conversa ter PTY viva de novo (resume/wake);
  // 'maybe-undelivered' = o app morreu no meio da entrega e o transcript não
  // provou nem que entrou nem que não entrou. Não sai sozinho: o usuário reenvia
  // (prompt-queue:resend) ou cancela.
  // 'needs-confirmation' = velho demais para sair sozinho (STALE_RESTORE_MS), ou o
  // wake da conversa falhou: espera Enviar/Descartar do usuário.
  // Nenhum dos três expira.
  recovery?: 'awaiting-session' | 'maybe-undelivered' | 'needs-confirmation'
  // 'awaiting-session' que passou de AWAITING_NOTICE_MS sem a conversa voltar:
  // o renderer mostra (enviar quando ela voltar / descartar).
  waitingNotice?: true
}

// 'maybe-undelivered' não é terminal: o item segue no snapshot, marcado.
export type PromptQueueEventKind =
  'delivered' | 'expired' | 'session-gone' | 'cancelled' | 'maybe-undelivered'

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
  // Itens carregados do app.db no boot (sobreviveram a kill/reboot).
  restored: number
  // Dos restaurados em 'delivering', os que o transcript provou entregues.
  restoredDelivered: number
  // Restaurados em 'delivering' sem prova: marcados para o usuário decidir.
  maybeUndelivered: number
  // Gravações no app.db que falharam (o item seguiu só em memória).
  persistFailed?: number
  // Restaurados que passaram a pedir confirmação antes de sair (velhos ou sem wake).
  needsConfirmation: number
  // Envelopes de handoff restaurados descartados porque os handoffs já terminaram.
  discardedObsolete: number
  // Restaurados que passaram a aparecer por esperar a conversa voltar.
  awaitingNoticed: number
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
