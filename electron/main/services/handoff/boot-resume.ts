// Filhas em voo quando o app fechou: o sweep do getDb as marca 'interrupted' (a
// PTY morreu junto) e a lazy restore só sobe de volta quem tinha aba. A filha que
// rodava sem aba (no Crew Dock) ficava "interrompida" embora estivesse viva antes
// do restart. Aqui ela volta pelo mesmo resumeHandoffChild do relink (sem kickoff,
// como a retomada da aba): viva, ligada à mãe e retomável.
import * as store from '../handoff-store'

type ResumeChild = (handoffId: string, opts: { origin: 'main' }) => unknown

export function resumeSweptChildren(sweptIds: readonly string[], resume: ResumeChild): string[] {
  const resumed: string[] = []
  for (const id of sweptIds) {
    const h = store.get(id)
    if (!h || h.status !== 'interrupted' || h.dismissedAt != null || !h.resumable) continue
    try {
      resume(id, { origin: 'main' })
      resumed.push(id)
    } catch (err) {
      console.warn(
        JSON.stringify({ event: 'boot_child_resume_failed', handoffId: id, error: String(err) }),
      )
    }
  }
  return resumed
}
