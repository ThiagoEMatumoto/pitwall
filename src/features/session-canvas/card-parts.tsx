import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { Handle, Position } from '@xyflow/react'
import { LoaderCircle } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useAppStore } from '@/store/appStore'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { useCardHeightStore } from './card-height-store'
import {
  TONE_COLOR,
  indicatorFor,
  indicatorText,
  type CardIndicator,
  type IndicatorTone,
} from './card-indicator'
import { useCardViewStore } from './card-view-store'
import { tailText } from './card-tail'
import { useMapLive } from './map-live'

// Peças comuns ao cartão de sessão e à variante da mãe (MotherCard).

// Tons que nunca esmaecem no modo foco.
export const ACTIVE_TONES: ReadonlySet<IndicatorTone> = new Set([
  'working',
  'needs-you',
  'starting',
])

// O indicador do cartão: status do grafo + motivo da tela + relógio de working +
// a marca de interrupção no fim da tela (só quando o cartão está aberto).
export function useIndicator(n: SessionGraphNode): CardIndicator {
  const live = useAppStore((s) => s.liveSessions.find((x) => x.id === n.sessionId))
  const tail = useCardViewStore((s) => s.tails[n.sessionId])
  const { workingSince } = useMapLive()
  const tailLines = useMemo(() => (tail ? tailText(tail.lines) : null), [tail])
  return indicatorFor(n, live, workingSince.get(n.sessionId) ?? null, tailLines)
}

export function StatusPill({ ind }: { ind: CardIndicator }) {
  const { now } = useMapLive()
  const color = TONE_COLOR[ind.tone]
  const busy = ind.tone === 'working' || ind.tone === 'starting'
  return (
    <span
      data-testid="card-status"
      data-tone={ind.tone}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium leading-4"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} ${ind.tone === 'ended' ? 6 : 14}%, transparent)`,
      }}
    >
      {busy ? (
        <Icon as={LoaderCircle} size={11} className="session-card-spin" />
      ) : (
        <span
          className={`h-1.5 w-1.5 rounded-full ${ind.tone === 'needs-you' ? 'pw-pulse' : ''}`}
          style={{ background: color }}
        />
      )}
      {indicatorText(ind, now)}
    </span>
  )
}

// Um ponto no meio de cada borda: o fio entra/sai pelo da borda voltada pro
// outro nó (SessionEdge encaixa a ponta nele). Só o da direita é de arrastar
// (delegar); os outros são só âncoras e nunca aparecem: com o hover viravam
// pontinhos soltos na borda do cartão em que o ponteiro tinha parado.
export const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const

export function BorderHandles() {
  return (
    <>
      {SIDES.map((side) => (
        <Handle
          key={side}
          id={`in-${side}`}
          type="target"
          position={side}
          isConnectable={false}
          className="!h-1.5 !w-1.5 !border-0 !bg-transparent opacity-0"
        />
      ))}
    </>
  )
}

// Borda e brilho por estado: quem precisa de você pulsa em vermelho (o mesmo
// token do HUD de atenção), quem trabalha fica azul, quem terminou, verde.
export function frameStyle(tone: IndicatorTone, selected: boolean): CSSProperties {
  const color = TONE_COLOR[tone]
  const strong = tone === 'needs-you'
  const quiet = tone === 'ended' || tone === 'starting'
  return {
    borderColor: quiet
      ? 'var(--color-border)'
      : `color-mix(in srgb, ${color} ${strong ? 80 : 45}%, transparent)`,
    borderWidth: strong ? 2 : 1,
    boxShadow: quiet
      ? undefined
      : `0 0 0 1px color-mix(in srgb, ${color} 18%, transparent), 0 0 14px -4px ${color}`,
    ...(selected ? { outline: '2px dashed var(--color-accent)', outlineOffset: 3 } : {}),
  }
}

// Reporta a altura desenhada do cartão aberto pro layout (card-height-store).
// Só no detalhe 'full': no 'brief'/'blocks' (zoom baixo) o cartão encolhe, e
// medir ali re-arrumaria o mapa a cada zoom.
export function useReportCardHeight(sessionId: string, enabled: boolean) {
  const observer = useRef<ResizeObserver | null>(null)
  useEffect(() => () => observer.current?.disconnect(), [])
  return useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      if (!el || !enabled || typeof ResizeObserver === 'undefined') return
      const report = () => useCardHeightStore.getState().report(sessionId, el.offsetHeight)
      observer.current = new ResizeObserver(report)
      observer.current.observe(el)
      report()
    },
    [sessionId, enabled],
  )
}
