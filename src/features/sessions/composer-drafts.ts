// Rascunho do Composer por sessão (texto + anexos), em memória — princípio "nunca
// perder input". Sobrevive ao remount do dock (toggle de aba, reopen de pane)
// enquanto o app vive; não persiste em disco.
//
// A chave é o sessions.id, que muda quando a sessão hiberna (dormant:<cc>) e de
// novo no wake (id novo). Quem troca o id da pane leva o rascunho junto
// (takeComposerDraft/putComposerDraft): ele não passa pelo PTY, então nem o
// lastIoAt nem a guarda input-dirty o enxergam.

// Anexo serializável ({name, path}): o object URL do preview é efêmero e fica no
// Composer; restaurado, o chip aparece com ícone.
export interface ComposerAttachment {
  name: string
  path: string
}

export interface ComposerDraft {
  text: string
  attachments: ComposerAttachment[]
}

export const drafts = new Map<string, string>()
export const attachmentsBySession = new Map<string, ComposerAttachment[]>()

// Tira o rascunho da sessão (null se vazio).
export function takeComposerDraft(sessionId: string): ComposerDraft | null {
  const text = drafts.get(sessionId) ?? ''
  const attachments = attachmentsBySession.get(sessionId) ?? []
  drafts.delete(sessionId)
  attachmentsBySession.delete(sessionId)
  if (!text && attachments.length === 0) return null
  return { text, attachments }
}

export function putComposerDraft(sessionId: string, draft: ComposerDraft): void {
  if (draft.text) drafts.set(sessionId, draft.text)
  if (draft.attachments.length > 0) attachmentsBySession.set(sessionId, draft.attachments)
}
