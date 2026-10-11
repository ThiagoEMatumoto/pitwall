// Se o usuário está numa aba, por paneId: a resposta do renderer ao pane-check
// da hibernação. Nada disso passa pelo PTY (o Composer só escreve no envio), então
// o main não tem como ver sozinho. Escritores: o Composer (conteúdo e foco) e o
// AppShell (aba ativa do dockview).

const withContent = new Set<string>()
let focusedComposer: string | null = null
let activePane: string | null = null

// Texto ou anexo no rascunho. Fica depois do desmonte: o rascunho segue no app.db.
export function noteComposerContent(paneId: string, hasContent: boolean): void {
  if (hasContent) withContent.add(paneId)
  else withContent.delete(paneId)
}

export function noteComposerFocus(paneId: string, focused: boolean): void {
  if (focused) focusedComposer = paneId
  else if (focusedComposer === paneId) focusedComposer = null
}

export function noteActivePane(paneId: string | null): void {
  activePane = paneId
}

export interface PaneActivity {
  // Aba ativa numa janela com foco.
  focused: boolean
  composerHasText: boolean
  composerFocused: boolean
}

export function paneActivity(paneId: string): PaneActivity {
  return {
    focused: activePane === paneId && document.hasFocus(),
    composerHasText: withContent.has(paneId),
    composerFocused: focusedComposer === paneId,
  }
}
