import { useEffect, useRef, useState } from 'react'
import { hudTop } from '@/features/session-switcher/hud-position'
import { statusDotView } from './status-view'
import { useSessionLinkHudStore } from './session-link-nav'

const VISIBLE_MS = 1200

function visibleBottom(el: Element | null): number | null {
  const r = el?.getBoundingClientRect()
  return r && r.height > 0 ? r.bottom : null
}

// Mesma medição do HUD da fila de atenção: abaixo das abas, ou fora do peek.
function measureTop(hud: HTMLElement | null): number {
  let tabsBottom: number | null = null
  for (const el of document.querySelectorAll('.dv-tabs-and-actions-container')) {
    const bottom = visibleBottom(el)
    if (bottom !== null && (tabsBottom === null || bottom < tabsBottom)) tabsBottom = bottom
  }
  const peek = document.querySelector<HTMLElement>('[data-peek-mode]')
  return hudTop({
    titlebarBottom: visibleBottom(document.querySelector('[data-titlebar]')) ?? 40,
    tabsBottom,
    peek:
      peek && peek.offsetHeight > 0
        ? { top: peek.offsetTop, bottom: peek.offsetTop + peek.offsetHeight }
        : null,
    viewportHeight: window.innerHeight,
    hudHeight: hud?.offsetHeight || 28,
  })
}

// Overlay do Alt+,/Alt+.: a cada passo pelas relações mostra onde você chegou (posição
// na linha mãe → irmãs → filhas, com o bastão ao lado da sessão) e do que ela
// trata. Não recebe foco nem clique.
export function SessionLinkHud() {
  const flash = useSessionLinkHudStore((s) => s.flash)
  const [hiddenNonce, setHiddenNonce] = useState<number | null>(null)
  const [top, setTop] = useState(56)
  const ref = useRef<HTMLDivElement>(null)
  const visible = flash != null && hiddenNonce !== flash.nonce

  useEffect(() => {
    if (!flash) return
    const measure = () => setTop(measureTop(ref.current))
    measure()
    let raf = requestAnimationFrame(() => {
      measure()
      raf = requestAnimationFrame(measure)
    })
    const timer = setTimeout(() => setHiddenNonce(flash.nonce), VISIBLE_MS)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
    }
  }, [flash])

  const node = flash?.node ?? null
  const dot = statusDotView(node?.status)
  const text = node
    ? [`${flash?.position}/${flash?.total}`, node.title, node.purposeHint]
        .filter(Boolean)
        .join(' · ')
    : 'Nenhuma sessão relacionada nessa direção'

  return (
    <div
      ref={ref}
      data-testid="session-link-hud"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-hidden={visible ? undefined : true}
      data-visible={visible}
      data-node={node?.sessionId ?? ''}
      className="pointer-events-none fixed left-1/2 z-[1100] flex max-w-[min(560px,80vw)] -translate-x-1/2 items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs shadow-lg transition-opacity duration-150 motion-reduce:transition-none"
      style={{
        top,
        opacity: visible ? 1 : 0,
        background: 'color-mix(in srgb, var(--color-surface-2) 92%, transparent)',
        borderColor: 'var(--color-border)',
        color: 'var(--color-text)',
      }}
    >
      {flash &&
        (node ? (
          <>
            <span aria-hidden className={`shrink-0 ${dot.className}`}>
              <span className="block h-1.5 w-1.5 rounded-full bg-current" />
            </span>
            <span className="truncate">{text}</span>
          </>
        ) : (
          <span className="text-[var(--color-text-dim)]">{text}</span>
        ))}
    </div>
  )
}
