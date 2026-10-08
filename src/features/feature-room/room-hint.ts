// Dica única do Ctrl+` (v0.76 mudou o destino do combo para a Room). Preferência
// local do renderer, como o MRU do seletor.
const SEEN_KEY = 'cm:room-hint-seen'

// shortcut: o combo de verdade (editável), "Ctrl+`" no padrão.
export const roomHintText = (shortcut: string) => `${shortcut} agora abre a Room da feature`

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
