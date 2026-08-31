import { featuresApi } from '@/lib/ipc'

// Escrita do foco. Separada de feature-pin.ts (puro) porque importar
// '@/lib/ipc' obriga todo consumidor do módulo a mockar window.api.
//
// `false` = a chamada falhou; quem chama avisa o usuário em vez de deixar o
// botão mudo (silêncio é o pior resultado possível num gesto de estado).
export async function setFeaturePinned(id: string, pinned: boolean): Promise<boolean> {
  try {
    await featuresApi.setFocus({ featureId: id, pinned })
    return true
  } catch {
    return false
  }
}

/** "Não é duplicata": some com o aviso sem tocar em mais nada. */
export async function dismissDuplicate(id: string): Promise<boolean> {
  try {
    await featuresApi.dismissDuplicate(id)
    return true
  } catch {
    return false
  }
}
