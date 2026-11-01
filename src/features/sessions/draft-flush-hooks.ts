import { sessionsApi } from '@/lib/ipc'
import { flushAllDraftsSync } from './composer-draft-persister'

// Flush síncrono global dos rascunhos: no unload do renderer (reload, fechar a
// janela) e quando o main pede (before-quit, exit de sessão antes do sweep de
// imagens). O ack só sai depois de todas as gravações síncronas commitarem.
let installed = false

export function installDraftFlushHooks(): void {
  if (installed) return
  installed = true
  window.addEventListener('beforeunload', flushAllDraftsSync)
  sessionsApi.onDraftFlushRequest((requestId) => {
    flushAllDraftsSync()
    sessionsApi.draftFlushDone(requestId)
  })
}
