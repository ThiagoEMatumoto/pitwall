import { showToast } from '@/features/notifications/toast-store'
import { useDesignStore } from '@/store/designStore'

// The store toasts "Claude atualizou <artboard>" on every remote update
// (designStore.internal maybeToastRemoteUpdate, throttled per artboard).
// This one fires when the agent hands the board back; DesignArea wires it.

function viewAction(artboardId: string): {
  actionLabel: string
  onAction: () => void
} {
  return {
    actionLabel: 'Ver',
    onAction: () => {
      const s = useDesignStore.getState()
      s.select(artboardId, [])
      s.fitToArtboard(artboardId)
    },
  }
}

// 'finish' drops the artboard's activity entries from the store; the toast is
// raised on that transition so the human knows the agent handed the board back.
export function watchAgentFinish(): () => void {
  return useDesignStore.subscribe((s, prev) => {
    if (s.agentActivity === prev.agentActivity) return
    for (const key of Object.keys(prev.agentActivity)) {
      if (key === '*' || s.agentActivity[key] || (prev.agentActivity[key]?.length ?? 0) === 0)
        continue
      const name = s.artboards[key]?.meta.name ?? 'artboard'
      showToast({ title: `Claude terminou "${name}"`, ...viewAction(key) })
    }
  })
}
