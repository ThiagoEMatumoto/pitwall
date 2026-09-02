// Parent ⇄ runtime messaging. The iframe has an opaque origin, so '*' is the
// only target the parent can be addressed by; the parent filters on source.

import type { RuntimeToParentMessage } from '../../../shared/design/protocol'

export const PROTOCOL_VERSION = 1

export function post(msg: RuntimeToParentMessage): void {
  window.parent.postMessage(msg, '*')
}
