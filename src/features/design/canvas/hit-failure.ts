// A hitTest that never answers (runtime busy, iframe mid-reload, the bridge's
// 2s timeout) used to be swallowed by a bare .catch: the click then resolved
// against an empty path and cleared the selection. That is the "phantom click"
// behind the intermittent selection. Callers bail out and report here instead.

import { showToast } from '@/features/notifications/toast-store'

// One toast per burst: a stuck runtime fails on every hover frame.
const QUIET_MS = 5000

let lastReportAt = 0

export function reportHitFailure(
  artboardId: string,
  action: string,
  error: unknown,
  now = Date.now(),
): void {
  if (lastReportAt && now - lastReportAt < QUIET_MS) return
  lastReportAt = now
  console.warn('[design] hit test failed', { artboardId, action, error: String(error) })
  showToast({
    title: 'O canvas não respondeu',
    body: 'A seleção foi mantida como estava. Tente de novo.',
  })
}

export function resetHitFailures(): void {
  lastReportAt = 0
}
