// Full-screen prototype player. Mount once anywhere under the design area
// (no props): it renders only while designStore.mode === 'preview'.
// Navigation comes from [data-pw-link] clicks inside the artboard (runtime
// 'navigate'), the top-bar select, ←/→ (page order) and Backspace/← (history).

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, Play, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ControlPill } from '@/features/brand'
import { useDesignStore } from '@/store/designStore'
import type { DesignTransition } from '@shared/types/design'
import { PreviewFrame } from './PreviewFrame'
import {
  TRANSITION_DURATION_MS,
  canGoBack,
  createNavState,
  currentId,
  fitScale,
  frameStyle,
  previewNavReducer,
  siblingArtboard,
  type FramePhase,
  type ScaleMode,
  type Size,
} from './transitions'

const STAGE_PADDING = 24

export const PREVIEW_TESTIDS = {
  root: 'design-preview-root',
  close: 'design-preview-close',
  artboardSelect: 'design-preview-artboard-select',
} as const

export function PreviewMode() {
  const mode = useDesignStore((s) => s.mode)
  const startId = useDesignStore((s) => s.previewArtboardId)
  if (mode !== 'preview' || !startId) return null
  // Keyed so re-entering the preview starts a fresh history.
  return <PreviewOverlay key={startId} startId={startId} />
}

function isEditableTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function PreviewOverlay({ startId }: { startId: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [nav, dispatch] = useReducer(previewNavReducer, startId, createNavState)
  const [phase, setPhase] = useState<FramePhase>('start')
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fit')
  const [stageSize, setStageSize] = useState<Size>({ w: 0, h: 0 })
  const [mounted, setMounted] = useState<string[]>([startId])

  const artboards = useDesignStore((s) => s.artboards)
  const storeCurrent = useDesignStore((s) => s.previewArtboardId)
  const navigatePreview = useDesignStore((s) => s.navigatePreview)
  const exitPreview = useDesignStore((s) => s.exitPreview)

  const current = currentId(nav.history)
  const meta = artboards[current]?.meta
  const order = useMemo(() => {
    const pageId = meta?.pageId
    return Object.values(artboards)
      .map((a) => a.meta)
      .filter((m) => m.pageId === pageId)
      .sort((a, b) => a.position - b.position)
  }, [artboards, meta?.pageId])
  const orderIds = useMemo(() => order.map((m) => m.id), [order])

  const navigate = useCallback((to: string, transition: DesignTransition) => {
    if (!useDesignStore.getState().artboards[to]) return
    dispatch({ type: 'navigate', to, transition })
  }, [])

  // Local history is the source of truth; the store mirrors it so the
  // toolbar and the Ask Claude context see the artboard on screen. A store
  // change from outside (navigatePreview) jumps the local history instead.
  const currentRef = useRef(current)
  currentRef.current = current
  useEffect(() => {
    navigatePreview(current)
  }, [current, navigatePreview])
  useEffect(() => {
    if (storeCurrent && storeCurrent !== currentRef.current)
      dispatch({ type: 'jump', to: storeCurrent })
  }, [storeCurrent])

  useEffect(() => {
    setMounted((list) => (list.includes(current) ? list : [...list, current]))
  }, [current])

  // Deleted while previewing: fall back to the first artboard of the page.
  useEffect(() => {
    if (meta || !orderIds.length) return
    dispatch({ type: 'jump', to: orderIds[0] })
  }, [meta, orderIds])

  // start → (next frame) end → settle after the CSS transition finished.
  useEffect(() => {
    const t = nav.transition
    if (!t) return
    setPhase('start')
    const raf = requestAnimationFrame(() => setPhase('end'))
    const timer = setTimeout(
      () => dispatch({ type: 'settle' }),
      TRANSITION_DURATION_MS[t.kind] + 40,
    )
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [nav.transition])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setStageSize({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const goBack = useCallback(() => {
    if (canGoBack(nav.history)) dispatch({ type: 'back' })
  }, [nav.history])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isEditableTarget(e)) return
      switch (e.key) {
        case 'Escape':
          e.preventDefault()
          exitPreview()
          break
        case 'Backspace':
          e.preventDefault()
          goBack()
          break
        case 'ArrowLeft': {
          e.preventDefault()
          if (canGoBack(nav.history)) dispatch({ type: 'back' })
          else {
            const prev = siblingArtboard(orderIds, current, -1)
            if (prev) navigate(prev, 'none')
          }
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          const next = siblingArtboard(orderIds, current, 1)
          if (next) navigate(next, 'none')
          break
        }
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, orderIds, nav.history, navigate, goBack, exitPreview])

  // Keys pressed inside a frame are forwarded by the runtime (PreviewFrame
  // replays them on the window), so focus only needs to start here.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  if (!meta) return null

  const scale = fitScale({ w: meta.width, h: meta.height }, stageSize, scaleMode, STAGE_PADDING)
  const t = nav.transition
  const styleFor = (id: string): { style: CSSProperties; hidden: boolean } => {
    if (t && id === t.to) return { style: frameStyle(t, 'incoming', phase, scale), hidden: false }
    if (t && id === t.from) return { style: frameStyle(t, 'outgoing', phase, scale), hidden: false }
    if (id === current) return { style: { transform: `scale(${scale})` }, hidden: false }
    return { style: {}, hidden: true }
  }

  const selectClass =
    'h-7 appearance-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-2 pr-6 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]'

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid={PREVIEW_TESTIDS.root}
      className="fixed inset-0 z-[1000] flex flex-col outline-none"
      style={{ background: 'color-mix(in srgb, var(--color-bg) 75%, black)' }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[var(--color-text-dim)]">
        <button
          type="button"
          onClick={goBack}
          disabled={!canGoBack(nav.history)}
          title="Voltar (Backspace)"
          className="flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] disabled:opacity-40"
        >
          <Icon as={ChevronLeft} />
        </button>
        <ControlPill icon={Play} tone="accent" label="Preview" />
        <div className="relative">
          <select
            data-testid={PREVIEW_TESTIDS.artboardSelect}
            value={current}
            onChange={(e) => navigate(e.target.value, 'none')}
            className={selectClass}
            title="Artboard"
          >
            {order.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2">
            <Icon as={ChevronDown} size={12} />
          </span>
        </div>
        <span className="text-xs tabular-nums">
          {meta.width}×{meta.height}
        </span>

        <div className="flex-1" />

        <div className="flex items-center gap-0.5 text-xs">
          {(['fit', 'actual'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={scaleMode === m}
              onClick={() => setScaleMode(m)}
              className={`rounded-md px-2 py-1 transition hover:text-[var(--color-text)] ${
                scaleMode === m ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : ''
              }`}
            >
              {m === 'fit' ? 'Ajustar' : '100%'}
            </button>
          ))}
          <span className="ml-1 min-w-[3rem] text-right tabular-nums">
            {Math.round(scale * 100)}%
          </span>
        </div>
        <button
          type="button"
          data-testid={PREVIEW_TESTIDS.close}
          onClick={exitPreview}
          title="Sair do preview (Esc)"
          className="flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={X} />
        </button>
      </div>

      <div ref={stageRef} className="flex min-h-0 flex-1 overflow-auto">
        <div
          className="relative m-auto shrink-0 overflow-hidden"
          style={{
            width: meta.width * scale,
            height: meta.height * scale,
            boxShadow: '0 0 0 1px var(--color-border), 0 24px 64px rgba(0, 0, 0, 0.45)',
          }}
        >
          {mounted
            .filter((id) => artboards[id])
            .map((id) => {
              const { style, hidden } = styleFor(id)
              return (
                <PreviewFrame
                  key={id}
                  artboardId={id}
                  style={style}
                  hidden={hidden}
                  onNavigate={navigate}
                />
              )
            })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
