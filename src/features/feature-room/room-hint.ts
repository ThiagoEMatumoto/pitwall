// Dica única do Ctrl+` (v0.76 levou o combo para a Room; v0.78 para o painel da
// Room na visão de projeto — chave nova para a dica voltar uma vez). Preferência
// local do renderer, como o MRU do seletor.
const SEEN_KEY = 'cm:room-panel-hint-seen'

// shortcut: o combo de verdade (editável), "Ctrl+`" no padrão.
export const roomHintText = (shortcut: string) =>
  `${shortcut} agora foca a mãe da feature, com o painel da Room ao lado`

export function roomHintSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    // Sem storage não dá para lembrar: melhor não mostrar a cada abertura.
    return true
  }
}

export function markRoomHintSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Storage indisponível: a dica simplesmente volta na próxima sessão.
  }
}
