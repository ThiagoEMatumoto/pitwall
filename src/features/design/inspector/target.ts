// What the inspector edits: the selected nodes of one artboard plus a
// writer that fans a style patch out to every one of them.

import { useCallback, useMemo } from 'react'
import { getNodeIndex, useDesignStore, type CommitOptions } from '@/store/designStore'
import type { DesignNode, DesignOp } from '@shared/types/design'
import { getStyle, normalizePatch, type Style, type StylePatch } from './style-mapping'

export interface InspectorTarget {
  artboardId: string
  nodes: DesignNode[]
  // First node's style: the controls show it and multi-selection writes to all.
  style: Style
  // Parent of the first node is a flex container (sizing "fill" differs).
  inFlex: boolean
  applyStyle: (patch: StylePatch, opts?: CommitOptions) => void
  commit: (ops: DesignOp[], opts?: CommitOptions) => void
}

export function useInspectorTarget(): InspectorTarget | null {
  const selection = useDesignStore((s) => s.selection)
  const artboardId = selection.artboardId
  // Subscribing to the tree keeps nodes fresh after every commit.
  const tree = useDesignStore((s) => (artboardId ? s.artboards[artboardId]?.tree : undefined))
  const commitStore = useDesignStore((s) => s.commit)

  const nodes = useMemo(() => {
    if (!artboardId || !tree) return []
    const index = getNodeIndex(artboardId)
    return selection.nodeIds.map((id) => index?.get(id)?.node).filter((n): n is DesignNode => !!n)
  }, [artboardId, tree, selection.nodeIds])

  const inFlex = useMemo(() => {
    if (!artboardId || nodes.length === 0) return false
    const index = getNodeIndex(artboardId)
    const parentId = index?.get(nodes[0].id)?.parentId
    const parent = parentId ? index?.get(parentId)?.node : undefined
    const display = parent ? getStyle(parent.style, 'display') : undefined
    return display === 'flex' || display === 'inline-flex'
  }, [artboardId, nodes])

  const commit = useCallback(
    (ops: DesignOp[], opts?: CommitOptions) => {
      if (artboardId) commitStore(artboardId, ops, opts)
    },
    [artboardId, commitStore],
  )

  const applyStyle = useCallback(
    (patch: StylePatch, opts?: CommitOptions) => {
      commit(
        nodes.map((n) => ({ type: 'setStyle', id: n.id, patch: normalizePatch(n.style, patch) })),
        opts,
      )
    },
    [commit, nodes],
  )

  if (!artboardId || nodes.length === 0) return null
  return { artboardId, nodes, style: nodes[0].style, inFlex, applyStyle, commit }
}

// Colour tokens of the open document, for ColorField popovers.
export function useColorTokens(): Array<{ name: string; value: string }> {
  const color = useDesignStore((s) => s.doc?.tokens.color)
  return useMemo(() => Object.entries(color ?? {}).map(([name, value]) => ({ name, value })), [color])
}
