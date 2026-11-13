// Acordar a filha concluída que dorme, pelo card: o main a relança com a
// identidade dela e sem kickoff (o trabalho foi entregue), e a aba abre na sessão
// que voltou. Quem acorda pela mãe (handoff_message) não passa por aqui: lá ela
// volta em segundo plano.
import { handoffsApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'

export async function wakeChildIntoTab(handoffId: string): Promise<void> {
  const { sessionId } = await handoffsApi.wakeChild(handoffId)
  await useAppStore.getState().refreshLiveSessions()
  const { liveSessions, focusOrOpenSession } = useAppStore.getState()
  const live = liveSessions.find((s) => s.id === sessionId)
  if (live) await focusOrOpenSession(live)
}
