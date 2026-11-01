// Critério ÚNICO de "esta conversa é filha deste handoff", usado pela hierarquia
// de exibição (session-graph) e pela régua de vínculo (getByChildConversation →
// childLink/relink/detach). Se os dois divergem, a árvore mostra como filha uma
// sessão que o botão não consegue desvincular.
//
// Filha = a linha apontada por child_session_id OU outra linha com o mesmo
// cc_session_id (o resume abre linha nova por processo). A antecessora do bastão
// NÃO entra: ela passou o papel à sucessora, e o handoff aponta pra sucessora —
// casá-la aqui faria o relink/detach dela agir sobre o vínculo da sucessora.
//
// Exige `JOIN/LEFT JOIN sessions cs ON cs.id = h.child_session_id` na query e
// recebe DOIS parâmetros, ambos o mesmo JSON array de sessions.id.
export const CHILD_CONVERSATION_MATCH = `(h.child_session_id IN (SELECT value FROM json_each(?))
  OR (cs.cc_session_id IS NOT NULL
      AND cs.cc_session_id IN (SELECT cc_session_id FROM sessions
                                WHERE id IN (SELECT value FROM json_each(?))
                                  AND cc_session_id IS NOT NULL)))`

export function childConversationParams(sessionIds: readonly string[]): [string, string] {
  const json = JSON.stringify(sessionIds)
  return [json, json]
}
