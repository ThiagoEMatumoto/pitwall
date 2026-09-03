// Full-screen prototype player. Mount once anywhere under the design area
// (no props): it renders only while designStore.mode === 'preview'.
// Navigation comes from [data-pw-link] clicks inside the artboard (runtime
// 'linkClick'), the top-bar select, ←/→ (page order) and Backspace/← (history).
// One PreviewPlayer iframe shows every screen; tall artboards scroll in the stage.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, Play, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ControlPill } from '@/features/brand'
import { useDesignStore } from '@/store/designStore'
import type { DesignArtboard, DesignEasing, DesignTransition } from '@shared/types/design'
import { PreviewPlayer, type PreviewPlayerHandle } from './PreviewPlayer'
import { fitScale, type ScaleMode, type Size } from './fit'
import {
  canGoBack,
  createNavState,
  currentId,
  previewNavReducer,
  siblingArtboard,
} from './transitions'

const STAGE_PADDING = 24
const SCALE_MODE_LABELS: Record<ScaleMode, string> = {
  fit: 'Ajustar à tela',
  actual: '100%',
}
const SCALE_MODE_TITLES: Record<ScaleMode, string> = {
  fit: 'Ajustar à tela: encaixa o artboard inteiro (ou a largura, quando é alto) no espaço disponível',
  actual: 'Tamanho real: 1 px do artboard = 1 px da tela',
}

export const PREVIEW_TESTIDS = {
  root: 'design-preview-root',
  close: 'design-preview-close',
  artboardSelect: 'design-preview-artboard-select',
  stage: 'design-preview-stage',
} as const

export function PreviewMode() {
  const mode = useDesignStore((s) => s.mode)
  const startId = useDesignStore((s) => s.previewArtboardId)
  if (mode !== 'preview' || !startId) return null
  // Not keyed by the artboard: navigating updates previewArtboardId, and a
  // remount here would replace the player mid-transition. Leaving the
  // preview unmounts the overlay, so re-entering still starts a fresh history.
  return <PreviewOverlay startId={startId} />
}

function isEditableTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function formatSize(meta: DesignArtboard): string {
  return meta.sizing === 'flow'
    ? `${meta.width}×fluxo (${meta.height})`
    : `${meta.width}×${meta.height}`
}

// Stage scroll in artboard css px: the iframe never scrolls itself, so the
// runtime resolves in-view entrances and parallax from these numbers.
function useStageScroll(
  stageRef: RefObject<HTMLDivElement>,
  playerRef: RefObject<PreviewPlayerHandle>,
  scale: number,
  current: string,
): void {
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let raf = 0
    const send = (): void => {
      raf = 0
      playerRef.current?.scroll({
        y: stage.scrollTop / scale,
        viewportH: stage.clientHeight / scale,
      })
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(send)
    }
    schedule()
    stage.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(stage)
    return () => {
      stage.removeEventListener('scroll', schedule)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [stageRef, playerRef, scale, current])
}

function PreviewOverlay({ startId }: { startId: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<PreviewPlayerHandle>(null)
  const [nav, dispatch] = useReducer(previewNavReducer, startId, createNavState)
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fit')
  const [stageSize, setStageSize] = useState<Size>({ w: 0, h: 0 })

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

  const navigate = useCallback(
    (to: string, transition: DesignTransition, duration?: number, easing?: DesignEasing) => {
      if (!useDesignStore.getState().artboards[to]) return
      dispatch({ type: 'navigate', to, transition, duration, easing })
    },
    [],
  )
  const settle = useCallback(() => dispatch({ type: 'settle' }), [])

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

  // Deleted while previewing: fall back to the first artboard of the page.
  useEffect(() => {
    if (meta || !orderIds.length) return
    dispatch({ type: 'jump', to: orderIds[0] })
  }, [meta, orderIds])

  // A new screen always starts at its top, like a page load.
  useEffect(() => {
    if (stageRef.current) stageRef.current.scrollTop = 0
  }, [current])

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

  // Keys pressed inside the frame are forwarded by the runtime (PreviewPlayer
  // replays them on the window), so focus only needs to start here.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const scale = meta
    ? fitScale({ w: meta.width, h: meta.height }, stageSize, scaleMode, STAGE_PADDING, meta.sizing)
    : 1
  useStageScroll(stageRef, playerRef, scale, current)

  if (!meta) return null

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
            title="Trocar de artboard"
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
        <span className="text-xs tabular-nums" title="Tamanho do artboard (px)">
          {formatSize(meta)}
        </span>

        <div className="flex-1" />

        <div className="flex items-center gap-0.5 text-xs">
          {(['fit', 'actual'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={scaleMode === m}
              title={SCALE_MODE_TITLES[m]}
              onClick={() => setScaleMode(m)}
              className={`rounded-md px-2 py-1 transition hover:text-[var(--color-text)] ${
                scaleMode === m ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : ''
              }`}
            >
              {SCALE_MODE_LABELS[m]}
            </button>
          ))}
          <span className="ml-1 min-w-[3rem] text-right tabular-nums" title="Zoom atual">
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

      <div
        ref={stageRef}
        data-testid={PREVIEW_TESTIDS.stage}
        className="min-h-0 flex-1 overflow-auto"
      >
        {/* Auto margins (not justify-content) so a tall player scrolls from its top. */}
        <div className="flex min-h-full" style={{ padding: STAGE_PADDING }}>
          <div className="m-auto">
            <PreviewPlayer
              ref={playerRef}
              artboardId={current}
              transition={nav.transition}
              scale={scale}
              onLinkClick={navigate}
              onSettled={settle}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
