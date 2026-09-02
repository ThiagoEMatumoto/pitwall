// Computed style of the inspected node, read from the artboard iframe. The
// controls show it as placeholder/swatch when the node has no inline value;
// editing always writes inline (applyStyle), so the model never absorbs it.

import { useEffect, useState } from 'react'
import { getBridge, useDesignStore } from '@/store/designStore'

export type ComputedStyle = Record<string, string>

const EMPTY: ComputedStyle = {}

export function useComputedStyle(
  artboardId: string,
  nodeId: string,
  props: readonly string[],
): ComputedStyle {
  // Any tree or token change may move the computed value (inherited styles).
  const tree = useDesignStore((s) => s.artboards[artboardId]?.tree)
  const tokens = useDesignStore((s) => s.doc?.tokens)
  const [values, setValues] = useState<ComputedStyle>(EMPTY)
  const key = props.join(',')

  useEffect(() => {
    let cancelled = false
    const bridge = getBridge(artboardId)
    if (!bridge) {
      setValues(EMPTY)
      return
    }
    bridge.getComputed(nodeId, key.split(',')).then(
      (next) => {
        if (!cancelled) setValues(next)
      },
      () => {
        if (!cancelled) setValues(EMPTY)
      },
    )
    return () => {
      cancelled = true
    }
  }, [artboardId, nodeId, key, tree, tokens])

  return values
}
