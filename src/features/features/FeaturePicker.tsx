import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pin, Search } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { computeMenuPlacement, type MenuPlacement } from '@/components/ui/menu-placement'
import { selectPickableFeatures, type FeatureWithActivity } from './feature-activity'
import { isPinned } from './feature-pin'
import { STATUS_META } from './status'

interface Props {
  /** Fonte já carregada pelo consumidor (`list()` ou `listWithStats()`). */
  features: FeatureWithActivity[]
  /** Feature vinculada hoje; marca o item ativo. */
  value: string | null
  /** Escolha do usuário. `null` só chega quando `allowNone`. */
  onPick: (featureId: string | null) => void
  /** Fechar sem escolher (Esc / clique fora). */
  onClose: () => void
  /** Recorte por repo — o consumidor decide se faz sentido. */
  repoId?: string | null
  /** Oferece "— sem vínculo —" no topo. Default false. */
  allowNone?: boolean
  /** Borda de ancoragem no wrapper `relative` do consumidor. Default 'left'. */
  align?: 'left' | 'right'
  testId?: string
}

/** Teto de altura do painel (equivale ao antigo `max-h-72`). */
const MAX_PANEL_H = 288
/** Piso de largura (a largura fixa antiga, `w-72`): no header a âncora é um
 *  botão de ícone — casar a largura sem piso deixaria o painel ilegível. */
const MIN_PANEL_W = 288
/** Teto de largura: em tela larga um campo esticado não deve virar um painel
 *  gigante de itens curtos. */
const MAX_PANEL_W = 480

// Painel de escolha de feature: busca por título, em foco primeiro, o resto por
// atividade recente, arquivadas fora. Só o PAINEL — quem abre (campo do diálogo,
// chip do header) fica com o consumidor, que também controla o `open`.
//
// O painel vai pra document.body via portal com position:fixed, reusando o
// `computeMenuPlacement` do Menu: dentro do Dialog o corpo tem `overflow-y-auto`
// e um painel `absolute` era recortado a uma opção e meia. A âncora continua
// sendo o wrapper `relative` do consumidor, então o contrato (top-full, left/right)
// não muda pra quem já usa.
export function FeaturePicker({
  features,
  value,
  onPick,
  onClose,
  repoId = null,
  allowNone = false,
  align = 'left',
  testId = 'feature-picker',
}: Props) {
  const [query, setQuery] = useState('')
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const [width, setWidth] = useState(MIN_PANEL_W)

  // Mede o wrapper do consumidor e o conteúdo natural do painel para decidir
  // abrir pra baixo ou pra cima, com um max-height que cabe na viewport. Layout
  // effect (após o DOM, antes do paint) → sem flash na posição provisória.
  useLayoutEffect(() => {
    const anchor = anchorRef.current?.parentElement
    if (!anchor || !panelRef.current) return
    const rect = anchor.getBoundingClientRect()
    // Largura sai da mesma medição da âncora: o painel casa com o campo que o
    // abriu (senão parece um popup solto no meio do formulário). Entra também
    // no cálculo do placement — com `align: 'right'` o left depende dela.
    const w = Math.min(Math.max(rect.width, MIN_PANEL_W), MAX_PANEL_W)
    setWidth(w)
    setPlacement(
      computeMenuPlacement({
        rect,
        menuH: panelRef.current.scrollHeight,
        menuW: w,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        align,
      }),
    )
  }, [align])

  // Clique fora / Esc fecham. `mousedown` (e não `click`) porque o clique no
  // trigger do consumidor só chega depois — fechar aqui e reabrir lá viraria
  // um toggle invisível. O Esc para em capture com stopPropagation para não
  // vazar pro Dialog por baixo, que também fecha no Esc.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const listed = useMemo(
    () => selectPickableFeatures(features, { repoId, query }),
    [features, repoId, query],
  )

  const panel = (
    <div
      ref={panelRef}
      data-testid={testId}
      role="listbox"
      // z-[1001] fica acima do Dialog (z-[1000]) — o picker é o consumidor mais
      // aninhado, nunca o contrário.
      className="fixed z-[1001] flex flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg"
      // Antes da medida: posição provisória e invisível. `opacity` em vez de
      // `visibility` porque o autoFocus da busca não pega em elemento oculto.
      style={
        placement
          ? {
              left: placement.left,
              ...(placement.top != null ? { top: placement.top } : { bottom: placement.bottom }),
              width,
              maxHeight: Math.min(placement.maxHeight, MAX_PANEL_H),
            }
          : { left: 0, top: 0, width, opacity: 0, pointerEvents: 'none' }
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
        <Icon as={Search} size={12} className="shrink-0 text-[var(--color-text-dim)]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar frente…"
          aria-label="Buscar frente"
          data-testid={`${testId}-search`}
          className="w-full bg-transparent text-xs outline-none placeholder:text-[var(--color-text-dim)]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {allowNone && (
          <button
            type="button"
            role="option"
            aria-selected={value === null}
            data-testid={`${testId}-none`}
            onClick={() => onPick(null)}
            className="flex w-full items-center px-2.5 py-1.5 text-left text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            — sem vínculo —
          </button>
        )}
        {listed.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-dim)]">
            Nenhuma frente encontrada.
          </div>
        )}
        {listed.map((f) => {
          const meta = STATUS_META[f.status]
          const on = f.id === value
          return (
            <button
              key={f.id}
              type="button"
              role="option"
              aria-selected={on}
              data-feature-id={f.id}
              onClick={() => onPick(f.id)}
              title={`${f.title} — ${meta.label}`}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition hover:bg-[var(--color-surface-2)] ${
                on ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'
              }`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: meta.color }}
              />
              <span className="min-w-0 flex-1 truncate">{f.title}</span>
              {isPinned(f) && (
                <Icon
                  as={Pin}
                  size={10}
                  className="shrink-0 text-[var(--color-accent)]"
                  aria-label="em foco"
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <>
      {/* Marcador inerte: existe só para achar o wrapper `relative` que ancora o painel. */}
      <span ref={anchorRef} hidden aria-hidden="true" />
      {createPortal(panel, document.body)}
    </>
  )
}
