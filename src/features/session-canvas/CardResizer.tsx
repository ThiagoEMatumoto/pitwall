import { NodeResizeControl, useReactFlow, type ResizeParams } from '@xyflow/react'
import { CARD_RESIZE_LIMITS, pinUnsavedSiblings } from './graph-to-flow'
import { useCanvasStateStore } from './canvas-state-store'

// Alça do canto inferior direito de um cartão de sessão: redimensiona ao vivo (o
// cartão não tem PTY; só a moldura e o tail mudam) e grava w/h em
// canvas_positions ao soltar. Duplo clique volta ao tamanho padrão.
// Fica FORA da caixa do cartão (irmã dela no nó): a caixa tem overflow-hidden.
export function CardResizer({
  sessionId,
  mother,
  sized,
  onResizing,
}: {
  sessionId: string
  mother: boolean
  sized: boolean
  // O cartão preenche a vaga e para de medir a própria altura durante o gesto:
  // sem isto o 1º redimensionar (cartão ainda com altura do conteúdo) não segue o
  // ponteiro na vertical.
  onResizing: (on: boolean) => void
}) {
  const l = mother ? CARD_RESIZE_LIMITS.mother : CARD_RESIZE_LIMITS.card
  const flow = useReactFlow()
  const save = (p: { x: number; y: number }, w: number | null, h: number | null) => {
    const store = useCanvasStateStore.getState()
    const scope = store.canvas?.scope
    if (!scope) return
    const siblings = pinUnsavedSiblings(sessionId, flow.getNodes(), store.canvas?.positions ?? [])
    // Mesmos pisos do soltar de um arrasto: coordenada relativa negativa não faz o
    // contêiner crescer pra trás, e y < 30 entra no cabeçalho da raia.
    void store
      .savePositions(scope, [
        ...siblings,
        {
          kind: 'session',
          entityId: sessionId,
          x: Math.max(0, p.x),
          y: Math.max(30, p.y),
          w: w === null ? null : Math.round(w),
          h: h === null ? null : Math.round(h),
        },
      ])
      .catch((err) => console.error('[session-canvas] falha ao gravar o tamanho do cartão:', err))
  }
  const savedPos = () =>
    useCanvasStateStore
      .getState()
      .canvas?.positions.find((p) => p.kind === 'session' && p.entityId === sessionId)
  return (
    <NodeResizeControl
      position="bottom-right"
      minWidth={l.minW}
      minHeight={l.minH}
      maxWidth={l.maxW}
      maxHeight={l.maxH}
      className="session-card-resizer"
      // onResize, não onResizeStart: o start dispara no clique (inclusive no duplo
      // clique) e o end só vem se houve redimensionar, o que deixaria o gesto preso.
      onResize={() => onResizing(true)}
      onResizeEnd={(_e, p: ResizeParams) => {
        save(p, p.width, p.height)
        onResizing(false)
      }}
    >
      <div
        data-testid="card-resize"
        data-sized={sized ? 'true' : undefined}
        title="Arraste para redimensionar · duplo clique: tamanho padrão"
        onDoubleClick={(e) => {
          // Sem isto o duplo clique chegaria ao nó e abriria o terminal na modal.
          e.stopPropagation()
          const p = savedPos()
          if (p) save(p, null, null)
        }}
        className="flex h-full w-full items-end justify-end p-[3px] text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M9 1 L1 9 M9 5 L5 9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </NodeResizeControl>
  )
}
