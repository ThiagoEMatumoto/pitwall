import { featuresApi } from '@/lib/ipc'

// Escrita do foco. Fica FORA de feature-pin.ts (que é puro e entra na lista,
// no card e na parede) porque tocar '@/lib/ipc' obriga todo consumidor a mockar
// window.api — mesma separação de feature-sessions-api.ts.
//
// Dois nomes possíveis porque o backend da Fase 4 ainda está escolhendo entre
// o par pin/unpin e um `setFocus` com patch parcial (o serviço já existe como
// setFocus). A UI aceita os dois e some com o extra quando o canal firmar.
interface PinChannel {
  pin?: (id: string) => Promise<unknown>
  unpin?: (id: string) => Promise<unknown>
  setFocus?: (input: { featureId: string; pinned: boolean }) => Promise<unknown>
}

// `false` = o canal ainda não existe nesta build. Quem chama avisa o usuário em
// vez de deixar o botão mudo (silêncio é o pior resultado possível aqui).
export async function setFeaturePinned(id: string, pinned: boolean): Promise<boolean> {
  const channel = featuresApi as unknown as PinChannel
  const toggle = pinned ? channel.pin : channel.unpin
  if (typeof toggle === 'function') {
    await toggle.call(channel, id)
    return true
  }
  if (typeof channel.setFocus === 'function') {
    await channel.setFocus.call(channel, { featureId: id, pinned })
    return true
  }
  return false
}
