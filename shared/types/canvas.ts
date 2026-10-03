// Mapa de sessões como memória de trabalho: posições, notas e grupos do usuário.
// Tudo machine-local (fora do sync): o mapa descreve as sessões DESTA máquina.

// 'all' = mapa global; qualquer outro valor é um projects.id.
export type CanvasScope = string
export const GLOBAL_CANVAS_SCOPE = 'all'

// Repos NÃO entram aqui — seguem em repos.canvas_x/y (área Arquitetura).
export type CanvasEntityKind = 'session' | 'note' | 'group' | 'lane'

export interface CanvasPosition {
  scope: CanvasScope
  kind: CanvasEntityKind
  entityId: string
  x: number
  y: number
  w: number | null
  h: number | null
}

export interface CanvasNote {
  id: string
  scope: CanvasScope
  bodyMd: string
  attachedSessionId: string | null
  color: string | null
  createdAt: number
  updatedAt: number
}

export interface SessionGroup {
  id: string
  scope: CanvasScope
  name: string
  color: string | null
  createdAt: number
}

// Cartão de sessão no mapa: recolhido (só identidade e estado), aberto (saída ao
// vivo + prompt) ou terminal (o xterm real da sessão, no lugar do cartão).
export type CardViewState = 'collapsed' | 'open' | 'terminal'

export interface CanvasCardView {
  sessionId: string
  viewState: CardViewState
}

export type CanvasViewStateInput = CanvasCardView

// Tamanho que o usuário deu a um cartão cuja posição foi esquecida (trocou de
// feature): x/y são relativos à lane, o tamanho não.
export interface CanvasCardSize {
  sessionId: string
  w: number
  h: number
}

export interface CanvasState {
  scope: CanvasScope
  positions: CanvasPosition[]
  // Só os cartões que o usuário mudou; ausente = 'open'.
  views: CanvasCardView[]
  sizes: CanvasCardSize[]
  notes: CanvasNote[]
  groups: SessionGroup[]
}

export interface CanvasPositionInput {
  kind: CanvasEntityKind
  entityId: string
  x: number
  y: number
  w?: number | null
  h?: number | null
}

export interface CreateCanvasNoteInput {
  scope: CanvasScope
  bodyMd: string
  attachedSessionId?: string | null
  color?: string | null
}

export interface UpdateCanvasNoteInput {
  id: string
  bodyMd?: string
  attachedSessionId?: string | null
  color?: string | null
}

export interface CreateSessionGroupInput {
  scope: CanvasScope
  name: string
  color?: string | null
}

export interface UpdateSessionGroupInput {
  id: string
  name?: string
  color?: string | null
}

export type SummarizeSessionResult =
  { ok: true; summary: string; at: number } | { ok: false; error: string }

// Payload de 'canvas:updated'. scope null = mudança que vale pra todo escopo
// (propósito, grupo de uma sessão, resumo).
export interface CanvasUpdatedEvent {
  scope: CanvasScope | null
}
