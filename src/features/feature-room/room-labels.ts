import type { ProducedAttentionKind } from '../../../shared/types/attention'
import type { RoomTimelineEvent } from '../../../shared/types/feature-room'
import type { ExecState } from './room-model'

// Só os kinds com produtor: um kind F1+ sem rótulo não tem como chegar à tela.
export const KIND_LABEL: Record<ProducedAttentionKind, string> = {
  child_question: 'Pergunta da filha',
  session_menu: 'Menu na tela',
  child_failed: 'Filha falhou',
  child_interrupted: 'Filha interrompida',
  pty_orphan: 'Terminal órfão',
  result_unconsumed: 'Resultado não lido',
}

const EVENT_VERB: Record<string, string> = {
  create: 'foi delegada',
  approve: 'aprovada',
  markRunning: 'começou',
  ask: 'perguntou',
  resume: 'retomou',
  report: 'concluiu (report)',
  consume: 'mãe leu o resultado',
  fail: 'falhou',
  interrupt: 'interrompida',
  reconcileStuck: 'interrompida (PID morto)',
  dismiss: 'dispensada',
  release: 'solta do painel',
  mother_transferred: 'bastão passado',
  child_direct_message: 'mandou mensagem à mãe',
}

// Ruído e rejeições: escritos pelo store, mas não contam a história da feature.
export const HIDDEN_TIMELINE_EVENTS: ReadonlySet<string> = new Set([
  'feedback',
  'undismiss',
  'reportDuplicate',
  'report_rejected',
  'fail_rejected',
  'reconcileFailedChild',
  'reject',
])

const PROGRESS_DETAIL_MAX = 80

export function timelineVerb(e: Pick<RoomTimelineEvent, 'event' | 'detail'>): string {
  if (e.event === 'progress') {
    const detail = (e.detail ?? '').trim()
    if (!detail) return 'progresso'
    const clipped =
      detail.length > PROGRESS_DETAIL_MAX ? `${detail.slice(0, PROGRESS_DETAIL_MAX - 1)}…` : detail
    return `progresso: ${clipped}`
  }
  return EVENT_VERB[e.event] ?? e.event
}

export const EXEC_LABEL: Record<ExecState, string> = {
  starting: 'iniciando',
  working: 'trabalhando',
  waiting: 'esperando',
  idle: 'ociosa',
  ended: 'encerrada',
  gone: 'sem sessão',
}

// Igual ao rel() do protótipo C.
export function relTime(t: number, now: number): string {
  const m = Math.round((now - t) / 60000)
  if (m < 1) return 'agora'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
}

// Título do item aberto: quem + o que aconteceu (o whyNow da projeção vem embaixo).
export const ITEM_TITLE: Record<ProducedAttentionKind, (who: string) => string> = {
  child_question: (who) => `${who} perguntou`,
  session_menu: (who) => `${who} parou num menu`,
  child_failed: (who) => `${who} falhou`,
  child_interrupted: (who) => `${who} foi interrompida`,
  pty_orphan: (who) => `${who}: terminal sem sessão`,
  result_unconsumed: (who) => `${who} entregou um resultado que ninguém leu`,
}

// Forma + cor dos glifos (protótipo C): forma diz o tipo, cor vem dos tons do app.
export type GlyphShape = 'needs' | 'run' | 'ok' | 'warn' | 'stop' | 'dim'

const EVENT_GLYPH: Record<string, GlyphShape> = {
  ask: 'needs',
  create: 'run',
  approve: 'run',
  markRunning: 'run',
  progress: 'run',
  resume: 'run',
  child_direct_message: 'run',
  mother_transferred: 'run',
  report: 'ok',
  consume: 'ok',
  fail: 'warn',
  interrupt: 'stop',
  reconcileStuck: 'stop',
}

export function eventGlyph(event: string): GlyphShape {
  return EVENT_GLYPH[event] ?? 'dim'
}
