import type { CSSProperties, ReactNode } from 'react'
import { TONE_COLOR } from '@/features/session-canvas/card-indicator'
import type { HandoffStatus } from '../../../shared/types/ipc'
import type { GlyphShape } from './room-labels'
import type { ExecState, RoomSessionRow } from './room-model'

const GLYPH_COLOR: Record<GlyphShape, string> = {
  needs: TONE_COLOR['needs-you'],
  run: TONE_COLOR.working,
  ok: TONE_COLOR.done,
  warn: 'var(--color-danger)',
  stop: TONE_COLOR.interrupted,
  dim: TONE_COLOR.ended,
}

// Forma + cor: dá para ler sem depender só da cor.
export function Glyph({ shape }: { shape: GlyphShape }) {
  const color = GLYPH_COLOR[shape]
  const base = 'relative inline-block h-3 w-3 shrink-0'
  if (shape === 'ok')
    return (
      <span
        aria-hidden
        className={`${base} text-center text-[12px] font-bold leading-3`}
        style={{ color }}
      >
        ✓
      </span>
    )
  const inner: Record<Exclude<GlyphShape, 'ok'>, CSSProperties> = {
    needs: { inset: 2, background: color, transform: 'rotate(45deg)', borderRadius: 1 },
    run: { inset: 2, background: color, borderRadius: '50%' },
    warn: { inset: 1, background: color, clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' },
    stop: { inset: 2.5, background: color, borderRadius: 1 },
    dim: { inset: 2, border: `1.5px solid ${color}`, borderRadius: '50%' },
  }
  return (
    <span aria-hidden className={base}>
      <span className="absolute" style={inner[shape]} />
    </span>
  )
}

const WORK_GLYPH: Record<HandoffStatus, GlyphShape> = {
  needs_input: 'needs',
  pending: 'run',
  approved: 'run',
  running: 'run',
  done: 'ok',
  failed: 'warn',
  interrupted: 'stop',
  rejected: 'dim',
}

export function rowGlyph(row: RoomSessionRow): GlyphShape {
  if (row.work) return WORK_GLYPH[row.work.status]
  return row.exec === 'working' || row.exec === 'starting' ? 'run' : 'dim'
}

const EXEC_COLOR: Record<ExecState, string> = {
  starting: TONE_COLOR.starting,
  working: TONE_COLOR.working,
  waiting: TONE_COLOR['needs-you'],
  idle: TONE_COLOR.ended,
  ended: TONE_COLOR.ended,
  gone: TONE_COLOR.ended,
}

// Ponto da execução da PTY: indicador separado do status do trabalho (handoff).
export function ExecDot({ exec }: { exec: ExecState }) {
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: EXEC_COLOR[exec] }}
    />
  )
}

export function SectionHead({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="mb-2.5 flex items-baseline gap-2.5">
      <h2
        id={id}
        className="m-0 text-[13px] font-semibold uppercase tracking-[0.04em] text-[var(--color-text-dim)]"
      >
        {title}
      </h2>
      {children}
    </div>
  )
}

// Botão compacto da Room: o Button do rebrand em tamanho de linha.
export const COMPACT = '!px-3 !py-1 text-xs'

// Foco visível em todo controle da Room (o app não tem regra global de :focus-visible).
export const ROOM_FOCUS =
  '[&_*:focus-visible]:outline-2 [&_*:focus-visible]:outline-offset-2 [&_*:focus-visible]:outline-[var(--color-accent)] [&_*:focus-visible]:[outline-style:solid]'
