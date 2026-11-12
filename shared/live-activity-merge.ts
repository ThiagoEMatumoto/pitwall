import type { GlobalActivityBatch, LiveSessionInfo } from './types/ipc'

type Tokens = LiveSessionInfo['tokens']

const sameTokens = (a: Tokens, b: Tokens): boolean =>
  a?.output === b?.output && a?.context === b?.context

// Só os campos que o merge escreve: o resto do objeto vem intacto do spread.
const sameActivity = (a: LiveSessionInfo, b: LiveSessionInfo): boolean =>
  a.status === b.status &&
  a.lastActivityAt === b.lastActivityAt &&
  a.lastText === b.lastText &&
  a.attentionReason === b.attentionReason &&
  sameTokens(a.tokens, b.tokens)

// Merge incremental por ccSessionId: atualiza só entradas existentes, ignora ids
// desconhecidos (o snapshot/refetch é quem adiciona/remove). Sessão sem mudança
// volta o mesmo objeto e batch sem mudança volta o mesmo array: o batch chega a
// cada tick do watch global e cada referência nova re-renderiza quem assina a lista.
export function mergeGlobalActivity(
  list: LiveSessionInfo[],
  batch: GlobalActivityBatch,
): LiveSessionInfo[] {
  const byId = new Map(batch.map((b) => [b.ccSessionId, b]))
  const next = list.map((sess) => {
    const u = byId.get(sess.ccSessionId)
    if (!u) return sess
    const merged: LiveSessionInfo = {
      ...sess,
      status: u.status,
      lastActivityAt: u.lastActivityAt,
      lastText: u.lastText !== undefined ? u.lastText : sess.lastText,
      tokens: u.tokens ?? sess.tokens,
      // Substitui (não herda): ausente no batch = motivo limpo.
      attentionReason: u.attentionReason,
    }
    return sameActivity(sess, merged) ? sess : merged
  })
  return next.some((sess, i) => sess !== list[i]) ? next : list
}
