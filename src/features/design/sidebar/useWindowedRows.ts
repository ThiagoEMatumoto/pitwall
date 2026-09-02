import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'

export interface WindowedRows {
  ref: (el: HTMLDivElement | null) => void
  onScroll: (e: UIEvent<HTMLDivElement>) => void
  start: number
  end: number
  topPad: number
  bottomPad: number
  scrollToRow: (index: number) => void
}

// Manual windowing: no virtualisation lib in the repo, and the rows are all
// the same height so a slice by scrollTop is enough.
export function useWindowedRows(count: number, rowHeight = 24, overscan = 10): WindowedRows {
  const el = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)

  const ref = useCallback((node: HTMLDivElement | null) => {
    el.current = node
    if (node) setHeight(node.clientHeight)
  }, [])

  useEffect(() => {
    const node = el.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setHeight(node.clientHeight))
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  const scrollToRow = useCallback(
    (index: number) => {
      const node = el.current
      if (!node) return
      const top = index * rowHeight
      const bottom = top + rowHeight
      if (top < node.scrollTop) node.scrollTop = top
      else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight
    },
    [rowHeight],
  )

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan)

  return {
    ref,
    onScroll,
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (count - end) * rowHeight),
    scrollToRow,
  }
}
