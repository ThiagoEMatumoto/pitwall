// "Bolinha de informação" no mapa: uma sessão mandou algo para outra. Não é estado
// (nada persiste): é um evento efêmero que o mapa anima no fio entre os dois cartões.
// Ids são sessions.id (o mesmo do nó `s:<id>` do mapa).

// 'progress' = passo intermediário (handoff_progress); 'report' = a entrega final.
export type SessionLinkPulseKind =
  | 'task'
  | 'message'
  | 'progress'
  | 'report'
  | 'question'
  | 'answer'
  | 'ask'
  | 'reply'
  | 'note'

export interface SessionLinkPulse {
  id: string
  fromSessionId: string
  toSessionId: string
  kind: SessionLinkPulseKind
  // Legenda curta pt-BR ("mãe → otavio: mensagem"), para tooltip/aria-live.
  label?: string
  at: number
}
