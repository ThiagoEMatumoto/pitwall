// O canvas muda de tamanho sem a janela mudar (a gaveta "Sessão" abre/fecha ao
// lado): o enquadramento da abertura ficava para a largura antiga e cortava nós.
// Reenquadra quando a área assenta num tamanho novo. A 1ª medida é a da abertura,
// que o enquadramento inicial já cobre.
export const REFRAME_DEBOUNCE_MS = 150

export interface CanvasSize {
  width: number
  height: number
}

export function observeCanvasResize(el: Element, onResize: (size: CanvasSize) => void): () => void {
  let last: CanvasSize | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const observer = new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1]?.contentRect
    if (!rect || rect.width === 0 || rect.height === 0) return
    const size = { width: rect.width, height: rect.height }
    if (!last) {
      last = size
      return
    }
    if (size.width === last.width && size.height === last.height) return
    last = size
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onResize(size)
    }, REFRAME_DEBOUNCE_MS)
  })
  observer.observe(el)
  return () => {
    if (timer) clearTimeout(timer)
    observer.disconnect()
  }
}
