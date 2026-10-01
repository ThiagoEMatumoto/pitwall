// Ao sair do mapa o foco ficava no contêiner do mapa (que acabou de desmontar) e
// o usuário precisava clicar no terminal pra digitar. Devolve o foco ao xterm do
// painel ativo — o mesmo textarea que o xterm usa pra receber teclas. Em modo
// chat o xterm fica invisível sob o ChatView e não deve roubar o foco.
export function focusActiveTerminal(panelElement: HTMLElement | null | undefined): boolean {
  const textarea = panelElement?.querySelector<HTMLTextAreaElement>(
    'textarea.xterm-helper-textarea',
  )
  if (!textarea || textarea.closest('.invisible')) return false
  textarea.focus({ preventScroll: true })
  return document.activeElement === textarea
}
