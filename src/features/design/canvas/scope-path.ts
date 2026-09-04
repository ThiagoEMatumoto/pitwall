// The scope (the container clicks select inside of) is invisible state that
// survives clicks: without a breadcrumb the same gesture starts landing one
// level deeper with nothing on screen saying why. These are the pure bits the
// breadcrumb and the store's `select` share.

// Root → node, from the artboard's node index.
export function nodePath(nodeId: string, parentOf: (id: string) => string | null): string[] {
  const path = [nodeId]
  let cur = parentOf(nodeId)
  while (cur) {
    path.unshift(cur)
    cur = parentOf(cur)
  }
  return path
}

// Clicking a crumb enters it: the node becomes the selection and its parent
// the scope. The root crumb is the artboard itself, which carries no scope.
export function crumbTarget(
  path: readonly string[],
  index: number,
): { nodeId: string | null; scopeId: string | null } {
  if (index <= 0) return { nodeId: null, scopeId: null }
  return { nodeId: path[index], scopeId: index === 1 ? null : path[index - 1] }
}

// A selection outside the scope means the user left it; keeping it would make
// the next click land deeper than the outline promises.
export function scopeAfterSelect(
  scopeId: string | null,
  nodeIds: readonly string[],
  ancestorsOf: (id: string) => readonly string[],
): string | null {
  if (!scopeId || nodeIds.length === 0) return scopeId
  return nodeIds.every((id) => ancestorsOf(id).includes(scopeId)) ? scopeId : null
}
