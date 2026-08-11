import type { SessionActivity } from '../../../shared/types/ipc'

// Estado do botão "Interromper" do composer. O controle existia desde o modelo
// Warp, mas sem estado: aparecia igual com a sessão parada e com o claude no
// meio de uma tool, e não dava retorno nenhum depois do clique. Um controle que
// não comunica seu estado é, na prática, um controle que ninguém encontra.
//
//  'armed'     — o claude está trabalhando: há o que interromper AGORA (destaque).
//  'available' — estado incerto (waiting/starting/desconhecido): habilitado, mas
//                discreto. FAIL-OPEN de propósito — cancelar é ação de emergência,
//                então na dúvida o botão funciona em vez de bloquear o usuário.
//  'idle'      — sabidamente ocioso/encerrado: nada a interromper, desabilitado.
//  'sent'      — Ctrl+C já foi para a PTY, aguardando a sessão reagir.
export type InterruptState = 'armed' | 'available' | 'idle' | 'sent'

export function interruptState(input: {
  status: SessionActivity['status'] | undefined
  sent: boolean
}): InterruptState {
  if (input.sent) return 'sent'
  if (input.status === 'working') return 'armed'
  if (input.status === 'idle' || input.status === 'ended') return 'idle'
  return 'available'
}

export function interruptEnabled(state: InterruptState): boolean {
  return state === 'armed' || state === 'available'
}

export function interruptLabel(state: InterruptState): string {
  return state === 'sent' ? 'Interrompendo…' : 'Interromper'
}

export function interruptTitle(state: InterruptState): string {
  switch (state) {
    case 'armed':
      return 'Interromper o que o claude está fazendo agora — envia Ctrl+C ao PTY.'
    case 'available':
      return 'Enviar Ctrl+C ao PTY (cancela o que estiver em andamento ou o prompt aberto).'
    case 'idle':
      return 'Nada em andamento para interromper.'
    case 'sent':
      return 'Ctrl+C enviado — aguardando a sessão reagir.'
  }
}
