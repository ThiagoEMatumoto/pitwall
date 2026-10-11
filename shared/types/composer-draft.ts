// Rascunho do Composer persistido no app.db (migration 060). A chave identifica a
// pane, não a PTY: 'pane:<paneId>' ou 'cc:<ccSessionId>' (terminal sem pane).
export interface ComposerDraftAttachment {
  name: string
  // Caminho absoluto da imagem colada (<userData>/tmp/img-*). O sweep de órfãos
  // não apaga arquivo referenciado por um rascunho.
  path: string
}

export interface ComposerDraftInput {
  key: string
  ccSessionId: string | null
  paneId: string | null
  text: string
  attachments: ComposerDraftAttachment[]
}

export interface ComposerDraft extends ComposerDraftInput {
  updatedAt: number
}
