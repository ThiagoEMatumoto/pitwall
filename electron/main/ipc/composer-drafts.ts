import { ipcMain } from 'electron'
import { getDb } from '../services/db'
import {
  clearComposerDraft,
  getComposerDraft,
  parseComposerDraftInput,
  saveComposerDraft,
} from '../services/composer-drafts'
import { createDraftFlushCoordinator, DRAFT_FLUSH_TIMEOUT_MS } from '../services/draft-flush'

// IPC do rascunho durável do Composer. Janelas que usam a API ficam registradas
// no coordenador: o main pede a elas o flush síncrono antes do quit (index.ts) e
// antes do sweep de imagens no exit de uma sessão (sessions.ts).
const draftFlush = createDraftFlushCoordinator()

export function requestDraftFlush(timeoutMs: number = DRAFT_FLUSH_TIMEOUT_MS): Promise<boolean> {
  return draftFlush.request(timeoutMs)
}

function parseDraftKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0) throw new Error('chave de rascunho inválida')
  return key
}

// Erro volta no returnValue: um throw num handler de sendSync deixaria o
// renderer sem resposta.
function syncResult<T>(run: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: run() }
  } catch (err) {
    console.error('[composer] rascunho (síncrono) falhou:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerComposerDraftIpc(): void {
  ipcMain.handle('sessions:get-draft', (e, key: unknown) => {
    draftFlush.remember(e.sender)
    return getComposerDraft(getDb(), parseDraftKey(key))
  })

  ipcMain.handle('sessions:save-draft', (e, raw: unknown) => {
    draftFlush.remember(e.sender)
    saveComposerDraft(getDb(), parseComposerDraftInput(raw))
  })

  ipcMain.handle('sessions:clear-draft', (_e, key: unknown) => {
    clearComposerDraft(getDb(), parseDraftKey(key))
  })

  // Versões síncronas (ipcRenderer.sendSync) do flush: o renderer só segue
  // depois do commit.
  ipcMain.on('sessions:get-draft-sync', (e, key: unknown) => {
    draftFlush.remember(e.sender)
    e.returnValue = syncResult(() => getComposerDraft(getDb(), parseDraftKey(key)))
  })

  ipcMain.on('sessions:save-draft-sync', (e, raw: unknown) => {
    draftFlush.remember(e.sender)
    e.returnValue = syncResult(() => saveComposerDraft(getDb(), parseComposerDraftInput(raw)))
  })

  ipcMain.on('composer:flush-done', (e, requestId: unknown) => {
    if (typeof requestId === 'string') draftFlush.ack(requestId, e.sender.id)
  })
}
