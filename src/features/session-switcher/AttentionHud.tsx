import { useEffect, useRef, useState } from 'react'
import type { AttentionItem, AttentionReason } from './attention-queue'
import { hudTop, type HudAnchors } from './hud-position'
import { useAttentionStore } from './useAttentionQueue'

const VISIBLE_MS = 1200
const FALLBACK_TOP = 56

const REASON_LABEL: Record<AttentionReason, string> = {
  'handoff-input': 'pergunta pendente',
  waiting: 'aguardando você',
  crew: 'equipe',
}

// Ponto de status no padrão do cartão do Maestri: vermelho = precisa de você,
// azul = ainda trabalhando (filha com pergunta aberta enquanto o PTY roda).
function dotColor(item: AttentionItem): string {
  return item.liveStatus === 'working' ? 'var(--color-info)' : 'var(--color-danger)'
}

function hudText(item: AttentionItem, position: number, total: number): string {
  const parts = [`${position}/${total}`, item.projectName, item.title, REASON_LABEL[item.reason]]
  return parts.filter(Boolean).join(' · ')
}

function visibleRect(el: Element | null): DOMRect | null {
  const r = el?.getBoundingClientRect()
  return r && r.height > 0 ? r : null
}

// Caixa de layout do painel do peek, sem o transform da animação de entrada
// (pw-rise): medido no meio dela, o topo ainda está deslocado e o HUD encostaria.
// O backdrop é fixed inset-0, então offsetTop já é relativo à janela.
function peekBox(): HudAnchors['peek'] {
  const el = document.querySelector<HTMLElement>('[data-peek-mode]')
  if (!el || el.offsetHeight === 0) return null
  return { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight }
}

function readAnchors(hud: HTMLElement | null): HudAnchors {
  const titlebar = visibleRect(document.querySelector('[data-titlebar]'))
  let tabsBottom: number | null = null
  let tabsTop = Infinity
  for (const el of document.querySelectorAll('.dv-tabs-and-actions-container')) {
    const r = visibleRect(el)
    if (r && r.top < tabsTop) {
      tabsTop = r.top
      tabsBottom = r.bottom
    }
  }
  return {
    titlebarBottom: titlebar?.bottom ?? 40,
    tabsBottom,
    peek: peekBox(),
    viewportHeight: window.innerHeight,
    hudHeight: hud?.offsetHeight || 28,
  }
}

// Overlay discreto do ciclo da fila de atenção (Alt+A / Alt+Shift+A): aparece a
// cada pulo por 1,2 s e some. Não recebe foco nem clique — o teclado continua na
// sessão que acabou de abrir. A live region existe desde o boot (vazia): leitor de
// tela não anuncia região que já nasce com texto.
export function AttentionHud() {
  const flash = useAttentionStore((s) => s.flash)
  const activeCc = useAttentionStore((s) => s.activeCc)
  // Visibilidade derivada no render (e não num setState pós-efeito): texto novo e
  // aria-hidden mudam no mesmo commit, senão o anúncio cairia na região escondida.
  const [hiddenNonce, setHiddenNonce] = useState<number | null>(null)
  const [top, setTop] = useState(FALLBACK_TOP)
  const ref = useRef<HTMLDivElement>(null)
  const visible = flash != null && hiddenNonce !== flash.nonce

  useEffect(() => {
    if (!flash) return
    // O peek da crew e a aba recém-focada montam alguns frames depois do pulo.
    const measure = () => setTop(hudTop(readAnchors(ref.current)))
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

  const item = flash?.item ?? null

  return (
    <div
      ref={ref}
      data-testid="attention-hud"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-hidden={visible ? undefined : true}
      data-visible={visible}
      data-item-kind={flash ? (item?.kind ?? 'none') : ''}
      data-active-cc={activeCc ?? ''}
      // z acima do peek (1000) para aparecer sobre o backdrop dele; os modais que
      // bloqueiam o Alt+A nunca coexistem com o HUD visível.
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
        (item ? (
          <>
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: dotColor(item) }}
            />
            <span className="truncate">{hudText(item, flash.position, flash.total)}</span>
          </>
        ) : (
          <span className="text-[var(--color-text-dim)]">Nada esperando</span>
        ))}
    </div>
  )
}
